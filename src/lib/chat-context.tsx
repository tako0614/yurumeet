import {
  createContext,
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import {
  type CommunityMessage,
  deleteCommunityMessage,
  type DMContact,
  type DMMessage,
  fetchCommunityMessages,
  fetchDMContacts,
  fetchUserDMMessages,
  fetchUserDMTyping,
  markCommunityAsRead,
  markDMAsRead,
  sendCommunityMessage,
  sendUserDMMessage,
  sendUserDMTyping,
} from "@takosjp/yurucommu-api";
import { useApp } from "./app-context.tsx";

export type ChatMessage = DMMessage | CommunityMessage;

const POLL_MS = 4000;
const TYPING_THROTTLE_MS = 2500;

async function loadContacts(): Promise<DMContact[]> {
  const data = await fetchDMContacts();
  return [...data.mutual_followers, ...data.communities].sort((a, b) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
  );
}

async function loadMessages(contact: DMContact): Promise<ChatMessage[]> {
  if (contact.type === "community") {
    return (await fetchCommunityMessages(contact.ap_id)).messages;
  }
  return (await fetchUserDMMessages(contact.ap_id)).messages;
}

/**
 * Merge freshly polled messages into the existing list without flicker: keep
 * any local-only messages (optimistic sends not yet indexed by the server) and
 * return the SAME array reference when nothing changed, so the scroll effect
 * does not re-fire on every poll.
 */
function mergeById(
  existing: ChatMessage[],
  fetched: ChatMessage[],
): ChatMessage[] {
  const fetchedIds = new Set(fetched.map((m) => m.id));
  const pending = existing.filter((m) => !fetchedIds.has(m.id));
  const merged = pending.length > 0 ? [...fetched, ...pending] : fetched;
  if (
    merged.length === existing.length &&
    merged.every((m, i) => m.id === existing[i].id)
  ) {
    return existing;
  }
  return merged;
}

function isWideViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(min-width: 769px)").matches
  );
}

export type ChatContextValue = {
  contacts: Accessor<DMContact[]>;
  contactsLoading: Accessor<boolean>;
  selected: Accessor<DMContact | null>;
  selectContact: (contact: DMContact | null) => void;
  messages: Accessor<ChatMessage[]>;
  messagesLoading: Accessor<boolean>;
  send: (content: string) => Promise<boolean>;
  /** Delete a message. Only community messages are deletable (no DM delete API). */
  deleteMessage: (messageId: string) => Promise<boolean>;
  refetchContacts: () => void;
  isTyping: Accessor<boolean>;
  notifyTyping: () => void;
};

const ChatContext = createContext<ChatContextValue>();

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("[yurume] useChat must be used within <ChatProvider>");
  }
  return ctx;
}

let tempSeq = 0;

export function ChatProvider(props: { children: JSX.Element }) {
  const app = useApp();
  const [contactsResource, { refetch: refetchContacts }] = createResource(
    app.origin,
    loadContacts,
  );
  const [selected, setSelected] = createSignal<DMContact | null>(null);
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = createSignal(false);
  const [isTyping, setIsTyping] = createSignal(false);
  const [didAutoSelect, setDidAutoSelect] = createSignal(false);

  const contacts = () => contactsResource() ?? [];

  const markRead = (contact: DMContact) => {
    void (async () => {
      try {
        if (contact.type === "community") {
          await markCommunityAsRead(contact.ap_id);
        } else {
          await markDMAsRead(contact.ap_id);
        }
        void refetchContacts();
        app.refreshBadges();
      } catch {
        /* best-effort */
      }
    })();
  };

  // Load messages + mark read whenever the open conversation changes.
  createEffect(
    on(selected, async (contact) => {
      setIsTyping(false);
      if (!contact) {
        setMessages([]);
        return;
      }
      setMessagesLoading(true);
      try {
        setMessages(await loadMessages(contact));
      } finally {
        setMessagesLoading(false);
      }
      markRead(contact);
    }),
  );

  // While a conversation is open, poll for incoming messages (and typing).
  createEffect(
    on(selected, (contact) => {
      if (!contact) return;
      const timer = window.setInterval(() => {
        if (
          typeof document !== "undefined" &&
          document.visibilityState !== "visible"
        ) {
          return;
        }
        void (async () => {
          try {
            const fresh = await loadMessages(contact);
            setMessages((prev) => mergeById(prev, fresh));
            if (contact.type === "user") {
              const typing = await fetchUserDMTyping(contact.ap_id);
              setIsTyping(!!typing.is_typing);
            }
          } catch {
            /* transient */
          }
        })();
      }, POLL_MS);
      onCleanup(() => window.clearInterval(timer));
    }),
  );

  let lastTypingSent = 0;
  const notifyTyping = () => {
    const contact = selected();
    if (!contact || contact.type !== "user") return;
    const now = Date.now();
    if (now - lastTypingSent < TYPING_THROTTLE_MS) return;
    lastTypingSent = now;
    void sendUserDMTyping(contact.ap_id).catch(() => {});
  };

  const send = async (content: string): Promise<boolean> => {
    const contact = selected();
    if (!contact) return false;
    const actor = app.actor();
    const temp: ChatMessage = {
      id: `temp-${++tempSeq}`,
      sender: {
        ap_id: actor.ap_id,
        username: actor.username,
        preferred_username: actor.preferred_username,
        name: actor.name,
        icon_url: actor.icon_url,
      },
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, temp]);
    try {
      if (contact.type === "community") {
        await sendCommunityMessage(contact.ap_id, content);
      } else {
        await sendUserDMMessage(contact.ap_id, content);
      }
      // Drop the optimistic placeholder before merging the server's copy so the
      // confirmed message does not show up twice (temp id != server id).
      const fetched = await loadMessages(contact);
      setMessages(
        mergeById(
          messages().filter((m) => m.id !== temp.id),
          fetched,
        ),
      );
      void refetchContacts();
      return true;
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== temp.id));
      app.toast("送信に失敗しました", "error");
      return false;
    }
  };

  const deleteMessage = async (messageId: string): Promise<boolean> => {
    const contact = selected();
    if (!contact || contact.type !== "community") return false;
    const before = messages();
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await deleteCommunityMessage(contact.ap_id, messageId);
      return true;
    } catch {
      setMessages(before);
      app.toast("削除に失敗しました", "error");
      return false;
    }
  };

  // On a wide (desktop) viewport the chat pane is always visible, so open the
  // most recent conversation by default rather than leaving it empty.
  createEffect(() => {
    if (didAutoSelect() || selected() || !isWideViewport()) return;
    const first = contactsResource()?.[0];
    if (!first) return;
    setDidAutoSelect(true);
    setSelected(first);
  });

  return (
    <ChatContext.Provider
      value={{
        contacts,
        contactsLoading: () => contactsResource.loading,
        selected,
        selectContact: setSelected,
        messages,
        messagesLoading,
        send,
        deleteMessage,
        refetchContacts: () => void refetchContacts(),
        isTyping,
        notifyTyping,
      }}
    >
      {props.children}
    </ChatContext.Provider>
  );
}
