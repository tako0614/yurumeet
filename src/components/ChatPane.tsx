import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { A } from "@solidjs/router";
import {
  type DMContact,
  type MediaAttachment,
  uploadMedia,
} from "@takosjp/yurucommu-api";
import { useApp } from "../lib/app-context.tsx";
import { type ChatMessage, useChat } from "../lib/chat-context.tsx";
import { createEscapeClose, DialogA11y } from "../lib/dialog.tsx";
import { clearDraft, readDraft, writeDraft } from "../lib/draft-store.ts";
import { searchMessages } from "../lib/message-search.ts";
import {
  attachmentSrc,
  CloseIcon,
  communityPath,
  contactSubtitle,
  formatDayLabel,
  formatTime,
  profilePath,
  renderRichText,
  sameDay,
  SpinnerIcon,
  titleFor,
  UserAvatar as Avatar,
} from "../lib/ui.tsx";

/** Distance from the bottom (px) within which incoming messages auto-scroll. */
const NEAR_BOTTOM_PX = 96;
/** Distance from the top (px) that triggers loading the next older page. */
const NEAR_TOP_PX = 60;
/** LINE-style cap on attachments staged per message. */
const MAX_CHAT_ATTACHMENTS = 4;
const MAX_CHAT_MEDIA_SIZE = 20 * 1024 * 1024;

type StagedMedia = MediaAttachment & { preview: string };

export function ChatPane() {
  const app = useApp();
  const chat = useChat();
  const [draft, setDraft] = createSignal("");
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  const [newBelow, setNewBelow] = createSignal(0);
  // Announced to screen readers when a message from the OTHER side arrives, so
  // an incoming message is perceivable without watching the scroll region.
  const [incoming, setIncoming] = createSignal("");
  const [staged, setStaged] = createSignal<StagedMedia[]>([]);
  const [uploading, setUploading] = createSignal(false);
  /** Src of the image opened in the in-app lightbox (null = closed). */
  const [lightbox, setLightbox] = createSignal<string | null>(null);
  let lightboxRoot: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;

  // In-conversation search over the messages already loaded in the open
  // thread (client-side; no network). `searchIndex` points into `searchHits`
  // (oldest → newest); the current hit gets scrolled into view and ringed.
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchIndex, setSearchIndex] = createSignal(0);
  let searchInput: HTMLInputElement | undefined;
  const searchHits = createMemo(() =>
    searchOpen() ? searchMessages(chat.messages(), searchQuery()) : [],
  );
  const searchHitSet = createMemo(() => new Set(searchHits()));
  const currentHitId = () => searchHits()[searchIndex()];
  // Live element handles for the rendered message rows, so a search hit can be
  // scrolled into view. Cleared on conversation switch (below).
  const messageEls = new Map<string, HTMLElement>();

  // On touch devices the software keyboard has no Shift, so Enter must insert
  // a newline (LINE-style); sending is the button's job. Keyboard-first
  // environments keep Enter-to-send / Shift+Enter-newline.
  const coarsePointer =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches;

  createEscapeClose(
    () => menuFor() !== null,
    () => setMenuFor(null),
  );

  // Draft text and staged attachments belong to the conversation they were
  // typed in: carrying them across a switch risks a wrong-recipient send
  // (and leaks the preview object URLs). The generation counter also voids
  // uploads still in flight for the previous thread. The TEXT draft, however,
  // is persisted per-talk and restored on return (staged media is not — object
  // URLs can't survive and mis-sending a stale upload would be worse).
  let stagedGeneration = 0;
  createEffect(
    on(
      () => chat.selected()?.ap_id,
      (apId, prevApId) => {
        if (prevApId) writeDraft(prevApId, draft());
        stagedGeneration++;
        setStaged((prev) => {
          prev.forEach((item) => URL.revokeObjectURL(item.preview));
          return [];
        });
        setUploading(false);
        setMenuFor(null);
        setLightbox(null);
        setSearchOpen(false);
        setSearchQuery("");
        messageEls.clear();
        setDraft(apId ? readDraft(apId) : "");
      },
    ),
  );

  // Save the open talk's draft when the tab is backgrounded or closed, so a
  // reload/close without a conversation switch still restores it.
  if (typeof window !== "undefined") {
    const flushDraft = () => {
      const apId = chat.selected()?.ap_id;
      if (apId) writeDraft(apId, draft());
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", onHidden);
    onCleanup(() => {
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", onHidden);
    });
  }

  createEscapeClose(searchOpen, () => {
    setSearchOpen(false);
    setSearchQuery("");
  });

  const jumpToHit = (index: number) => {
    const id = searchHits()[index];
    if (!id) return;
    messageEls.get(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const toggleSearch = () => {
    if (searchOpen()) {
      setSearchOpen(false);
      setSearchQuery("");
      return;
    }
    setSearchOpen(true);
    requestAnimationFrame(() => searchInput?.focus());
  };

  // Step through matches. Hits run oldest → newest, so "older" walks the index
  // down and "newer" walks it up; both scroll the landed match into view.
  const stepHit = (delta: number) => {
    const count = searchHits().length;
    if (count === 0) return;
    const next = Math.min(count - 1, Math.max(0, searchIndex() + delta));
    setSearchIndex(next);
    jumpToHit(next);
  };

  // When the result set changes (typing, or new/older messages arriving),
  // land on the newest match and reveal it.
  createEffect(
    on(searchHits, (hits) => {
      if (hits.length === 0) {
        setSearchIndex(0);
        return;
      }
      setSearchIndex(hits.length - 1);
      requestAnimationFrame(() => jumpToHit(hits.length - 1));
    }),
  );

  const copyMessage = async (content: string) => {
    setMenuFor(null);
    try {
      await navigator.clipboard.writeText(content);
      app.toast("コピーしました");
    } catch {
      app.toast("コピーできませんでした", "error");
    }
  };

  const removeMessage = async (id: string) => {
    setMenuFor(null);
    const ok = await app.confirm({
      title: "メッセージを削除",
      message: "このメッセージを削除しますか?",
      confirmLabel: "削除",
      danger: true,
    });
    if (ok) await chat.deleteMessage(id);
  };

  const canSend = () =>
    (draft().trim().length > 0 || staged().length > 0) && !uploading();

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const generation = stagedGeneration;
    let skippedType = 0;
    let skippedCap = 0;
    // Hold canSend off for the WHOLE batch (not per file) so a multi-image
    // send can't fire with only part of the selection uploaded.
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (
          !file.type.startsWith("image/") &&
          !file.type.startsWith("video/")
        ) {
          skippedType++;
          continue;
        }
        if (staged().length >= MAX_CHAT_ATTACHMENTS) {
          skippedCap++;
          continue;
        }
        if (file.size > MAX_CHAT_MEDIA_SIZE) {
          app.toast("ファイルは 20MB までです", "error");
          continue;
        }
        try {
          const uploaded = await uploadMedia(file);
          // The conversation switched while uploading: this file belongs to
          // the previous thread — drop it instead of staging it here.
          if (generation !== stagedGeneration) return;
          setStaged((prev) => [
            ...prev,
            {
              url: uploaded.url,
              r2_key: uploaded.r2_key,
              content_type: uploaded.content_type,
              // The filename doubles as the fallback label for a staged
              // video whose first frame hasn't decoded.
              ...(file.type.startsWith("video/") ? { name: file.name } : {}),
              preview: URL.createObjectURL(file),
            },
          ]);
        } catch {
          app.toast("アップロードに失敗しました", "error");
        }
      }
      if (skippedType > 0) {
        app.toast("画像・動画以外は添付できません", "error");
      }
      if (skippedCap > 0) {
        app.toast(`添付は ${MAX_CHAT_ATTACHMENTS} 件までです`, "error");
      }
    } finally {
      if (generation === stagedGeneration) setUploading(false);
      if (fileInput) fileInput.value = "";
    }
  };

  const removeStaged = (index: number) => {
    setStaged((prev) => {
      const target = prev[index];
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  // "既読" for OWN messages, LINE-style. 1:1: shown when the partner's local
  // read position covers the message. Group: "既読 N" counting other members
  // whose read position covers it. Receipts are local-only — a remote partner
  // never reports one, so nothing renders (never a false "unread").
  const readLabel = (message: ChatMessage): string | null => {
    if (message.pending || message.failed) return null;
    if (chat.selected()?.type === "community") {
      const me = app.actor().ap_id;
      const count = chat
        .readStates()
        .filter(
          (state) =>
            state.actor_ap_id !== me &&
            state.last_read_at >= message.created_at,
        ).length;
      return count > 0 ? `既読 ${count}` : null;
    }
    const partnerReadAt = chat.partnerLastReadAt();
    if (!partnerReadAt) return null;
    return partnerReadAt >= message.created_at ? "既読" : null;
  };

  let scrollRef: HTMLDivElement | undefined;
  // Last user scroll position relative to the bottom, sampled in the scroll
  // handler so the check reflects where the user WAS before new content grew
  // the scroll height.
  let nearBottom = true;

  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  // Chat images have no reserved height: when one decodes it grows the
  // scroll height AFTER the auto scroll-to-bottom already ran. Re-pin while
  // the reader is at the bottom; when it grew fully above the viewport
  // (freshly prepended older history) shift scrollTop by the growth so the
  // visible messages don't jump.
  const onMediaLoad = (event: Event) => {
    const el = scrollRef;
    if (!el) return;
    if (nearBottom) {
      scrollToBottom(false);
      return;
    }
    const media = event.currentTarget as HTMLElement;
    const mediaBox = media.getBoundingClientRect();
    const hostBox = el.getBoundingClientRect();
    if (mediaBox.bottom <= hostBox.top) el.scrollTop += mediaBox.height;
  };

  const loadOlderPreservingScroll = async () => {
    const el = scrollRef;
    if (!el || chat.loadingOlder() || !chat.messagesHasMore()) return;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    await chat.loadOlderMessages();
    // Prepended history grows scrollHeight above the viewport; compensate so
    // the message the user was reading stays put.
    requestAnimationFrame(() => {
      const grown = el.scrollHeight - prevHeight;
      if (grown > 0) el.scrollTop = prevTop + grown;
    });
  };

  const onScroll = () => {
    const el = scrollRef;
    if (!el) return;
    nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom && newBelow() > 0) setNewBelow(0);
    if (
      el.scrollTop < NEAR_TOP_PX &&
      chat.messagesHasMore() &&
      !chat.loadingOlder() &&
      !chat.messagesLoading()
    ) {
      void loadOlderPreservingScroll();
    }
  };

  const send = () => {
    const content = draft().trim();
    const attachments = staged();
    if ((!content && attachments.length === 0) || uploading()) return;
    const apId = chat.selected()?.ap_id;
    if (apId) clearDraft(apId);
    setDraft("");
    setStaged([]);
    attachments.forEach((item) => URL.revokeObjectURL(item.preview));
    void chat.send(
      content,
      attachments.map(({ url, r2_key, content_type, name }) => ({
        url,
        r2_key,
        content_type,
        ...(name ? { name } : {}),
      })),
    );
  };

  // Keep the newest message in view without yanking a reader who scrolled up:
  // - conversation switch / initial load → jump to the bottom;
  // - a message appended while near the bottom (or one of our own) → smooth
  //   scroll down;
  // - a message appended while reading history → show the "new message" pill.
  // History prepends don't change the LAST message id, so they never scroll.
  let prevApId: string | undefined;
  let prevLastId: string | undefined;
  let prevCount = 0;
  createEffect(() => {
    const apId = chat.selected()?.ap_id;
    const msgs = chat.messages();
    const last = msgs[msgs.length - 1];
    const lastId = last?.id;
    const switched = prevApId !== apId;
    const hadMessages = prevLastId !== undefined;
    const appended = !switched && lastId !== undefined && lastId !== prevLastId;
    const appendedCount = Math.max(1, msgs.length - prevCount);
    prevApId = apId;
    prevLastId = lastId;
    prevCount = msgs.length;
    if (!apId) {
      setNewBelow(0);
      setIncoming("");
      nearBottom = true;
      return;
    }
    if (switched || (!hadMessages && lastId !== undefined)) {
      setNewBelow(0);
      setIncoming("");
      nearBottom = true;
      requestAnimationFrame(() => scrollToBottom(false));
      return;
    }
    if (!appended || !last) return;
    const mine = last.sender.ap_id === app.actor().ap_id;
    if (!mine) {
      // The content usually differs message-to-message so aria-live re-fires;
      // media-only messages still announce something meaningful.
      const preview =
        last.content?.trim() ||
        ((last.attachments?.length ?? 0) > 0 ? "画像を送信しました" : "");
      setIncoming(`${titleFor(last.sender)}: ${preview}`);
    }
    if (mine || nearBottom) {
      setNewBelow(0);
      requestAnimationFrame(() => scrollToBottom(true));
    } else {
      setNewBelow((n) => n + appendedCount);
    }
  });

  return (
    <div class="p-talk-chat">
      <div class="p-talk-chat-container">
        <Show
          when={chat.selected()}
          fallback={
            <div class="p-talk-chat-empty">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8.824 18.588 4 21l.653-4.573C3.006 15.001 2 13.095 2 11 2 6.582 6.477 3 12 3s10 3.582 10 8-4.477 8-10 8c-1.11 0-2.178-.145-3.176-.412Z" />
              </svg>
              <p>トークを選ぶと会話が表示されます</p>
            </div>
          }
        >
          {(contact) => (
            <>
              <div class="p-talk-chat-title">
                <button
                  class="p-talk-chat-prev"
                  type="button"
                  onClick={() => chat.selectContact(null)}
                  aria-label="戻る"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <polyline points="14 18 8 12 14 6 14 6" />
                  </svg>
                </button>
                <Show
                  when={contact().type === "user"}
                  fallback={
                    <A
                      href={communityPath(contact().ap_id)}
                      class="p-talk-chat-title-link"
                    >
                      <Avatar value={contact()} />
                      <div class="p-talk-chat-title-main">
                        <p>{titleFor(contact())}</p>
                        <span>{contactSubtitle(contact())}</span>
                      </div>
                    </A>
                  }
                >
                  <A
                    href={profilePath(contact().ap_id)}
                    class="p-talk-chat-title-link"
                  >
                    <Avatar value={contact()} />
                    <div class="p-talk-chat-title-main">
                      <p>{titleFor(contact())}</p>
                      <span classList={{ "is-typing": chat.isTyping() }}>
                        {chat.isTyping()
                          ? "入力中…"
                          : contactSubtitle(contact())}
                      </span>
                    </div>
                  </A>
                </Show>
                <button
                  class="p-talk-chat-action"
                  classList={{ "is-active": searchOpen() }}
                  type="button"
                  aria-label="トーク内を検索"
                  aria-pressed={searchOpen()}
                  onClick={toggleSearch}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                </button>
              </div>
              <Show when={searchOpen()}>
                <div class="p-talk-chat-search" role="search">
                  <div class="p-talk-chat-search__field">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-3.5-3.5" />
                    </svg>
                    <input
                      ref={searchInput}
                      type="text"
                      inputmode="search"
                      placeholder="メッセージを検索"
                      aria-label="トーク内のメッセージを検索"
                      value={searchQuery()}
                      onInput={(event) =>
                        setSearchQuery(event.currentTarget.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.isComposing) {
                          event.preventDefault();
                          // Enter walks backward through history (older), the
                          // way messenger search steps up the thread.
                          stepHit(event.shiftKey ? 1 : -1);
                        }
                      }}
                    />
                    <Show when={searchQuery().trim().length > 0}>
                      <span
                        class="p-talk-chat-search__count"
                        aria-live="polite"
                      >
                        {searchHits().length > 0
                          ? `${searchIndex() + 1}/${searchHits().length}`
                          : "一致なし"}
                      </span>
                    </Show>
                  </div>
                  <div class="p-talk-chat-search__nav">
                    <button
                      type="button"
                      aria-label="前の一致（古い方へ）"
                      disabled={searchHits().length === 0 || searchIndex() <= 0}
                      onClick={() => stepHit(-1)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m6 15 6-6 6 6" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      aria-label="次の一致（新しい方へ）"
                      disabled={
                        searchHits().length === 0 ||
                        searchIndex() >= searchHits().length - 1
                      }
                      onClick={() => stepHit(1)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="p-talk-chat-search__close"
                      aria-label="検索を閉じる"
                      onClick={() => {
                        setSearchOpen(false);
                        setSearchQuery("");
                      }}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={chat.connectionLost()}>
                <div class="p-conn-banner" role="status">
                  接続を確認しています…
                </div>
              </Show>
              <p
                class="yc-visually-hidden"
                aria-live="polite"
                aria-atomic="true"
              >
                {incoming()}
              </p>
              <div
                class="p-talk-chat-main"
                ref={(el) => (scrollRef = el)}
                onScroll={onScroll}
              >
                <ul class="p-talk-chat-main__ul">
                  <Show
                    when={!chat.messagesLoading()}
                    fallback={<li class="p-home-empty">読み込み中...</li>}
                  >
                    <Show
                      when={!chat.messagesError()}
                      fallback={
                        <li class="p-talk-chat-empty-row">
                          メッセージを読み込めませんでした
                          <div class="p-talk-chat-older">
                            <button
                              type="button"
                              onClick={() => chat.reloadMessages()}
                            >
                              再試行
                            </button>
                          </div>
                        </li>
                      }
                    >
                      <Show when={chat.messagesHasMore()}>
                        <li class="p-talk-chat-older">
                          <button
                            type="button"
                            disabled={chat.loadingOlder()}
                            onClick={() => void loadOlderPreservingScroll()}
                          >
                            {chat.loadingOlder()
                              ? "読み込み中…"
                              : "以前のメッセージを読み込む"}
                          </button>
                        </li>
                      </Show>
                      <For
                        each={chat.messages()}
                        fallback={
                          <li class="p-talk-chat-empty-row">
                            まだメッセージがありません。あいさつを送ってみましょう。
                          </li>
                        }
                      >
                        {(message, index) => {
                          // Reactive lookups: history prepends shift `index()`,
                          // so day dividers / avatar grouping must recompute.
                          const prev = () => chat.messages()[index() - 1];
                          const showDay = () =>
                            index() === 0 ||
                            !sameDay(message.created_at, prev()!.created_at);
                          const mine =
                            message.sender.ap_id === app.actor().ap_id;
                          const primary = () =>
                            showDay() ||
                            prev()?.sender.ap_id !== message.sender.ap_id;
                          return (
                            <>
                              <Show when={showDay()}>
                                <li class="c-talk-date">
                                  <div class="c-talk-chat-date-box">
                                    <p>{formatDayLabel(message.created_at)}</p>
                                  </div>
                                </li>
                              </Show>
                              <li
                                ref={(el) => messageEls.set(message.id, el)}
                                classList={{
                                  "c-talk-chat": true,
                                  self: mine,
                                  other: !mine,
                                  primary: primary(),
                                  subsequent: !primary(),
                                  "is-pending": !!message.pending,
                                  "is-failed": !!message.failed,
                                  "is-search-hit":
                                    searchOpen() &&
                                    searchHitSet().has(message.id),
                                  "is-search-current":
                                    searchOpen() &&
                                    currentHitId() === message.id,
                                }}
                              >
                                <div class="c-talk-chat-box">
                                  <Show when={!mine && primary()}>
                                    <A
                                      class="c-talk-chat-icon"
                                      href={profilePath(message.sender.ap_id)}
                                    >
                                      <Avatar value={message.sender} />
                                    </A>
                                  </Show>
                                  <Show when={mine}>
                                    <div class="c-talk-chat-date">
                                      <Show when={readLabel(message)}>
                                        {(label) => (
                                          <span class="c-talk-chat-read">
                                            {label()}
                                          </span>
                                        )}
                                      </Show>
                                      <p>{formatTime(message.created_at)}</p>
                                    </div>
                                  </Show>
                                  <div class="c-talk-chat-right">
                                    <Show when={!mine && primary()}>
                                      <A
                                        class="c-talk-chat-name"
                                        href={profilePath(message.sender.ap_id)}
                                      >
                                        <p>{titleFor(message.sender)}</p>
                                      </A>
                                    </Show>
                                    <div
                                      classList={{
                                        "c-talk-chat-msg": true,
                                        "has-media":
                                          (message.attachments?.length ?? 0) >
                                          0,
                                      }}
                                    >
                                      <Show
                                        when={
                                          (message.attachments?.length ?? 0) > 0
                                        }
                                      >
                                        <div class="c-talk-chat-media">
                                          <For each={message.attachments}>
                                            {(attachment) => {
                                              const src = attachmentSrc(
                                                attachment,
                                                app.origin(),
                                              );
                                              if (!src) return null;
                                              return (
                                                <Show
                                                  when={(
                                                    attachment.content_type ??
                                                    ""
                                                  ).startsWith("video/")}
                                                  fallback={
                                                    <a
                                                      href={src}
                                                      target="_blank"
                                                      rel="noopener noreferrer"
                                                      onClick={(event) => {
                                                        // Plain tap opens the
                                                        // in-app lightbox; the
                                                        // real link stays for
                                                        // long-press / modified
                                                        // clicks.
                                                        if (
                                                          event.metaKey ||
                                                          event.ctrlKey ||
                                                          event.shiftKey
                                                        ) {
                                                          return;
                                                        }
                                                        event.preventDefault();
                                                        setLightbox(src);
                                                      }}
                                                    >
                                                      <img
                                                        src={src}
                                                        alt={
                                                          attachment.name ?? ""
                                                        }
                                                        loading="lazy"
                                                        onLoad={onMediaLoad}
                                                      />
                                                    </a>
                                                  }
                                                >
                                                  <video
                                                    src={src}
                                                    controls
                                                    preload="metadata"
                                                    playsinline
                                                  />
                                                </Show>
                                              );
                                            }}
                                          </For>
                                        </div>
                                      </Show>
                                      <Show when={message.content}>
                                        <p>
                                          {renderRichText(
                                            message.content,
                                            searchOpen()
                                              ? searchQuery()
                                              : undefined,
                                          )}
                                        </p>
                                      </Show>
                                      <button
                                        type="button"
                                        class="c-talk-msg-action"
                                        aria-label="メッセージ操作"
                                        onClick={() =>
                                          setMenuFor(
                                            menuFor() === message.id
                                              ? null
                                              : message.id,
                                          )
                                        }
                                      >
                                        <svg
                                          viewBox="0 0 24 24"
                                          aria-hidden="true"
                                        >
                                          <circle cx="5" cy="12" r="1.6" />
                                          <circle cx="12" cy="12" r="1.6" />
                                          <circle cx="19" cy="12" r="1.6" />
                                        </svg>
                                      </button>
                                      <Show when={menuFor() === message.id}>
                                        <button
                                          type="button"
                                          class="c-talk-msg-scrim"
                                          aria-label="閉じる"
                                          onClick={() => setMenuFor(null)}
                                        />
                                        <div
                                          class="c-talk-msg-menu"
                                          role="menu"
                                        >
                                          <button
                                            type="button"
                                            role="menuitem"
                                            onClick={() =>
                                              void copyMessage(message.content)
                                            }
                                          >
                                            コピー
                                          </button>
                                          <Show
                                            when={
                                              mine &&
                                              !message.pending &&
                                              !message.failed &&
                                              chat.selected()?.type ===
                                                "community"
                                            }
                                          >
                                            <button
                                              type="button"
                                              role="menuitem"
                                              class="is-danger"
                                              onClick={() =>
                                                void removeMessage(message.id)
                                              }
                                            >
                                              削除
                                            </button>
                                          </Show>
                                        </div>
                                      </Show>
                                    </div>
                                    <Show when={message.failed}>
                                      <div class="c-talk-chat-failed">
                                        <span>送信できませんでした</span>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            void chat.resendMessage(message.id)
                                          }
                                        >
                                          再送
                                        </button>
                                        <button
                                          type="button"
                                          class="is-danger"
                                          onClick={() =>
                                            chat.discardMessage(message.id)
                                          }
                                        >
                                          削除
                                        </button>
                                      </div>
                                    </Show>
                                  </div>
                                  <Show when={!mine}>
                                    <div class="c-talk-chat-date">
                                      <p>{formatTime(message.created_at)}</p>
                                    </div>
                                  </Show>
                                </div>
                              </li>
                            </>
                          );
                        }}
                      </For>
                    </Show>
                  </Show>
                </ul>
              </div>
              <Show when={newBelow() > 0}>
                <button
                  type="button"
                  class="p-talk-chat-newpill"
                  onClick={() => {
                    setNewBelow(0);
                    scrollToBottom(true);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M6 13l6 6 6-6" />
                  </svg>
                  新着メッセージ {newBelow()}件
                </button>
              </Show>
              <div class="p-talk-chat-send">
                <Show when={staged().length > 0 || uploading()}>
                  <div class="p-talk-chat-attach-strip">
                    <For each={staged()}>
                      {(item, index) => (
                        <span class="p-talk-chat-attach-item">
                          <Show
                            when={(item.content_type ?? "").startsWith(
                              "video/",
                            )}
                            fallback={<img src={item.preview} alt="" />}
                          >
                            <video
                              src={item.preview}
                              muted
                              playsinline
                              preload="metadata"
                            />
                            <Show when={item.name}>
                              <span class="p-talk-chat-attach-name">
                                {item.name}
                              </span>
                            </Show>
                          </Show>
                          <button
                            type="button"
                            aria-label="添付を削除"
                            onClick={() => removeStaged(index())}
                          >
                            <CloseIcon />
                          </button>
                        </span>
                      )}
                    </For>
                    <Show when={uploading()}>
                      <span
                        class="p-talk-chat-attach-item is-uploading"
                        aria-label="アップロード中"
                      />
                    </Show>
                  </div>
                </Show>
                <form
                  class="p-talk-chat-send__form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    send();
                  }}
                >
                  <button
                    type="button"
                    class="p-talk-chat-send__attach"
                    aria-label="画像・動画を添付"
                    disabled={
                      uploading() || staged().length >= MAX_CHAT_ATTACHMENTS
                    }
                    onClick={() => fileInput?.click()}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="3" y="3" width="18" height="18" rx="3" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="m21 15-5-5L5 21" />
                    </svg>
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    hidden
                    onChange={(event) =>
                      void handleFiles(event.currentTarget.files)
                    }
                  />
                  <div class="p-talk-chat-send__msg">
                    <div class="p-talk-chat-send__dummy" aria-hidden="true">
                      {draft() + "​"}
                    </div>
                    <label>
                      <textarea
                        class="p-talk-chat-send__textarea"
                        name="message"
                        placeholder="メッセージを入力"
                        value={draft()}
                        onInput={(event) => {
                          setDraft(event.currentTarget.value);
                          chat.notifyTyping();
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            // Safari fires the IME confirm-Enter with
                            // isComposing=false but the legacy keyCode 229.
                            !event.isComposing &&
                            event.keyCode !== 229 &&
                            !coarsePointer
                          ) {
                            event.preventDefault();
                            send();
                          }
                        }}
                      />
                    </label>
                  </div>
                  <button
                    class="p-talk-chat-send__send"
                    type="submit"
                    aria-label="送信"
                    disabled={!canSend()}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3.4 20.4 20.85 12.92c.81-.35.81-1.49 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91Z" />
                    </svg>
                  </button>
                </form>
              </div>
              <Show when={lightbox()}>
                {(src) => (
                  <div
                    class="p-chat-lightbox"
                    role="dialog"
                    aria-modal="true"
                    aria-label="画像プレビュー"
                    ref={(el) => (lightboxRoot = el)}
                  >
                    <DialogA11y
                      root={() => lightboxRoot}
                      onClose={() => setLightbox(null)}
                    />
                    <button
                      type="button"
                      class="p-chat-lightbox-dismiss"
                      aria-label="閉じる"
                      onClick={() => setLightbox(null)}
                    />
                    <img src={src()} alt="" />
                    <button
                      type="button"
                      class="p-chat-lightbox-close"
                      aria-label="閉じる"
                      onClick={() => setLightbox(null)}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
