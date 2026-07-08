import { createEffect, createSignal, For, Show } from "solid-js";
import { A } from "@solidjs/router";
import type { DMContact } from "@takosjp/yurucommu-api";
import { useApp } from "../lib/app-context.tsx";
import { useChat } from "../lib/chat-context.tsx";
import {
  communityPath,
  formatDayLabel,
  formatTime,
  profilePath,
  sameDay,
  titleFor,
  UserAvatar as Avatar,
} from "../lib/ui.tsx";

function contactSubtitle(contact: DMContact): string {
  if (contact.type === "community") {
    return contact.member_count ? `${contact.member_count} members` : "Group";
  }
  return contact.username.startsWith("@")
    ? contact.username
    : `@${contact.preferred_username}`;
}

export function ChatPane() {
  const app = useApp();
  const chat = useChat();
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [menuFor, setMenuFor] = createSignal<string | null>(null);

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
  const canSend = () => draft().trim().length > 0 && !sending();
  let scrollRef: HTMLDivElement | undefined;
  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  const send = async () => {
    const content = draft().trim();
    if (!content || sending()) return;
    setSending(true);
    try {
      const ok = await chat.send(content);
      if (ok) setDraft("");
    } finally {
      setSending(false);
    }
  };

  // Keep the newest message in view: jump when the conversation switches,
  // smooth-scroll when the open conversation gains a message.
  let prevApId: string | undefined;
  createEffect(() => {
    const apId = chat.selected()?.ap_id;
    const count = chat.messages().length;
    void count;
    const smooth = prevApId === apId;
    prevApId = apId;
    requestAnimationFrame(() => scrollToBottom(smooth));
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
              <div class="p-talk-chat-main" ref={(el) => (scrollRef = el)}>
                <ul class="p-talk-chat-main__ul">
                  <Show
                    when={!chat.messagesLoading()}
                    fallback={<li class="p-home-empty">読み込み中...</li>}
                  >
                    <For
                      each={chat.messages()}
                      fallback={
                        <li class="p-talk-chat-empty-row">
                          まだメッセージがありません。あいさつを送ってみましょう。
                        </li>
                      }
                    >
                      {(message, index) => {
                        const messages = chat.messages();
                        const prev = messages[index() - 1];
                        const showDay =
                          index() === 0 ||
                          !sameDay(message.created_at, prev.created_at);
                        const mine = message.sender.ap_id === app.actor().ap_id;
                        const primary =
                          showDay ||
                          prev?.sender.ap_id !== message.sender.ap_id;
                        return (
                          <>
                            <Show when={showDay}>
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
                                primary,
                                subsequent: !primary,
                              }}
                            >
                              <div class="c-talk-chat-box">
                                <Show when={!mine && primary}>
                                  <A
                                    class="c-talk-chat-icon"
                                    href={profilePath(message.sender.ap_id)}
                                  >
                                    <Avatar value={message.sender} />
                                  </A>
                                </Show>
                                <Show when={mine}>
                                  <div class="c-talk-chat-date">
                                    <p>{formatTime(message.created_at)}</p>
                                  </div>
                                </Show>
                                <div class="c-talk-chat-right">
                                  <Show when={!mine && primary}>
                                    <A
                                      class="c-talk-chat-name"
                                      href={profilePath(message.sender.ap_id)}
                                    >
                                      <p>{titleFor(message.sender)}</p>
                                    </A>
                                  </Show>
                                  <div class="c-talk-chat-msg">
                                    <p>{message.content}</p>
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
              <div class="p-talk-chat-send">
                <form
                  class="p-talk-chat-send__form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
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
                            !event.isComposing
                          ) {
                            event.preventDefault();
                            void send();
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
