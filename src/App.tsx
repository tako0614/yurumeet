import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import {
  type Actor,
  type ActorStories,
  type CommunityMessage,
  type DMContact,
  type DMMessage,
  type Post,
  type Story,
  createPost,
  fetchCommunityMessages,
  fetchCurrentActor,
  fetchDMContacts,
  fetchSocialServerDiscovery,
  fetchStories,
  fetchTimeline,
  fetchUserDMMessages,
  likeStory,
  likePost,
  markStoryViewed,
  sendCommunityMessage,
  sendUserDMMessage,
  shareStory,
  unlikeStory,
  unlikePost,
} from "@takosjp/yurucommu-api";
import {
  clearYurumeetServerOrigin,
  configureYurumeetServerOrigin,
  normalizeServerOrigin,
  readYurumeetServerOrigin,
  saveYurumeetServerOrigin,
  serverUrl,
} from "./server-config.ts";

type AppTab = "home" | "talk" | "voom";
type ChatMessage = DMMessage | CommunityMessage;

const demoActor: Actor = {
  ap_id: "https://demo.yurucommu.local/ap/users/me",
  username: "me@demo.yurucommu.local",
  preferred_username: "me",
  name: "Minato",
  summary: null,
  icon_url: null,
  header_url: null,
  follower_count: 128,
  following_count: 74,
  post_count: 42,
  created_at: "2026-07-04T09:00:00.000Z",
};

const demoContacts: DMContact[] = [
  {
    type: "user",
    ap_id: "https://demo.yurucommu.local/ap/users/aoi",
    username: "aoi@demo.yurucommu.local",
    preferred_username: "aoi",
    name: "Aoi",
    icon_url: null,
    last_message: { content: "あとで写真送るね", is_mine: false },
    last_message_at: "2026-07-04T17:42:00.000Z",
    unread_count: 2,
  },
  {
    type: "community",
    ap_id: "https://demo.yurucommu.local/ap/groups/kissa-builders",
    username: "kissa-builders@demo.yurucommu.local",
    preferred_username: "kissa-builders",
    name: "喫茶づくり",
    icon_url: null,
    member_count: 12,
    last_message: {
      content: "週末のメニュー、これで行きましょう",
      is_mine: true,
    },
    last_message_at: "2026-07-04T16:12:00.000Z",
    unread_count: 0,
  },
  {
    type: "user",
    ap_id: "https://demo.yurucommu.local/ap/users/rin",
    username: "rin@demo.yurucommu.local",
    preferred_username: "rin",
    name: "Rin",
    icon_url: null,
    last_message: {
      content: "VOOMに載せたメニュー見た。あれ良い。",
      is_mine: false,
    },
    last_message_at: "2026-07-04T13:28:00.000Z",
    unread_count: 0,
  },
];

const demoMessages: Record<string, ChatMessage[]> = {
  "https://demo.yurucommu.local/ap/users/aoi": [
    {
      id: "demo-aoi-1",
      sender: {
        ap_id: "https://demo.yurucommu.local/ap/users/aoi",
        username: "aoi@demo.yurucommu.local",
        preferred_username: "aoi",
        name: "Aoi",
        icon_url: null,
      },
      content: "今日のYurumeet見た?",
      created_at: "2026-07-04T17:31:00.000Z",
    },
    {
      id: "demo-aoi-2",
      sender: demoActor,
      content: "まずTakosUIのトーク画面をそのまま使う感じに戻す。",
      created_at: "2026-07-04T17:34:00.000Z",
    },
    {
      id: "demo-aoi-3",
      sender: {
        ap_id: "https://demo.yurucommu.local/ap/users/aoi",
        username: "aoi@demo.yurucommu.local",
        preferred_username: "aoi",
        name: "Aoi",
        icon_url: null,
      },
      content: "それでいい。変に別UI作らなくていい。",
      created_at: "2026-07-04T17:42:00.000Z",
    },
  ],
  "https://demo.yurucommu.local/ap/groups/kissa-builders": [
    {
      id: "demo-kissa-1",
      sender: {
        ap_id: "https://demo.yurucommu.local/ap/users/rin",
        username: "rin@demo.yurucommu.local",
        preferred_username: "rin",
        name: "Rin",
        icon_url: null,
      },
      content: "週末のメニュー、これで行きましょう",
      created_at: "2026-07-04T16:12:00.000Z",
    },
  ],
  "https://demo.yurucommu.local/ap/users/rin": [
    {
      id: "demo-rin-1",
      sender: {
        ap_id: "https://demo.yurucommu.local/ap/users/rin",
        username: "rin@demo.yurucommu.local",
        preferred_username: "rin",
        name: "Rin",
        icon_url: null,
      },
      content: "VOOMに載せたメニュー見た。あれ良い。",
      created_at: "2026-07-04T13:28:00.000Z",
    },
  ],
};

const demoStories: ActorStories[] = [
  {
    actor: demoActor,
    has_unviewed: false,
    stories: [
      {
        ap_id: "demo-story-me",
        author: demoActor,
        attachment: {
          type: "Document",
          mediaType: "image/jpeg",
          url: "",
          r2_key: "demo-story-me.jpg",
        },
        caption: "TakosUIから作り直し",
        displayDuration: "PT5S",
        published: "2026-07-04T17:05:00.000Z",
        end_time: "2026-07-05T17:05:00.000Z",
        viewed: true,
        liked: false,
        like_count: 4,
        share_count: 1,
      },
    ],
  },
  {
    actor: {
      ap_id: "https://demo.yurucommu.local/ap/users/aoi",
      username: "aoi@demo.yurucommu.local",
      preferred_username: "aoi",
      name: "Aoi",
      icon_url: null,
    },
    has_unviewed: true,
    stories: [
      {
        ap_id: "demo-story-aoi",
        author: {
          ap_id: "https://demo.yurucommu.local/ap/users/aoi",
          username: "aoi@demo.yurucommu.local",
          preferred_username: "aoi",
          name: "Aoi",
          icon_url: null,
        },
        attachment: {
          type: "Document",
          mediaType: "image/jpeg",
          url: "",
          r2_key: "demo-story-aoi.jpg",
        },
        caption: "喫茶の準備中",
        displayDuration: "PT5S",
        published: "2026-07-04T16:21:00.000Z",
        end_time: "2026-07-05T16:21:00.000Z",
        viewed: false,
        liked: false,
        like_count: 8,
        share_count: 2,
      },
    ],
  },
];

const demoPosts: Post[] = [
  {
    ap_id: "demo-post-1",
    type: "Note",
    author: {
      ap_id: "https://demo.yurucommu.local/ap/users/aoi",
      username: "aoi@demo.yurucommu.local",
      preferred_username: "aoi",
      name: "Aoi",
      icon_url: null,
    },
    content: "YurumeetのVOOMは、同じyurucommuの投稿をTakosUIの空気で見せる。",
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 18,
    reply_count: 4,
    announce_count: 2,
    published: "2026-07-04T16:58:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  },
  {
    ap_id: "demo-post-2",
    type: "Note",
    author: {
      ap_id: "https://demo.yurucommu.local/ap/groups/kissa-builders",
      username: "kissa-builders@demo.yurucommu.local",
      preferred_username: "kissa-builders",
      name: "喫茶づくり",
      icon_url: null,
    },
    content: "週末は小さく集まります。参加する人はトークで教えてください。",
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "unlisted",
    community_ap_id: "https://demo.yurucommu.local/ap/groups/kissa-builders",
    like_count: 24,
    reply_count: 7,
    announce_count: 0,
    published: "2026-07-04T15:24:00.000Z",
    edited_at: null,
    liked: true,
    bookmarked: true,
    reposted: false,
  },
];

function titleFor(value: {
  name?: string | null;
  preferred_username?: string;
  username?: string;
}): string {
  return value.name || value.preferred_username || value.username || "Yurumeet";
}

function initialFor(value: {
  name?: string | null;
  preferred_username?: string;
  username?: string;
}): string {
  return titleFor(value).slice(0, 1).toUpperCase() || "Y";
}

function contactSubtitle(contact: DMContact): string {
  if (contact.type === "community") {
    return contact.member_count ? `${contact.member_count} members` : "Group";
  }
  return contact.username.startsWith("@")
    ? contact.username
    : `@${contact.preferred_username}`;
}

function actorHandle(value: {
  preferred_username?: string;
  username?: string;
}) {
  const handle = value.preferred_username || value.username || "user";
  return handle.startsWith("@") ? handle : `@${handle}`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function shouldOpenInitialTalkPane(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(min-width: 769px)").matches
  );
}

function stripHtml(value: string): string {
  if (typeof document === "undefined") return value.replace(/<[^>]*>/g, " ");
  const el = document.createElement("div");
  el.innerHTML = value;
  return el.textContent || el.innerText || "";
}

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

function AppIcon(props: { tab: AppTab }) {
  if (props.tab === "home") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 10.182V22h18V10.182L12 2z" />
        <rect width="6" height="8" x="9" y="14" />
      </svg>
    );
  }
  if (props.tab === "talk") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8.824 18.588 4 21l.653-4.573C3.006 15.001 2 13.095 2 11 2 6.582 6.477 3 12 3s10 3.582 10 8-4.477 8-10 8c-1.11 0-2.178-.145-3.176-.412Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function Header(props: {
  tab: AppTab;
  hideOnMobile?: boolean;
  onTab: (tab: AppTab) => void;
}) {
  const tabs: { id: AppTab; label: string }[] = [
    { id: "home", label: "ホーム" },
    { id: "talk", label: "トーク" },
    { id: "voom", label: "VOOM" },
  ];
  return (
    <header classList={{ "l-header": true, "is-inview": props.hideOnMobile }}>
      <div class="l-header-logo">
        <button
          type="button"
          onClick={() => props.onTab("home")}
          aria-label="Yurumeet"
        >
          <span>Yurumeet</span>
        </button>
      </div>
      <ul class="l-header__ul">
        <For each={tabs}>
          {(tab) => (
            <li
              classList={{
                "l-header__ul-item": true,
                "is-active": props.tab === tab.id,
              }}
            >
              <button
                type="button"
                onClick={() => props.onTab(tab.id)}
                aria-label={tab.label}
              >
                <AppIcon tab={tab.id} />
                <span>{tab.label}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </header>
  );
}

function Avatar(props: {
  value: {
    name?: string | null;
    preferred_username?: string;
    username?: string;
    icon_url?: string | null;
  };
}) {
  return (
    <span class="yc-avatar" aria-hidden="true">
      <Show when={props.value.icon_url} fallback={initialFor(props.value)}>
        {(src) => <img src={src()} alt="" />}
      </Show>
    </span>
  );
}

function StoryRow(props: {
  stories: ActorStories[];
  onOpen: (story: Story) => void;
}) {
  return (
    <div class="p-home-stories">
      <For each={props.stories}>
        {(group) => (
          <button
            type="button"
            classList={{ "c-story": true, "is-new": group.has_unviewed }}
            onClick={() => props.onOpen(group.stories[0])}
          >
            <Avatar value={group.actor} />
            <span>{titleFor(group.actor)}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function HomeView(props: {
  actor: Actor;
  contacts: DMContact[];
  stories: ActorStories[];
  onTalk: (contact: DMContact) => void;
  onStory: (story: Story) => void;
}) {
  const people = () =>
    props.contacts.filter((contact) => contact.type === "user");
  const groups = () =>
    props.contacts.filter((contact) => contact.type === "community");
  return (
    <main class="p-home">
      <section class="p-home-profile">
        <Avatar value={props.actor} />
        <div>
          <p>Yurumeet</p>
          <h1>{titleFor(props.actor)}</h1>
          <span>{props.actor.username}</span>
        </div>
      </section>
      <StoryRow stories={props.stories} onOpen={props.onStory} />
      <section class="p-home-section">
        <h2>友だち</h2>
        <ul>
          <For
            each={people()}
            fallback={<li class="p-home-empty">まだ友だちはありません</li>}
          >
            {(contact) => (
              <li>
                <button type="button" onClick={() => props.onTalk(contact)}>
                  <Avatar value={contact} />
                  <span>{titleFor(contact)}</span>
                  <small>{contactSubtitle(contact)}</small>
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
      <section class="p-home-section">
        <h2>グループ</h2>
        <ul>
          <For
            each={groups()}
            fallback={
              <li class="p-home-empty">参加中のグループはありません</li>
            }
          >
            {(contact) => (
              <li>
                <button type="button" onClick={() => props.onTalk(contact)}>
                  <Avatar value={contact} />
                  <span>{titleFor(contact)}</span>
                  <small>{contactSubtitle(contact)}</small>
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
    </main>
  );
}

function TalkView(props: {
  actor: Actor;
  contacts: DMContact[];
  selected: DMContact | null;
  messages: ChatMessage[];
  loading: boolean;
  onSelect: (contact: DMContact) => void;
  onBack: () => void;
  onSend: (content: string) => Promise<void>;
}) {
  const [query, setQuery] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const contacts = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return props.contacts;
    return props.contacts.filter((contact) =>
      `${titleFor(contact)} ${contact.username} ${contact.last_message?.content ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  });
  const send = async () => {
    const content = draft().trim();
    if (!content) return;
    await props.onSend(content);
    setDraft("");
  };

  return (
    <main classList={{ "p-talk": true, "is-inview": !!props.selected }}>
      <div class="p-talk-list">
        <h1 class="p-talk-list-title">トーク</h1>
        <div class="p-talk-list-search">
          <label>
            <input
              name="talkSearch"
              type="text"
              placeholder="トークルーム・メッセージを検索"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>
        <div class="p-talk-list-rooms">
          <ul class="p-talk-list-rooms__ul">
            <For
              each={contacts()}
              fallback={<li class="p-home-empty">まだトークはありません</li>}
            >
              {(contact) => (
                <li
                  classList={{
                    "c-talk-rooms": true,
                    "is-active": props.selected?.ap_id === contact.ap_id,
                  }}
                >
                  <button type="button" onClick={() => props.onSelect(contact)}>
                    <span class="c-talk-rooms-icon">
                      <Avatar value={contact} />
                    </span>
                    <span class="c-talk-rooms-box">
                      <span class="c-talk-rooms-name">
                        <span>{titleFor(contact)}</span>
                      </span>
                      <span class="c-talk-rooms-msg">
                        <span>
                          {contact.last_message?.content ||
                            contactSubtitle(contact)}
                        </span>
                      </span>
                    </span>
                    <Show when={(contact.unread_count ?? 0) > 0}>
                      <span class="c-talk-rooms-badge">
                        {contact.unread_count}
                      </span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>

      <div class="p-talk-chat">
        <div class="p-talk-chat-container">
          <Show
            when={props.selected}
            fallback={
              <div class="p-talk-chat-empty">
                <p>トークを選択</p>
              </div>
            }
          >
            {(contact) => (
              <>
                <div class="p-talk-chat-title">
                  <button
                    class="p-talk-chat-prev"
                    type="button"
                    onClick={props.onBack}
                    aria-label="戻る"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <polyline points="14 18 8 12 14 6 14 6" />
                    </svg>
                  </button>
                  <p>{titleFor(contact())}</p>
                </div>
                <div class="p-talk-chat-main">
                  <ul class="p-talk-chat-main__ul">
                    <li class="c-talk-date">
                      <div class="c-talk-chat-date-box">
                        <p>今日</p>
                      </div>
                    </li>
                    <Show
                      when={!props.loading}
                      fallback={<li class="p-home-empty">読み込み中...</li>}
                    >
                      <For each={props.messages}>
                        {(message, index) => {
                          const mine =
                            message.sender.ap_id === props.actor.ap_id;
                          return (
                            <li
                              classList={{
                                "c-talk-chat": true,
                                self: mine,
                                other: !mine,
                                primary:
                                  index() === 0 ||
                                  props.messages[index() - 1]?.sender.ap_id !==
                                    message.sender.ap_id,
                                subsequent:
                                  index() > 0 &&
                                  props.messages[index() - 1]?.sender.ap_id ===
                                    message.sender.ap_id,
                              }}
                            >
                              <div class="c-talk-chat-box">
                                <Show
                                  when={
                                    !mine &&
                                    (index() === 0 ||
                                      props.messages[index() - 1]?.sender
                                        .ap_id !== message.sender.ap_id)
                                  }
                                >
                                  <div class="c-talk-chat-icon">
                                    <Avatar value={message.sender} />
                                  </div>
                                </Show>
                                <Show when={mine}>
                                  <div class="c-talk-chat-date">
                                    <p>{formatTime(message.created_at)}</p>
                                  </div>
                                </Show>
                                <div class="c-talk-chat-right">
                                  <Show
                                    when={
                                      !mine &&
                                      (index() === 0 ||
                                        props.messages[index() - 1]?.sender
                                          .ap_id !== message.sender.ap_id)
                                    }
                                  >
                                    <div class="c-talk-chat-name">
                                      <p>{titleFor(message.sender)}</p>
                                    </div>
                                  </Show>
                                  <div class="c-talk-chat-msg">
                                    <p>{message.content}</p>
                                  </div>
                                </div>
                                <Show when={!mine}>
                                  <div class="c-talk-chat-date">
                                    <p>{formatTime(message.created_at)}</p>
                                  </div>
                                </Show>
                              </div>
                            </li>
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
                        {draft() + "\u200b"}
                      </div>
                      <label>
                        <textarea
                          class="p-talk-chat-send__textarea"
                          name="message"
                          placeholder="メッセージを入力"
                          value={draft()}
                          onInput={(event) =>
                            setDraft(event.currentTarget.value)
                          }
                        />
                      </label>
                    </div>
                    <button
                      class="p-talk-chat-send__file"
                      type="submit"
                      aria-label="送信"
                    >
                      <span aria-hidden="true"></span>
                    </button>
                  </form>
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
    </main>
  );
}

function VoomView(props: {
  actor: Actor;
  posts: Post[];
  stories: ActorStories[];
  onStory: (story: Story) => void;
  onPost: (content: string) => Promise<void>;
  onLike: (post: Post) => Promise<void>;
}) {
  const [draft, setDraft] = createSignal("");
  const submit = async () => {
    const content = draft().trim();
    if (!content) return;
    await props.onPost(content);
    setDraft("");
  };
  return (
    <main class="p-voom">
      <h1 class="p-talk-list-title">VOOM</h1>
      <StoryRow stories={props.stories} onOpen={props.onStory} />
      <form
        class="p-voom-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Avatar value={props.actor} />
        <textarea
          name="post"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          placeholder="いま共有したいこと"
        />
        <button type="submit">投稿</button>
      </form>
      <div class="p-voom-feed">
        <For
          each={props.posts}
          fallback={<p class="p-home-empty">まだ投稿はありません</p>}
        >
          {(post) => (
            <article class="c-voom-post">
              <header>
                <Avatar value={post.author} />
                <div>
                  <strong>{titleFor(post.author)}</strong>
                  <span>{actorHandle(post.author)}</span>
                </div>
              </header>
              <p>{stripHtml(post.content)}</p>
              <footer>
                <button
                  type="button"
                  classList={{ "is-active": post.liked }}
                  onClick={() => void props.onLike(post)}
                >
                  いいね {post.like_count || ""}
                </button>
                <span>コメント {post.reply_count || ""}</span>
                <span>シェア {post.announce_count || ""}</span>
              </footer>
            </article>
          )}
        </For>
      </div>
    </main>
  );
}

function StoryModal(props: {
  story: Story | null;
  onClose: () => void;
  onLike?: (story: Story) => Promise<void>;
  onShare?: (story: Story) => Promise<void>;
}) {
  return (
    <Show when={props.story}>
      {(story) => (
        <div class="p-story-modal" role="dialog" aria-modal="true">
          <section>
            <button
              class="p-story-close"
              type="button"
              onClick={props.onClose}
              aria-label="閉じる"
            >
              x
            </button>
            <div class="p-story-card">
              <Show
                when={story().attachment.url}
                fallback={<strong>{story().caption || "Story"}</strong>}
              >
                {(src) => <img src={src()} alt="" />}
              </Show>
            </div>
            <p>{story().caption}</p>
            <div class="p-story-actions">
              <button
                type="button"
                classList={{ "is-active": !!story().liked }}
                onClick={() => void props.onLike?.(story())}
              >
                いいね {story().like_count || ""}
              </button>
              <button
                type="button"
                onClick={() => void props.onShare?.(story())}
              >
                シェア {story().share_count || ""}
              </button>
            </div>
          </section>
        </div>
      )}
    </Show>
  );
}

function ServerConnect(props: { onConnect: (origin: string) => void }) {
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const connect = () => {
    const origin = normalizeServerOrigin(value());
    if (!origin) {
      setError("yurucommu-server の URL を入力してください。");
      return;
    }
    saveYurumeetServerOrigin(origin);
    configureYurumeetServerOrigin(origin);
    props.onConnect(origin);
  };
  return (
    <main class="p-connect">
      <section>
        <div class="l-header-logo connect-logo">
          <span>Y</span>
        </div>
        <h1>Yurumeet</h1>
        <p>
          yurucommu-server を TakosUI ベースのホーム / トーク / VOOM で使う。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <input
            value={value()}
            onInput={(event) => setValue(event.currentTarget.value)}
            placeholder="https://your-yurucommu.example"
          />
          <button type="submit">接続</button>
        </form>
        <Show when={error()}>
          {(message) => <p class="p-connect-error">{message()}</p>}
        </Show>
      </section>
    </main>
  );
}

function SignedOut(props: { origin: string }) {
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  const login = async () => {
    const value = password().trim();
    if (!value) {
      setError("パスワードを入力してください。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(serverUrl(props.origin, "/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: value }),
      });
      if (!response.ok) {
        setError("ログインできませんでした。");
        return;
      }
      window.location.reload();
    } catch {
      setError("ログインできませんでした。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main class="p-connect">
      <section>
        <h1>サインイン</h1>
        <p>この yurucommu-server のアカウントで Yurumeet を開きます。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void login();
          }}
        >
          <input
            type="password"
            value={password()}
            onInput={(event) => setPassword(event.currentTarget.value)}
            placeholder="パスワード"
            autocomplete="current-password"
          />
          <button type="submit" disabled={submitting()}>
            {submitting() ? "ログイン中" : "ログイン"}
          </button>
        </form>
        <Show when={error()}>
          {(message) => <p class="p-connect-error">{message()}</p>}
        </Show>
      </section>
    </main>
  );
}

function DemoApp() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = createSignal<AppTab>(
    (searchParams.tab as AppTab) || "talk",
  );
  const [contacts] = createSignal(demoContacts);
  const initialContact = () => {
    const c = searchParams.c;
    if (typeof c === "string" && c) {
      return (
        demoContacts.find((contact) => contact.ap_id === c) ??
        demoContacts[0] ??
        null
      );
    }
    return tab() === "talk" && shouldOpenInitialTalkPane()
      ? demoContacts[0]
      : null;
  };
  const [selected, setSelected] = createSignal<DMContact | null>(
    initialContact(),
  );
  const [messages, setMessages] = createSignal<ChatMessage[]>(
    demoMessages[initialContact()?.ap_id ?? ""] ?? [],
  );
  const [posts, setPosts] = createSignal<Post[]>(demoPosts);
  const [story, setStory] = createSignal<Story | null>(null);

  const setStoryLike = async (target: Story) => {
    setStory({
      ...target,
      liked: !target.liked,
      like_count: (target.like_count ?? 0) + (target.liked ? -1 : 1),
    });
  };

  const setStoryShare = async (target: Story) => {
    setStory({
      ...target,
      share_count: (target.share_count ?? 0) + 1,
    });
  };

  const openTalk = (contact: DMContact) => {
    setTab("talk");
    setSelected(contact);
    setMessages(demoMessages[contact.ap_id] ?? []);
  };

  const send = async (content: string) => {
    const contact = selected();
    if (!contact) return;
    setMessages((current) => [
      ...current,
      {
        id: `demo-${Date.now()}`,
        sender: demoActor,
        content,
        created_at: new Date().toISOString(),
      },
    ]);
  };

  const post = async (content: string) => {
    setPosts((current) => [
      {
        ...demoPosts[0],
        ap_id: `demo-${Date.now()}`,
        author: demoActor,
        content,
        published: new Date().toISOString(),
        like_count: 0,
        liked: false,
      },
      ...current,
    ]);
  };

  return (
    <>
      <Header
        tab={tab()}
        hideOnMobile={tab() === "talk" && !!selected()}
        onTab={setTab}
      />
      <div class="wrapper">
        <Show when={tab() === "home"}>
          <HomeView
            actor={demoActor}
            contacts={contacts()}
            stories={demoStories}
            onTalk={openTalk}
            onStory={setStory}
          />
        </Show>
        <Show when={tab() === "talk"}>
          <TalkView
            actor={demoActor}
            contacts={contacts()}
            selected={selected()}
            messages={messages()}
            loading={false}
            onSelect={openTalk}
            onBack={() => setSelected(null)}
            onSend={send}
          />
        </Show>
        <Show when={tab() === "voom"}>
          <VoomView
            actor={demoActor}
            posts={posts()}
            stories={demoStories}
            onStory={setStory}
            onPost={post}
            onLike={async (target) => {
              setPosts((current) =>
                current.map((item) =>
                  item.ap_id === target.ap_id
                    ? {
                        ...item,
                        liked: !item.liked,
                        like_count: item.like_count + (item.liked ? -1 : 1),
                      }
                    : item,
                ),
              );
            }}
          />
        </Show>
      </div>
      <StoryModal
        story={story()}
        onClose={() => setStory(null)}
        onLike={setStoryLike}
        onShare={setStoryShare}
      />
    </>
  );
}

export default function App() {
  const [searchParams] = useSearchParams();
  if (searchParams.demo === "1") return <DemoApp />;

  const initialServerOrigin = readYurumeetServerOrigin();
  if (initialServerOrigin) configureYurumeetServerOrigin(initialServerOrigin);

  const navigate = useNavigate();
  const [tab, setTab] = createSignal<AppTab>(
    (searchParams.tab as AppTab) || "talk",
  );
  const [serverOrigin, setServerOrigin] = createSignal<string | null>(
    initialServerOrigin,
  );
  const [actor, { refetch: refetchActor }] = createResource(
    serverOrigin,
    fetchCurrentActor,
  );
  const authedOrigin = createMemo(() =>
    serverOrigin() && actor() ? serverOrigin() : null,
  );
  const [discovery, { refetch: refetchDiscovery }] = createResource(
    serverOrigin,
    fetchSocialServerDiscovery,
  );
  const [contacts, { refetch: refetchContacts }] = createResource(
    authedOrigin,
    loadContacts,
  );
  const [timeline, { refetch: refetchTimeline }] = createResource(
    authedOrigin,
    () => fetchTimeline({ limit: 30 }),
  );
  const [stories, { refetch: refetchStories }] = createResource(
    authedOrigin,
    () => fetchStories(),
  );
  const [selected, setSelected] = createSignal<DMContact | null>(null);
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = createSignal(false);
  const [story, setStory] = createSignal<Story | null>(null);
  const [didAutoSelectContact, setDidAutoSelectContact] = createSignal(false);

  const connectServer = (origin: string) => {
    setServerOrigin(origin);
    void refetchActor();
    void refetchDiscovery();
  };

  createEffect(
    on(selected, async (contact) => {
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
    }),
  );

  createEffect(() => {
    if (
      didAutoSelectContact() ||
      tab() !== "talk" ||
      selected() ||
      !shouldOpenInitialTalkPane()
    ) {
      return;
    }
    const firstContact = contacts()?.[0];
    if (!firstContact) return;
    setDidAutoSelectContact(true);
    setSelected(firstContact);
  });

  const openTalk = (contact: DMContact) => {
    setTab("talk");
    setSelected(contact);
  };

  const openStory = (selectedStory: Story) => {
    setStory(selectedStory);
    if (!selectedStory.viewed) {
      void markStoryViewed(selectedStory.ap_id)
        .then(() => refetchStories())
        .catch(() => undefined);
    }
  };

  const send = async (content: string) => {
    const contact = selected();
    if (!contact) return;
    if (contact.type === "community")
      await sendCommunityMessage(contact.ap_id, content);
    else await sendUserDMMessage(contact.ap_id, content);
    setMessages(await loadMessages(contact));
    await refetchContacts();
  };

  return (
    <Show
      when={serverOrigin()}
      fallback={<ServerConnect onConnect={connectServer} />}
    >
      {(origin) => (
        <Show when={actor()} fallback={<SignedOut origin={origin()} />}>
          {(currentActor) => (
            <>
              <Header
                tab={tab()}
                hideOnMobile={tab() === "talk" && !!selected()}
                onTab={(nextTab) => {
                  setTab(nextTab);
                  navigate(`/?tab=${nextTab}`, { replace: true });
                }}
              />
              <div class="wrapper">
                <Show when={tab() === "home"}>
                  <HomeView
                    actor={currentActor()}
                    contacts={contacts() ?? []}
                    stories={stories() ?? []}
                    onTalk={openTalk}
                    onStory={openStory}
                  />
                </Show>
                <Show when={tab() === "talk"}>
                  <TalkView
                    actor={currentActor()}
                    contacts={contacts() ?? []}
                    selected={selected()}
                    messages={messages()}
                    loading={messagesLoading() || contacts.loading}
                    onSelect={openTalk}
                    onBack={() => setSelected(null)}
                    onSend={send}
                  />
                </Show>
                <Show when={tab() === "voom"}>
                  <VoomView
                    actor={currentActor()}
                    posts={timeline()?.posts ?? []}
                    stories={stories() ?? []}
                    onStory={openStory}
                    onPost={async (content) => {
                      await createPost({ content, visibility: "public" });
                      await refetchTimeline();
                    }}
                    onLike={async (post) => {
                      if (post.liked) await unlikePost(post.ap_id);
                      else await likePost(post.ap_id);
                      await refetchTimeline();
                    }}
                  />
                </Show>
              </div>
              <button
                type="button"
                class="server-switch"
                onClick={() => {
                  clearYurumeetServerOrigin();
                  setServerOrigin(null);
                }}
              >
                {discovery()?.server.name ?? "Yurucommu Server"}
              </button>
              <StoryModal
                story={story()}
                onClose={() => setStory(null)}
                onLike={async (target) => {
                  const result = target.liked
                    ? await unlikeStory(target.ap_id)
                    : await likeStory(target.ap_id);
                  setStory({
                    ...target,
                    liked: result.liked,
                    like_count: result.like_count,
                  });
                  await refetchStories();
                }}
                onShare={async (target) => {
                  const result = await shareStory(target.ap_id);
                  setStory({
                    ...target,
                    share_count: result.share_count,
                  });
                  await refetchStories();
                }}
              />
            </>
          )}
        </Show>
      )}
    </Show>
  );
}
