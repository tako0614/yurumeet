import { createEffect, createSignal, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { type MediaAttachment, uploadMedia } from "@takosjp/yurucommu-api";
import { useApp } from "../lib/app-context.tsx";
import { type ChatMessage, useChat } from "../lib/chat-context.tsx";
import { createEscapeClose } from "../lib/dialog.tsx";
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
  titleFor,
  UserAvatar as Avatar,
} from "../lib/ui.tsx";

/** Distance from the bottom (px) within which incoming messages auto-scroll. */
const NEAR_BOTTOM_PX = 96;
/** Distance from the top (px) that triggers loading the next older page. */
const NEAR_TOP_PX = 60;
/** LINE-style cap on images staged per message. */
const MAX_CHAT_ATTACHMENTS = 4;
const MAX_CHAT_IMAGE_SIZE = 20 * 1024 * 1024;

type StagedMedia = MediaAttachment & { preview: string };

export function ChatPane() {
  const app = useApp();
  const chat = useChat();
  const [draft, setDraft] = createSignal("");
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  const [newBelow, setNewBelow] = createSignal(0);
  const [staged, setStaged] = createSignal<StagedMedia[]>([]);
  const [uploading, setUploading] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;

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
    if (!files) return;
    for (const file of Array.from(files)) {
      if (staged().length >= MAX_CHAT_ATTACHMENTS) break;
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_CHAT_IMAGE_SIZE) {
        app.toast("画像は 20MB までです", "error");
        continue;
      }
      setUploading(true);
      try {
        const uploaded = await uploadMedia(file);
        setStaged((prev) => [
          ...prev,
          {
            url: uploaded.url,
            r2_key: uploaded.r2_key,
            content_type: uploaded.content_type,
            preview: URL.createObjectURL(file),
          },
        ]);
      } catch {
        app.toast("画像のアップロードに失敗しました", "error");
      } finally {
        setUploading(false);
      }
    }
    if (fileInput) fileInput.value = "";
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
      nearBottom = true;
      return;
    }
    if (switched || (!hadMessages && lastId !== undefined)) {
      setNewBelow(0);
      nearBottom = true;
      requestAnimationFrame(() => scrollToBottom(false));
      return;
    }
    if (!appended || !last) return;
    const mine = last.sender.ap_id === app.actor().ap_id;
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
              </div>
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
                        const mine = message.sender.ap_id === app.actor().ap_id;
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
                              classList={{
                                "c-talk-chat": true,
                                self: mine,
                                other: !mine,
                                primary: primary(),
                                subsequent: !primary(),
                                "is-pending": !!message.pending,
                                "is-failed": !!message.failed,
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
                                        (message.attachments?.length ?? 0) > 0,
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
                                                  attachment.content_type ?? ""
                                                ).startsWith("video/")}
                                                fallback={
                                                  <a
                                                    href={src}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                  >
                                                    <img
                                                      src={src}
                                                      alt={
                                                        attachment.name ?? ""
                                                      }
                                                      loading="lazy"
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
                                      <p>{renderRichText(message.content)}</p>
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
                                      <div class="c-talk-msg-menu" role="menu">
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
                          <img src={item.preview} alt="" />
                          <button
                            type="button"
                            aria-label="画像を削除"
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
                    aria-label="画像を添付"
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
                    accept="image/*"
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
                            !event.isComposing &&
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
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
