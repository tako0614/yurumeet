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
import {
  classifyMessageDeliveryFailure,
  type MessageDeliveryFailure,
} from "./message-delivery.ts";
import { createOutgoingRecovery } from "./outgoing-recovery.ts";
import { restoreDeletedMessage } from "./restore-deleted-message.ts";
import {
  newOutgoingIntentId,
  type OutgoingJournalRecord,
} from "./outgoing-journal.ts";

/**
 * A chat message plus local delivery state: `pending` while an optimistic
 * send is in flight, `failed` when delivery errored (the bubble stays visible
 * with a retry/discard affordance instead of silently vanishing).
 */
export type ChatMessage = (DMMessage | CommunityMessage) & {
  pending?: boolean;
  failed?: boolean;
  deliveryFailure?: MessageDeliveryFailure;
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

function sameRenderedMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.content !== b.content || a.created_at !== b.created_at) return false;
  const aAtt = a.attachments ?? [];
  const bAtt = b.attachments ?? [];
  return (
    aAtt.length === bAtt.length &&
    aAtt.every((att, index) => att.url === bAtt[index]?.url)
  );
}

/**
 * Merge a polled newest-page window into the displayed list. Known messages
 * keep their position but adopt the server copy when edited; messages that
 * fall INSIDE the fetched window yet are missing from it were deleted
 * remotely and are dropped. Anything OLDER than the window wasn't fetched,
 * and anything NEWER may simply have committed after this poll's snapshot —
 * both are left untouched (as are local pending/failed sends). Genuinely new
 * messages append. The SAME array reference is returned when nothing changed
 * so scroll effects don't re-fire on every poll.
 */
function reconcileFetchedWindow(
  existing: ChatMessage[],
  fetched: ChatMessage[],
): ChatMessage[] {
  if (existing.length === 0) return fetched;
  if (fetched.length === 0) return existing;
  const byId = new Map(fetched.map((m) => [m.id, m]));
  const oldest = fetched[0];
  const newest = fetched[fetched.length - 1];
  // Composite (created_at, id) comparison, mirroring the server's keyset
  // cursor, so same-millisecond messages resolve deterministically.
  const notBefore = (m: ChatMessage, ref: ChatMessage) =>
    m.created_at > ref.created_at ||
    (m.created_at === ref.created_at && m.id >= ref.id);
  let changed = false;
  const next: ChatMessage[] = [];
  for (const message of existing) {
    if (message.pending || message.failed) {
      next.push(message);
      continue;
    }
    const server = byId.get(message.id);
    if (server) {
      // Keep the SAME object when nothing rendered changed so <For> doesn't
      // recreate every row each poll.
      if (sameRenderedMessage(message, server)) {
        next.push(message);
      } else {
        next.push(server);
        changed = true;
      }
      continue;
    }
    if (notBefore(message, oldest) && notBefore(newest, message)) {
      changed = true; // deleted remotely
      continue;
    }
    next.push(message);
  }
  const known = new Set(existing.map((m) => m.id));
  const fresh = fetched.filter((m) => !known.has(m.id));
  if (fresh.length > 0) {
    next.push(...fresh);
    changed = true;
  }
  return changed ? next : existing;
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
  /** True when the initial history load for the open conversation failed. */
  messagesError: Accessor<boolean>;
  /** Retry the failed initial history load for the open conversation. */
  reloadMessages: () => void;
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
  send: (
    content: string,
    attachments?: MediaAttachment[],
    onJournaled?: () => void,
  ) => Promise<boolean>;
  /**
   * Forward a message's text (and any media refs) to another talk via the same
   * DM/community send path. The target need not be the open conversation; when
   * it is, the sent message appears optimistically like a normal send.
   */
  forwardMessage: (
    target: DMContact,
    content: string,
    attachments?: MediaAttachment[],
  ) => Promise<boolean>;
  /** Retry a message whose delivery failed. */
  resendMessage: (messageId: string) => Promise<boolean>;
  /** Drop a failed optimistic message without sending it. */
  discardMessage: (messageId: string) => void;
  /** Delete a message. Only community messages are deletable (no DM delete API). */
  deleteMessage: (messageId: string) => Promise<boolean>;
  refetchContacts: () => void;
  isTyping: Accessor<boolean>;
  notifyTyping: () => void;
  /**
   * True after ≥2 consecutive background polls (messages or contacts)
   * failed; cleared by the next success. Drives the connection banner.
   */
  connectionLost: Accessor<boolean>;
};

const ChatContext = createContext<ChatContextValue>();

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("[yurume] useChat must be used within <ChatProvider>");
  }
  return ctx;
}

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
  const [messagesError, setMessagesError] = createSignal(false);
  const [messagesHasMore, setMessagesHasMore] = createSignal(false);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [partnerLastReadAt, setPartnerLastReadAt] = createSignal<string | null>(
    null,
  );
  const [readStates, setReadStates] = createSignal<CommunityReadState[]>([]);
  const [isTyping, setIsTyping] = createSignal(false);
  const [didAutoSelect, setDidAutoSelect] = createSignal(false);
  const recoveries = new Map<
    string,
    ReturnType<typeof createOutgoingRecovery>
  >();
  const scopeKey = () => JSON.stringify([app.origin(), app.actor().ap_id]);
  const recovery = () => {
    const key = scopeKey();
    let value = recoveries.get(key);
    if (!value) {
      value = createOutgoingRecovery({
        serverOrigin: app.origin(),
        principalApId: app.actor().ap_id,
      });
      recoveries.set(key, value);
      if (value.restorationFailed)
        app.toast("送信履歴を復元できません。履歴を確認してください", "error");
    }
    return value;
  };
  const sender = () => {
    const actor = app.actor();
    return {
      ap_id: actor.ap_id,
      username: actor.username,
      preferred_username: actor.preferred_username,
      name: actor.name,
      icon_url: actor.icon_url,
    };
  };
  const mergeOutgoing = (
    contact: DMContact,
    rows: ChatMessage[],
    fetchedAtRevision?: number,
    observedIds?: ReadonlySet<string>,
  ) =>
    recovery().merge(contact, rows, sender(), fetchedAtRevision, observedIds);

  // The 20s contacts refetch can re-sort the rows; applying that while a
  // finger is down makes the tap land on the wrong row. Hold the refreshed
  // order while a pointer is down and apply it on release.
  const [displayedContacts, setDisplayedContacts] = createSignal<DMContact[]>(
    [],
  );
  let pointerHeld = false;
  let pendingContacts: DMContact[] | null = null;
  createEffect(() => {
    const next = contactsResource() ?? [];
    if (pointerHeld) {
      pendingContacts = next;
      return;
    }
    setDisplayedContacts(next);
  });
  if (typeof window !== "undefined") {
    const onPointerDown = () => {
      pointerHeld = true;
    };
    const onPointerRelease = () => {
      pointerHeld = false;
      if (pendingContacts) {
        setDisplayedContacts(pendingContacts);
        pendingContacts = null;
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerRelease);
    window.addEventListener("pointercancel", onPointerRelease);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerRelease);
      window.removeEventListener("pointercancel", onPointerRelease);
    });
  }

  const contacts = () => displayedContacts();

  // Consecutive background-poll failures surface an unobtrusive
  // 「接続を確認しています…」 banner; any success clears it immediately.
  // One failed tick stays silent — flaky mobile networks drop single polls.
  const [connectionLost, setConnectionLost] = createSignal(false);
  let consecutivePollFailures = 0;
  const notePollFailure = () => {
    consecutivePollFailures++;
    if (consecutivePollFailures >= 2) setConnectionLost(true);
  };
  const notePollSuccess = () => {
    consecutivePollFailures = 0;
    setConnectionLost(false);
  };
  createEffect(() => {
    if (contactsResource.state === "ready") notePollSuccess();
    else if (contactsResource.state === "errored") notePollFailure();
  });

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
    // A reload while the mobile chat overlay was open leaves this history
    // entry flagged: back would then need two presses (the first only pops
    // the stale flag). The overlay never survives a reload, so strip it.
    const bootState = window.history.state as {
      yurumeChatOpen?: boolean;
    } | null;
    if (bootState?.yurumeChatOpen) {
      const cleaned = { ...bootState };
      delete cleaned.yurumeChatOpen;
      window.history.replaceState(cleaned, "");
    }
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
  const loadConversation = async (contact: DMContact) => {
    const generation = ++messageLoadGeneration;
    const principal = scopeKey();
    const fetchedAtRevision = recovery().revision();
    setMessages(mergeOutgoing(contact, []));
    setMessagesLoading(true);
    setMessagesError(false);
    try {
      const page = await loadMessagesPage(contact);
      if (
        generation !== messageLoadGeneration ||
        !isSelectedContact(contact) ||
        principal !== scopeKey()
      ) {
        return;
      }
      setMessages(mergeOutgoing(contact, page.messages, fetchedAtRevision));
      setMessagesHasMore(page.hasMore);
      setPartnerLastReadAt(page.partnerLastReadAt);
      setReadStates(page.readStates);
      markRead(contact);
    } catch {
      // Surface the failure instead of masquerading as an empty thread; the
      // 再試行 button and the poll both provide recovery paths.
      if (generation === messageLoadGeneration && isSelectedContact(contact)) {
        setMessagesError(true);
      }
    } finally {
      if (generation === messageLoadGeneration && isSelectedContact(contact)) {
        setMessagesLoading(false);
      }
    }
  };

  createEffect(
    on(
      () => [selected(), scopeKey()] as const,
      ([contact]) => {
        messageLoadGeneration++; // invalidate any in-flight load
        setIsTyping(false);
        setMessagesHasMore(false);
        setLoadingOlder(false);
        setPartnerLastReadAt(null);
        setReadStates([]);
        setMessagesError(false);
        if (!contact) {
          setMessages([]);
          setMessagesLoading(false);
          return;
        }
        void loadConversation(contact);
      },
    ),
  );

  const reloadMessages = () => {
    const contact = selected();
    if (contact) void loadConversation(contact);
  };

  const loadOlderMessages = async () => {
    const contact = selected();
    if (!contact || loadingOlder() || !messagesHasMore() || messagesLoading()) {
      return;
    }
    const cursor = olderCursor(messages());
    if (!cursor) return;
    const generation = messageLoadGeneration;
    const principal = scopeKey();
    setLoadingOlder(true);
    try {
      const page = await loadMessagesPage(contact, cursor);
      if (
        generation !== messageLoadGeneration ||
        !isSelectedContact(contact) ||
        principal !== scopeKey()
      ) {
        return;
      }
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const older = page.messages.filter((m) => !known.has(m.id));
        return mergeOutgoing(
          contact,
          older.length === 0 ? prev : [...older, ...prev],
        );
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
      // Skip a tick while the previous poll is still in flight so slow
      // responses don't stack and land out of order.
      let pollInFlight = false;
      const poll = () => {
        if (pollInFlight) return;
        pollInFlight = true;
        void (async () => {
          try {
            const principal = scopeKey();
            const fetchedAtRevision = recovery().revision();
            const page = await loadMessagesPage(contact);
            notePollSuccess();
            if (!isSelectedContact(contact) || principal !== scopeKey()) return;
            // A failed initial load left the thread empty with paging
            // disabled — the first successful poll is the recovery path.
            if (messagesError()) {
              setMessagesError(false);
              setMessagesHasMore(page.hasMore);
            }
            let receivedWhileOpen = false;
            setMessages((prev) => {
              const known = new Set(prev.map((message) => message.id));
              receivedWhileOpen = page.messages.some(
                (message) =>
                  !known.has(message.id) &&
                  message.sender.ap_id !== app.actor().ap_id,
              );
              return mergeOutgoing(
                contact,
                reconcileFetchedWindow(prev, page.messages),
                fetchedAtRevision,
                new Set(page.messages.map((message) => message.id)),
              );
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
            // Transient for the message list, but counted toward the
            // connection banner.
            notePollFailure();
          } finally {
            pollInFlight = false;
          }
        })();
      };
      const timer = window.setInterval(() => {
        if (
          typeof document !== "undefined" &&
          document.visibilityState !== "visible"
        ) {
          return;
        }
        poll();
      }, POLL_MS);
      onCleanup(() => window.clearInterval(timer));
      if (typeof document !== "undefined") {
        // Polling pauses while the tab is hidden; catch up immediately when
        // the user comes back instead of waiting out the current interval.
        const onVisible = () => {
          if (document.visibilityState === "visible") poll();
        };
        document.addEventListener("visibilitychange", onVisible);
        onCleanup(() =>
          document.removeEventListener("visibilitychange", onVisible),
        );
      }
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

  const storageWarning = () =>
    app.toast("送信内容を保存できません。入力を残しています", "error");

  const deliverMessage = async (
    contact: DMContact,
    record: OutgoingJournalRecord,
    store: ReturnType<typeof createOutgoingRecovery>,
    principal: string,
  ): Promise<boolean> => {
    const refresh = () => {
      if (principal === scopeKey() && isSelectedContact(contact)) {
        setMessages((current) => store.merge(contact, current, sender()));
      }
    };
    try {
      const sent: ChatMessage =
        contact.type === "community"
          ? await sendCommunityMessage(
              contact.ap_id,
              record.content,
              record.attachments,
            )
          : (
              await sendUserDMMessage(
                contact.ap_id,
                record.content,
                record.attachments,
              )
            ).message;
      const saved = store.confirm(record.id, sent);
      refresh();
      if (principal === scopeKey()) {
        if (!saved)
          app.toast(
            "送信済みですが復旧履歴を更新できません。再読込後は履歴を確認してください",
            "error",
          );
        void refetchContacts();
      }
      return true;
    } catch (error) {
      const deliveryFailure = classifyMessageDeliveryFailure(error);
      store.fail(record.id, deliveryFailure);
      refresh();
      if (principal === scopeKey())
        app.toast(
          deliveryFailure === "rejected"
            ? "送信を受け付けられませんでした"
            : "送信結果を確認できません",
          "error",
        );
      return false;
    }
  };

  const queueMessage = async (
    target: DMContact,
    content: string,
    attachments?: MediaAttachment[],
    onJournaled?: () => void,
  ): Promise<boolean> => {
    content = content.trim();
    if (!content && (attachments?.length ?? 0) === 0) return false;
    const contact = { ...target };
    const principal = scopeKey();
    const store = recovery();
    const record: OutgoingJournalRecord = {
      version: 1,
      id: newOutgoingIntentId(),
      target: { type: contact.type, ap_id: contact.ap_id },
      content,
      ...(attachments?.length
        ? {
            attachments: attachments.map(
              ({ url, r2_key, content_type, name }) => ({
                url,
                r2_key,
                content_type,
                ...(name !== undefined ? { name } : {}),
              }),
            ),
          }
        : {}),
      created_at: new Date().toISOString(),
      state: "pending",
    };
    if (!store.queue(record)) {
      storageWarning();
      return false;
    }
    if (isSelectedContact(contact))
      setMessages((current) => store.merge(contact, current, sender()));
    try {
      // Saved locally, not acknowledged by the server. Run exactly once.
      onJournaled?.();
    } catch {
      store.fail(record.id, "unconfirmed");
      if (isSelectedContact(contact))
        setMessages((current) => store.merge(contact, current, sender()));
      app.toast(
        "送信を開始できませんでした。入力と履歴を確認してください",
        "error",
      );
      return false;
    }
    return deliverMessage(contact, record, store, principal);
  };

  const send = async (
    content: string,
    attachments?: MediaAttachment[],
    onJournaled?: () => void,
  ): Promise<boolean> => {
    const contact = selected();
    return contact
      ? queueMessage(contact, content, attachments, onJournaled)
      : false;
  };

  const forwardMessage = async (
    target: DMContact,
    content: string,
    attachments?: MediaAttachment[],
  ): Promise<boolean> => queueMessage(target, content, attachments);

  const resendMessage = async (messageId: string): Promise<boolean> => {
    const current = selected();
    if (!current) return false;
    const contact = { ...current };
    const principal = scopeKey();
    const store = recovery();
    const retry = store.retry(contact, messageId);
    if (!retry) {
      storageWarning();
      return false;
    }
    setMessages((rows) => store.merge(contact, rows, sender()));
    return deliverMessage(contact, retry, store, principal);
  };

  const discardMessage = (messageId: string) => {
    const contact = selected();
    if (!contact) return;
    if (!recovery().discard(contact, messageId)) {
      app.toast("復旧履歴を消せませんでした。表示を残しています", "error");
      return;
    }
    setMessages((rows) => mergeOutgoing(contact, rows));
  };

  const deleteMessage = async (messageId: string): Promise<boolean> => {
    const contact = selected();
    if (!contact || contact.type !== "community") return false;
    const generation = messageLoadGeneration;
    const principal = scopeKey();
    const before = messages();
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      await deleteCommunityMessage(contact.ap_id, messageId);
      void refetchContacts();
      return true;
    } catch {
      const stillCurrent =
        generation === messageLoadGeneration &&
        isSelectedContact(contact) &&
        principal === scopeKey();
      if (stillCurrent) {
        setMessages((current) =>
          restoreDeletedMessage(current, before, messageId),
        );
        app.toast("削除に失敗しました", "error");
      }
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
        messagesError,
        reloadMessages,
        messagesHasMore,
        loadingOlder,
        loadOlderMessages,
        partnerLastReadAt,
        readStates,
        send,
        forwardMessage,
        resendMessage,
        discardMessage,
        deleteMessage,
        refetchContacts: () => void refetchContacts(),
        isTyping,
        notifyTyping,
        connectionLost,
      }}
    >
      {props.children}
    </ChatContext.Provider>
  );
}
