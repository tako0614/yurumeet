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
import { useLocation } from "@solidjs/router";
import {
  type CommunityMessage,
  type CommunityReadState,
  deleteCommunityMessage,
  type DMContact,
  type DMMessage,
  fetchCommunityMessages,
  fetchDMContacts,
  fetchUserDMMessages,
  fetchUserDMTyping,
  markCommunityAsRead,
  markDMAsRead,
  type MediaAttachment,
  sendCommunityMessage,
  sendUserDMMessage,
  sendUserDMTyping,
} from "@takosjp/yurucommu-api";
import { useApp } from "./app-context.tsx";

/**
 * A chat message plus local delivery state: `pending` while an optimistic
 * send is in flight, `failed` when delivery errored (the bubble stays visible
 * with a retry/discard affordance instead of silently vanishing).
 */
export type ChatMessage = (DMMessage | CommunityMessage) & {
  pending?: boolean;
  failed?: boolean;
};

const POLL_MS = 4000;
const CONTACTS_POLL_MS = 20000;
const TYPING_THROTTLE_MS = 2500;

async function loadContacts(): Promise<DMContact[]> {
  const data = await fetchDMContacts();
  return [...data.mutual_followers, ...data.communities].sort((a, b) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
  );
}

type MessagesPage = {
  messages: ChatMessage[];
  hasMore: boolean;
  /** 1:1 threads: the partner's local read position (null = unknown). */
  partnerLastReadAt: string | null;
  /** Group chats: per-member read positions (local members only). */
  readStates: CommunityReadState[];
};

async function loadMessagesPage(
  contact: DMContact,
  before?: string,
): Promise<MessagesPage> {
  if (contact.type === "community") {
    const page = await fetchCommunityMessages(
      contact.ap_id,
      before ? { before } : undefined,
    );
    return {
      messages: page.messages,
      hasMore: page.hasMore,
      partnerLastReadAt: null,
      readStates: page.readStates,
    };
  }
  const page = await fetchUserDMMessages(
    contact.ap_id,
    before ? { before } : undefined,
  );
  return {
    messages: page.messages,
    hasMore: page.hasMore,
    partnerLastReadAt: page.partnerLastReadAt,
    readStates: [],
  };
}

/**
 * Keyset cursor for "messages older than the oldest one shown". The server
 * accepts a composite `"<published> <apId>"` cursor (space separator) so two
 * messages sharing a millisecond aren't skipped across a page boundary.
 */
function olderCursor(messages: ChatMessage[]): string | null {
  const oldest = messages.find((m) => !m.pending && !m.failed);
  if (!oldest) return null;
  return `${oldest.created_at} ${oldest.id}`;
}

/**
 * Append messages from a polled window that aren't displayed yet. Existing
 * messages (loaded history, optimistic sends) keep their position; the SAME
 * array reference is returned when nothing changed so scroll effects don't
 * re-fire on every poll.
 */
function appendFresh(
  existing: ChatMessage[],
  fetched: ChatMessage[],
): ChatMessage[] {
  if (existing.length === 0) return fetched;
  const known = new Set(existing.map((m) => m.id));
  const fresh = fetched.filter((m) => !known.has(m.id));
  return fresh.length === 0 ? existing : [...existing, ...fresh];
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
  /** Whether an older page of history exists for the open conversation. */
  messagesHasMore: Accessor<boolean>;
  loadingOlder: Accessor<boolean>;
  /** Prepend the next older page of the open conversation's history. */
  loadOlderMessages: () => Promise<void>;
  /**
   * The partner's last-read time for the open 1:1 thread (LOCAL-ONLY read
   * receipt; null = unknown, e.g. a remote partner — render no receipt).
   */
  partnerLastReadAt: Accessor<string | null>;
  /** Per-member read positions for the open group chat (local members only). */
  readStates: Accessor<CommunityReadState[]>;
  send: (content: string, attachments?: MediaAttachment[]) => Promise<boolean>;
  /** Retry a message whose delivery failed. */
  resendMessage: (messageId: string) => Promise<boolean>;
  /** Drop a failed optimistic message without sending it. */
  discardMessage: (messageId: string) => void;
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
  const location = useLocation();
  const [contactsResource, { refetch: refetchContacts }] = createResource(
    app.origin,
    loadContacts,
  );
  const [selected, setSelected] = createSignal<DMContact | null>(null);
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = createSignal(false);
  const [messagesHasMore, setMessagesHasMore] = createSignal(false);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [partnerLastReadAt, setPartnerLastReadAt] = createSignal<string | null>(
    null,
  );
  const [readStates, setReadStates] = createSignal<CommunityReadState[]>([]);
  const [isTyping, setIsTyping] = createSignal(false);
  const [didAutoSelect, setDidAutoSelect] = createSignal(false);

  const contacts = () => contactsResource() ?? [];
  const isSelectedContact = (contact: DMContact): boolean => {
    const current = selected();
    return current?.type === contact.type && current.ap_id === contact.ap_id;
  };

  // On mobile the open conversation is an overlay; give it a history entry so
  // the browser/OS back gesture closes the chat instead of leaving the app,
  // matching the in-app back button.
  let pushedHistoryEntry = false;

  const closeSelectedQuietly = () => {
    // Close without popping our history entry (used when a router navigation
    // already changed the page underneath the overlay).
    pushedHistoryEntry = false;
    setSelected(null);
  };

  const selectContact = (contact: DMContact | null) => {
    if (contact) {
      const wasOpen = !!selected();
      setSelected(contact);
      if (
        !wasOpen &&
        !pushedHistoryEntry &&
        !isWideViewport() &&
        typeof window !== "undefined"
      ) {
        window.history.pushState(
          { ...(window.history.state ?? {}), yurumeChatOpen: true },
          "",
        );
        pushedHistoryEntry = true;
      }
      return;
    }
    setSelected(null);
    if (pushedHistoryEntry && typeof window !== "undefined") {
      pushedHistoryEntry = false;
      window.history.back();
    }
  };

  if (typeof window !== "undefined") {
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as { yurumeChatOpen?: boolean } | null;
      if (pushedHistoryEntry && !state?.yurumeChatOpen) {
        pushedHistoryEntry = false;
        setSelected(null);
      }
    };
    window.addEventListener("popstate", onPopState);
    onCleanup(() => window.removeEventListener("popstate", onPopState));
  }

  // A router navigation to another page while the mobile chat overlay is open
  // (e.g. tapping the partner's profile from the chat header) must not leave
  // the overlay covering the new page.
  createEffect(
    on(
      () => location.pathname,
      (pathname, previous) => {
        if (previous === undefined || pathname === previous) return;
        if (selected() && !isWideViewport()) closeSelectedQuietly();
      },
    ),
  );

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

  // Load messages + mark read whenever the open conversation changes. A
  // generation fence prevents a slow A request from overwriting B after a
  // rapid conversation switch.
  let messageLoadGeneration = 0;
  createEffect(
    on(selected, async (contact) => {
      const generation = ++messageLoadGeneration;
      setIsTyping(false);
      setMessagesHasMore(false);
      setLoadingOlder(false);
      setPartnerLastReadAt(null);
      setReadStates([]);
      if (!contact) {
        setMessages([]);
        setMessagesLoading(false);
        return;
      }
      setMessages([]);
      setMessagesLoading(true);
      try {
        const page = await loadMessagesPage(contact);
        if (
          generation !== messageLoadGeneration ||
          !isSelectedContact(contact)
        ) {
          return;
        }
        setMessages(page.messages);
        setMessagesHasMore(page.hasMore);
        setPartnerLastReadAt(page.partnerLastReadAt);
        setReadStates(page.readStates);
        markRead(contact);
      } catch {
        // Keep the selected conversation empty; polling provides the next
        // recovery attempt without letting this async effect reject globally.
      } finally {
        if (
          generation === messageLoadGeneration &&
          isSelectedContact(contact)
        ) {
          setMessagesLoading(false);
        }
      }
    }),
  );

  const loadOlderMessages = async () => {
    const contact = selected();
    if (!contact || loadingOlder() || !messagesHasMore() || messagesLoading()) {
      return;
    }
    const cursor = olderCursor(messages());
    if (!cursor) return;
    const generation = messageLoadGeneration;
    setLoadingOlder(true);
    try {
      const page = await loadMessagesPage(contact, cursor);
      if (generation !== messageLoadGeneration || !isSelectedContact(contact)) {
        return;
      }
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const older = page.messages.filter((m) => !known.has(m.id));
        return older.length === 0 ? prev : [...older, ...prev];
      });
      setMessagesHasMore(page.hasMore);
    } catch {
      app.toast("以前のメッセージを読み込めませんでした", "error");
    } finally {
      if (generation === messageLoadGeneration && isSelectedContact(contact)) {
        setLoadingOlder(false);
      }
    }
  };

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
            const page = await loadMessagesPage(contact);
            if (!isSelectedContact(contact)) return;
            let receivedWhileOpen = false;
            setMessages((prev) => {
              const known = new Set(prev.map((message) => message.id));
              receivedWhileOpen = page.messages.some(
                (message) =>
                  !known.has(message.id) &&
                  message.sender.ap_id !== app.actor().ap_id,
              );
              return appendFresh(prev, page.messages);
            });
            // Keep the read receipts fresh: the partner/member read positions
            // advance while the thread is open.
            setPartnerLastReadAt(page.partnerLastReadAt);
            setReadStates(page.readStates);
            // A conversation that is visibly open must not accumulate an unread
            // badge as its poll receives messages. Only write when a genuinely
            // new message from the other side arrived.
            if (receivedWhileOpen) markRead(contact);
            if (contact.type === "user") {
              const typing = await fetchUserDMTyping(contact.ap_id);
              if (isSelectedContact(contact)) {
                setIsTyping(!!typing.is_typing);
              }
            }
          } catch {
            /* transient */
          }
        })();
      }, POLL_MS);
      onCleanup(() => window.clearInterval(timer));
    }),
  );

  // The rooms list itself must stay fresh while the user sits on it (new
  // conversations, unread counts, last-message previews) — the nav badge polls
  // every 20s, so refresh the contact rows on the same cadence.
  if (typeof window !== "undefined") {
    const contactsTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refetchContacts();
    }, CONTACTS_POLL_MS);
    onCleanup(() => window.clearInterval(contactsTimer));
  }

  let lastTypingSent = 0;
  const notifyTyping = () => {
    const contact = selected();
    if (!contact || contact.type !== "user") return;
    const now = Date.now();
    if (now - lastTypingSent < TYPING_THROTTLE_MS) return;
    lastTypingSent = now;
    void sendUserDMTyping(contact.ap_id).catch(() => {});
  };

  const deliverMessage = async (
    contact: DMContact,
    temp: ChatMessage,
  ): Promise<boolean> => {
    try {
      const sent: ChatMessage =
        contact.type === "community"
          ? await sendCommunityMessage(
              contact.ap_id,
              temp.content,
              temp.attachments,
            )
          : (
              await sendUserDMMessage(
                contact.ap_id,
                temp.content,
                temp.attachments,
              )
            ).message;
      if (isSelectedContact(contact)) {
        // Replace the optimistic placeholder with the server's copy in place.
        setMessages((current) => {
          const without = current.filter((m) => m.id !== temp.id);
          return without.some((m) => m.id === sent.id)
            ? without
            : [...without, sent];
        });
      }
      void refetchContacts();
      return true;
    } catch {
      if (isSelectedContact(contact)) {
        setMessages((current) =>
          current.map((m) =>
            m.id === temp.id ? { ...m, pending: false, failed: true } : m,
          ),
        );
      }
      app.toast("送信に失敗しました", "error");
      return false;
    }
  };

  const send = async (
    content: string,
    attachments?: MediaAttachment[],
  ): Promise<boolean> => {
    const contact = selected();
    if (!contact) return false;
    if (!content && (attachments?.length ?? 0) === 0) return false;
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
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      created_at: new Date().toISOString(),
      pending: true,
    };
    setMessages((prev) => [...prev, temp]);
    return deliverMessage(contact, temp);
  };

  const resendMessage = async (messageId: string): Promise<boolean> => {
    const contact = selected();
    if (!contact) return false;
    const target = messages().find((m) => m.id === messageId && m.failed);
    if (!target) return false;
    const retry: ChatMessage = {
      ...target,
      failed: false,
      pending: true,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => prev.map((m) => (m.id === messageId ? retry : m)));
    return deliverMessage(contact, retry);
  };

  const discardMessage = (messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
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
      if (isSelectedContact(contact)) setMessages(before);
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
        // `state === "pending"` only covers the FIRST load: a 20s-cadence
        // refetch must not swap the visible rooms list for a skeleton.
        contactsLoading: () => contactsResource.state === "pending",
        selected,
        selectContact,
        messages,
        messagesLoading,
        messagesHasMore,
        loadingOlder,
        loadOlderMessages,
        partnerLastReadAt,
        readStates,
        send,
        resendMessage,
        discardMessage,
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
