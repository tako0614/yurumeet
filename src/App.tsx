import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import {
  type Actor,
  type ActorNote,
  type ActorStories,
  type CommunityDetail,
  type DMContact,
  type DMRequest,
  type Post,
  type Story,
  archiveDMConversation,
  createCommunity,
  createNote,
  createStory,
  deleteMyNote,
  deleteStory,
  fetchArchivedDMConversations,
  fetchCommunities,
  fetchDMContact,
  fetchDMRequests,
  fetchNotes,
  fetchStories,
  fetchTimeline,
  joinCommunity,
  rejectDMRequest,
  unarchiveDMConversation,
  likeStory,
  markStoryViewed,
  shareStory,
  unlikeStory,
  uploadMedia,
} from "@takosjp/yurucommu-api";
import { useApp } from "./lib/app-context.tsx";
import { useChat } from "./lib/chat-context.tsx";
import { DialogA11y } from "./lib/dialog.tsx";
import {
  ComposeFab,
  PostComposer,
} from "./components/timeline/PostComposer.tsx";
import { PostCard } from "./components/timeline/PostCard.tsx";
import {
  actorHandle,
  attachmentSrc,
  communityPath,
  contactSubtitle,
  formatListTime,
  formatNoteExpiry,
  formatPostTime,
  profilePath,
  titleFor,
  UserAvatar as Avatar,
} from "./lib/ui.tsx";
import { StoryBar } from "./components/story/StoryBar.tsx";

type AppTab = "home" | "talk" | "timeline";
const MAX_NOTE_LENGTH = 80;

function normalizeTab(value: unknown): AppTab {
  if (value === "yurucommu") return "timeline";
  return value === "home" || value === "talk" || value === "timeline"
    ? value
    : "talk";
}

function parseStoryDuration(value: string | null | undefined): number {
  if (!value) return 5000;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return 5000;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  return Math.min(Math.max(ms || 5000, 2500), 15000);
}

function mediaSrc(story: Story, origin?: string | null): string | undefined {
  return attachmentSrc(story.attachment, origin);
}

function contactMatchesQuery(contact: DMContact, needle: string): boolean {
  if (!needle) return true;
  return `${titleFor(contact)} ${contact.username} ${contact.last_message?.content ?? ""}`
    .toLowerCase()
    .includes(needle);
}

function ContactRowSkeleton() {
  return (
    <li class="p-home-row-skeleton" aria-hidden="true">
      <span class="p-home-row-skeleton-avatar" />
      <span class="p-home-row-skeleton-lines">
        <span />
        <span />
      </span>
    </li>
  );
}

function GroupMembersMeta(props: { count: number }) {
  return (
    <span class="p-home-contact-meta" title={`${props.count} 人のメンバー`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M16 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" />
        <circle cx="12" cy="9" r="3" />
        <path d="M20 19c0-1.7-1-3.2-2.5-3.8M17 9.2a3 3 0 0 0 0-5.4" />
      </svg>
      {props.count}
    </span>
  );
}

function HomeView(props: {
  actor: Actor;
  contacts: DMContact[];
  contactsLoading: boolean;
  notes: ActorNote[];
  notesLoading: boolean;
  onTalk: (contact: DMContact) => void;
  onSaveNote: (content: string) => Promise<void>;
  onDeleteNote: () => Promise<void>;
}) {
  const app = useApp();
  const chat = useChat();
  const navigate = useNavigate();
  const [query, setQuery] = createSignal("");
  const needle = () => query().trim().toLowerCase();
  const people = () =>
    props.contacts.filter(
      (contact) =>
        contact.type === "user" && contactMatchesQuery(contact, needle()),
    );
  const groups = () =>
    props.contacts.filter(
      (contact) =>
        contact.type === "community" && contactMatchesQuery(contact, needle()),
    );
  const searching = () => needle().length > 0;

  const [allCommunities, { refetch: refetchCommunities }] =
    createResource(fetchCommunities);
  const [creating, setCreating] = createSignal(false);
  const [joiningId, setJoiningId] = createSignal<string | null>(null);
  const joinedIds = () =>
    new Set(
      props.contacts.filter((c) => c.type === "community").map((c) => c.ap_id),
    );
  const discoverable = () => {
    const joined = joinedIds();
    return (allCommunities() ?? []).filter(
      (c) =>
        !c.is_member &&
        !joined.has(c.ap_id) &&
        contactMatchesQuery(
          { name: c.display_name, username: c.name } as DMContact,
          needle(),
        ),
    );
  };

  const joinCommunityById = async (community: CommunityDetail) => {
    if (joiningId()) return;
    setJoiningId(community.ap_id);
    try {
      const { status } = await joinCommunity(community.ap_id);
      if (status === "joined") {
        app.toast(`${community.display_name} に参加しました`);
        await Promise.all([refetchCommunities(), chat.refetchContacts()]);
      } else if (status === "pending") {
        app.toast("参加リクエストを送りました");
        await refetchCommunities();
      } else {
        app.toast("招待が必要です");
      }
    } catch {
      app.toast("参加に失敗しました", "error");
    } finally {
      setJoiningId(null);
    }
  };

  const onCreated = async (community: CommunityDetail) => {
    await Promise.all([refetchCommunities(), chat.refetchContacts()]);
    navigate(communityPath(community.ap_id));
  };

  return (
    <section class="p-home">
      <A class="p-home-account" href="/profile">
        <Avatar value={props.actor} />
        <div class="p-home-account-main">
          <strong>{titleFor(props.actor)}</strong>
          <span>{actorHandle(props.actor)}</span>
        </div>
        <svg
          class="p-home-account-chevron"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </A>
      <label class="p-home-search">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m16 16 5 5" />
        </svg>
        <input
          type="search"
          name="homeSearch"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="友だち・グループを検索"
          aria-label="友だち・グループを検索"
        />
      </label>
      <HomeNoteBar
        actor={props.actor}
        notes={props.notes}
        loading={props.notesLoading}
        onSave={props.onSaveNote}
        onDelete={props.onDeleteNote}
      />
      <section class="p-home-section">
        <div class="p-home-section-head">
          <h2>友だち</h2>
          <span>{people().length}</span>
        </div>
        <ul>
          <Show
            when={!props.contactsLoading}
            fallback={
              <>
                <ContactRowSkeleton />
                <ContactRowSkeleton />
              </>
            }
          >
            <For
              each={people()}
              fallback={
                <li class="p-home-empty">
                  <Show
                    when={!searching()}
                    fallback={<>一致する友だちはいません</>}
                  >
                    まだ友だちはいません
                    <A class="p-home-empty-cta" href="/?tab=timeline">
                      タイムラインで友だちを探す
                    </A>
                  </Show>
                </li>
              }
            >
              {(contact) => (
                <li>
                  <button type="button" onClick={() => props.onTalk(contact)}>
                    <Avatar value={contact} />
                    <span class="p-home-contact-main">
                      <strong>{titleFor(contact)}</strong>
                      <small>
                        {contact.last_message?.content ||
                          contactSubtitle(contact)}
                      </small>
                    </span>
                    <Show when={(contact.unread_count ?? 0) > 0}>
                      <em>{contact.unread_count}</em>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </Show>
        </ul>
      </section>
      <section class="p-home-section">
        <div class="p-home-section-head">
          <h2>グループ</h2>
          <span>{groups().length}</span>
          <button
            type="button"
            class="p-home-section-add"
            aria-label="グループを作成"
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
          </button>
        </div>
        <ul>
          <Show when={!props.contactsLoading} fallback={<ContactRowSkeleton />}>
            <For
              each={groups()}
              fallback={
                <li class="p-home-empty">
                  {searching()
                    ? "一致するグループはありません"
                    : "参加中のグループはありません"}
                </li>
              }
            >
              {(contact) => (
                <li>
                  <button type="button" onClick={() => props.onTalk(contact)}>
                    <Avatar value={contact} />
                    <span class="p-home-contact-main">
                      <strong>{titleFor(contact)}</strong>
                      <small>
                        {contact.last_message?.content ||
                          contactSubtitle(contact)}
                      </small>
                    </span>
                    <Show
                      when={(contact.unread_count ?? 0) > 0}
                      fallback={
                        <GroupMembersMeta count={contact.member_count ?? 0} />
                      }
                    >
                      <em>{contact.unread_count}</em>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </Show>
        </ul>
        <Show when={discoverable().length > 0}>
          <div class="p-home-subhead">見つける</div>
          <ul>
            <For each={discoverable()}>
              {(community) => (
                <li>
                  <A
                    href={communityPath(community.ap_id)}
                    class="p-home-discover-row"
                  >
                    <Avatar
                      value={{
                        name: community.display_name,
                        icon_url: community.icon_url,
                      }}
                    />
                    <span class="p-home-contact-main">
                      <strong>{community.display_name}</strong>
                      <small>
                        {community.summary ||
                          `${community.member_count} メンバー`}
                      </small>
                    </span>
                    <button
                      type="button"
                      class="p-home-join"
                      disabled={
                        joiningId() === community.ap_id ||
                        community.join_status === "pending"
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void joinCommunityById(community);
                      }}
                    >
                      {community.join_status === "pending"
                        ? "リクエスト済み"
                        : community.join_policy === "invite"
                          ? "招待制"
                          : "参加"}
                    </button>
                  </A>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <Show when={creating()}>
        <CommunityCreateModal
          onClose={() => setCreating(false)}
          onCreated={onCreated}
        />
      </Show>
    </section>
  );
}

function CommunityCreateModal(props: {
  onClose: () => void;
  onCreated: (community: CommunityDetail) => void | Promise<void>;
}) {
  const app = useApp();
  const [name, setName] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [summary, setSummary] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const slug = () =>
    name()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
  const canSave = () => slug().length > 0 && !saving();

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!canSave()) return;
    setSaving(true);
    try {
      const community = await createCommunity({
        name: slug(),
        display_name: displayName().trim() || undefined,
        summary: summary().trim() || undefined,
      });
      app.toast("グループを作成しました");
      props.onClose();
      await props.onCreated(community);
    } catch {
      app.toast("グループの作成に失敗しました", "error");
    } finally {
      setSaving(false);
    }
  };

  let dialogRoot: HTMLDivElement | undefined;
  return (
    <div
      class="p-composer"
      role="dialog"
      aria-modal="true"
      aria-label="グループを作成"
      ref={(el) => (dialogRoot = el)}
    >
      <DialogA11y root={() => dialogRoot} onClose={props.onClose} />
      <button
        type="button"
        class="p-composer-dismiss"
        aria-label="閉じる"
        onClick={props.onClose}
      />
      <form class="p-composer-panel" onSubmit={submit}>
        <div class="p-composer-head">
          <button
            type="button"
            class="p-composer-close"
            onClick={props.onClose}
            aria-label="閉じる"
          >
            <CloseIcon />
          </button>
          <strong>グループを作成</strong>
          <button type="submit" class="p-composer-submit" disabled={!canSave()}>
            {saving() ? "作成中" : "作成"}
          </button>
        </div>
        <div class="p-edit-body">
          <div class="p-edit-fields">
            <label class="p-edit-field">
              <span>ID (英数字)</span>
              <input
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="my_group"
                autofocus
              />
              <Show when={name().trim() && slug()}>
                <small class="p-edit-field-hint">@{slug()}</small>
              </Show>
            </label>
            <label class="p-edit-field">
              <span>表示名</span>
              <input
                type="text"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
                placeholder="マイグループ"
              />
            </label>
            <label class="p-edit-field">
              <span>説明</span>
              <textarea
                value={summary()}
                onInput={(e) => setSummary(e.currentTarget.value)}
                rows={3}
                placeholder="どんなグループ?"
              />
            </label>
          </div>
        </div>
      </form>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function HomeNoteTile(props: {
  actor: {
    name?: string | null;
    preferred_username?: string;
    username?: string;
    icon_url?: string | null;
  };
  content: string;
  add?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" class="p-home-note-tile" onClick={props.onClick}>
      <span class="p-home-note-bubble-slot">
        <span
          classList={{
            "p-home-note-bubble": true,
            "is-add": !!props.add,
          }}
        >
          <p>{props.content}</p>
          <span class="p-home-note-tail" aria-hidden="true" />
        </span>
      </span>
      <span class="p-home-note-avatar">
        <Avatar value={props.actor} />
        <Show when={props.add}>
          <span class="p-home-note-plus">
            <PlusIcon />
          </span>
        </Show>
      </span>
      <span class="p-home-note-name">{titleFor(props.actor)}</span>
    </button>
  );
}

function HomeNoteBar(props: {
  actor: Actor;
  notes: ActorNote[];
  loading: boolean;
  onSave: (content: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let noteDialogRoot: HTMLDivElement | undefined;
  const myNote = () =>
    props.notes.find(
      (note) => note.is_mine || note.actor.ap_id === props.actor.ap_id,
    );
  const otherNotes = () =>
    props.notes.filter((note) => note.actor.ap_id !== props.actor.ap_id);
  const canSave = () =>
    draft().trim().length > 0 &&
    draft().trim().length <= MAX_NOTE_LENGTH &&
    !saving();

  const openEditor = () => {
    setDraft(myNote()?.content ?? "");
    setError(null);
    setEditorOpen(true);
  };

  const save = async () => {
    const content = draft().trim();
    if (!canSave()) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSave(content);
      setEditorOpen(false);
    } catch (err) {
      console.error("Failed to save note:", err);
      setError("ノートの保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!myNote() || saving()) return;
    setSaving(true);
    setError(null);
    try {
      await props.onDelete();
      setEditorOpen(false);
    } catch (err) {
      console.error("Failed to delete note:", err);
      setError("ノートの削除に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="p-home-note-bar" aria-label="ノート">
      <Show
        when={!props.loading}
        fallback={
          <div class="p-home-note-scroll" aria-hidden="true">
            <span class="p-home-note-skeleton" />
            <span class="p-home-note-skeleton" />
            <span class="p-home-note-skeleton" />
          </div>
        }
      >
        <div class="p-home-note-scroll">
          <HomeNoteTile
            actor={props.actor}
            content={myNote()?.content ?? "ノートを書く"}
            add={!myNote()}
            onClick={openEditor}
          />
          <For each={otherNotes()}>
            {(note) => (
              <HomeNoteTile
                actor={note.actor}
                content={note.content}
                onClick={() => navigate(profilePath(note.actor.ap_id))}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={editorOpen()}>
        <div
          class="p-note-editor"
          role="dialog"
          aria-modal="true"
          aria-label="ノート"
          ref={(el) => (noteDialogRoot = el)}
        >
          <DialogA11y
            root={() => noteDialogRoot}
            onClose={() => setEditorOpen(false)}
          />
          <button
            type="button"
            class="p-note-editor-dismiss"
            aria-label="閉じる"
            onClick={() => setEditorOpen(false)}
          />
          <form
            class="p-note-editor-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div class="p-note-editor-head">
              <h2>ノート</h2>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                aria-label="閉じる"
              >
                <CloseIcon />
              </button>
            </div>
            <textarea
              value={draft()}
              maxLength={MAX_NOTE_LENGTH}
              onInput={(event) => setDraft(event.currentTarget.value)}
              placeholder="いまの一言"
              autofocus
            />
            <Show when={myNote()?.expires_at}>
              {(expiry) => (
                <p class="p-note-editor-expiry">{formatNoteExpiry(expiry())}</p>
              )}
            </Show>
            <Show when={error()}>
              {(message) => <p class="p-note-editor-error">{message()}</p>}
            </Show>
            <div class="p-note-editor-actions">
              <span
                classList={{
                  "is-limit": draft().trim().length >= MAX_NOTE_LENGTH,
                }}
              >
                {draft().trim().length} / {MAX_NOTE_LENGTH}
              </span>
              <div>
                <Show when={myNote()}>
                  <button type="button" disabled={saving()} onClick={remove}>
                    削除
                  </button>
                </Show>
                <button type="submit" disabled={!canSave()}>
                  {saving() ? "保存中" : "保存"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </Show>
    </section>
  );
}

function TalkListPane(props: {
  contacts: DMContact[];
  contactsLoading: boolean;
  selected: DMContact | null;
  onSelect: (contact: DMContact) => void;
}) {
  const app = useApp();
  const chat = useChat();
  const [query, setQuery] = createSignal("");
  const [view, setView] = createSignal<"list" | "requests" | "archived">(
    "list",
  );
  const searching = () => query().trim().length > 0;
  const contacts = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return props.contacts;
    return props.contacts.filter((contact) =>
      contactMatchesQuery(contact, needle),
    );
  });

  const [requests, { refetch: refetchRequests }] =
    createResource(fetchDMRequests);
  const [archived, { refetch: refetchArchived }] = createResource(
    () => (view() === "archived" ? "load" : false),
    () => fetchArchivedDMConversations(),
  );
  const [busyId, setBusyId] = createSignal<string | null>(null);

  const openRequest = async (request: DMRequest) => {
    try {
      const contact = await fetchDMContact(request.sender.ap_id);
      if (contact) {
        chat.selectContact(contact);
        chat.refetchContacts();
        void refetchRequests();
        setView("list");
      }
    } catch {
      app.toast("トークを開けませんでした", "error");
    }
  };

  const rejectRequest = async (request: DMRequest) => {
    if (busyId()) return;
    setBusyId(request.sender.ap_id);
    try {
      await rejectDMRequest(request.sender.ap_id);
      void refetchRequests();
      app.toast("リクエストを拒否しました");
    } catch {
      app.toast("操作に失敗しました", "error");
    } finally {
      setBusyId(null);
    }
  };

  const archive = async (contact: DMContact) => {
    if (busyId()) return;
    setBusyId(contact.ap_id);
    try {
      await archiveDMConversation(contact.ap_id);
      if (props.selected?.ap_id === contact.ap_id) chat.selectContact(null);
      chat.refetchContacts();
      app.refreshBadges();
      app.toast("アーカイブしました");
    } catch {
      app.toast("操作に失敗しました", "error");
    } finally {
      setBusyId(null);
    }
  };

  const unarchive = async (contact: DMContact) => {
    if (busyId()) return;
    setBusyId(contact.ap_id);
    try {
      await unarchiveDMConversation(contact.ap_id);
      void refetchArchived();
      chat.refetchContacts();
      app.toast("アーカイブから戻しました");
    } catch {
      app.toast("操作に失敗しました", "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section class="p-talk-rooms-pane">
      <Show
        when={view() === "list"}
        fallback={
          <button
            type="button"
            class="p-talk-subhead"
            onClick={() => setView("list")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="14 18 8 12 14 6" />
            </svg>
            {view() === "requests" ? "メッセージリクエスト" : "アーカイブ済み"}
          </button>
        }
      >
        <h1 class="p-talk-list-title">トーク</h1>
      </Show>

      <Show when={view() === "list"}>
        <div class="p-talk-list-search">
          <label>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m16 16 5 5" />
            </svg>
            <input
              name="talkSearch"
              type="search"
              placeholder="トークを検索"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>
        <div class="p-talk-chips">
          <button
            type="button"
            class="p-talk-chip"
            onClick={() => setView("requests")}
          >
            リクエスト
            <Show when={(requests()?.length ?? 0) > 0}>
              <em>{requests()?.length}</em>
            </Show>
          </button>
          <button
            type="button"
            class="p-talk-chip"
            onClick={() => setView("archived")}
          >
            アーカイブ
          </button>
        </div>
      </Show>

      <div class="p-talk-list-rooms">
        <Show when={view() === "list"}>
          <Show
            when={!props.contactsLoading}
            fallback={
              <ul class="p-talk-list-rooms__ul" aria-hidden="true">
                <For each={[0, 1, 2, 3, 4]}>{() => <ContactRowSkeleton />}</For>
              </ul>
            }
          >
            <ul class="p-talk-list-rooms__ul">
              <For
                each={contacts()}
                fallback={
                  <li class="p-home-empty">
                    {searching()
                      ? "一致するトークはありません"
                      : "まだトークはありません"}
                  </li>
                }
              >
                {(contact) => (
                  <li
                    classList={{
                      "c-talk-rooms": true,
                      "is-active": props.selected?.ap_id === contact.ap_id,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => props.onSelect(contact)}
                    >
                      <span class="c-talk-rooms-icon">
                        <Avatar value={contact} />
                      </span>
                      <span class="c-talk-rooms-box">
                        <span class="c-talk-rooms-name">
                          <span>{titleFor(contact)}</span>
                          <Show when={contact.last_message_at}>
                            <time class="c-talk-rooms-time">
                              {formatListTime(contact.last_message_at)}
                            </time>
                          </Show>
                        </span>
                        <span class="c-talk-rooms-msg">
                          <span>
                            <Show when={contact.last_message?.is_mine}>
                              あなた:{" "}
                            </Show>
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
                    <Show when={contact.type === "user"}>
                      <button
                        type="button"
                        class="c-talk-rooms-archive"
                        aria-label="アーカイブ"
                        disabled={busyId() === contact.ap_id}
                        onClick={() => void archive(contact)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="3" y="4" width="18" height="4" rx="1" />
                          <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
                        </svg>
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>

        <Show when={view() === "requests"}>
          <ul class="p-talk-list-rooms__ul">
            <For
              each={requests() ?? []}
              fallback={
                <li class="p-home-empty">メッセージリクエストはありません</li>
              }
            >
              {(request) => (
                <li class="c-talk-request">
                  <A
                    href={profilePath(request.sender.ap_id)}
                    class="c-talk-request-who"
                  >
                    <Avatar value={request.sender} />
                    <span>
                      <strong>{titleFor(request.sender)}</strong>
                      <small>{request.content}</small>
                    </span>
                  </A>
                  <div class="c-talk-request-actions">
                    <button
                      type="button"
                      class="is-primary"
                      onClick={() => void openRequest(request)}
                    >
                      開く
                    </button>
                    <button
                      type="button"
                      disabled={busyId() === request.sender.ap_id}
                      onClick={() => void rejectRequest(request)}
                    >
                      拒否
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={view() === "archived"}>
          <ul class="p-talk-list-rooms__ul">
            <Show
              when={!archived.loading}
              fallback={<li class="p-home-empty">読み込み中...</li>}
            >
              <For
                each={archived() ?? []}
                fallback={<li class="p-home-empty">アーカイブはありません</li>}
              >
                {(contact) => (
                  <li class="c-talk-rooms">
                    <button
                      type="button"
                      onClick={() => {
                        chat.selectContact(contact);
                        setView("list");
                      }}
                    >
                      <span class="c-talk-rooms-icon">
                        <Avatar value={contact} />
                      </span>
                      <span class="c-talk-rooms-box">
                        <span class="c-talk-rooms-name">
                          <span>{titleFor(contact)}</span>
                        </span>
                        <span class="c-talk-rooms-msg">
                          <span>{contactSubtitle(contact)}</span>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      class="c-talk-rooms-archive"
                      aria-label="アーカイブから戻す"
                      disabled={busyId() === contact.ap_id}
                      onClick={() => void unarchive(contact)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7" />
                        <path d="M1 5h22v2H1zM12 11v6M9 14l3-3 3 3" />
                      </svg>
                    </button>
                  </li>
                )}
              </For>
            </Show>
          </ul>
        </Show>
      </div>
    </section>
  );
}

function TimelinePostSkeleton() {
  return (
    <article class="c-timeline-post c-timeline-skeleton" aria-hidden="true">
      <header>
        <span class="c-timeline-skeleton-avatar" />
        <div>
          <span class="c-timeline-skeleton-line is-name" />
          <span class="c-timeline-skeleton-line is-handle" />
        </div>
      </header>
      <span class="c-timeline-skeleton-line is-body" />
      <span class="c-timeline-skeleton-line is-body is-short" />
    </article>
  );
}

function TimelineView(props: {
  actor: Actor;
  posts: Post[];
  postsLoading: boolean;
  postsError: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  origin?: string | null;
  stories: ActorStories[];
  onStory: (actorStories: ActorStories, index: number) => void;
  onAddStory: () => void;
  onRetry: () => void;
  onPatchPost: (apId: string, patch: (post: Post) => Post) => void;
  onRemovePost: (apId: string) => void;
}) {
  let sentinel: HTMLDivElement | undefined;
  createEffect(() => {
    const el = sentinel;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) props.onLoadMore();
    });
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });
  return (
    <section class="p-timeline">
      <StoryBar
        actor={props.actor}
        actorStories={props.stories}
        labels={{ yourStory: "あなた", addStory: "ストーリー" }}
        renderAvatar={(actor) => <Avatar value={actor} />}
        onStoryClick={props.onStory}
        onAddStory={props.onAddStory}
      />
      <div class="p-timeline-toolbar">
        <button
          type="button"
          class="p-timeline-refresh"
          disabled={props.postsLoading}
          onClick={() => props.onRetry()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
          </svg>
          {props.postsLoading && props.posts.length > 0
            ? "更新中…"
            : "最新に更新"}
        </button>
      </div>
      <div class="p-timeline-feed">
        <Show
          when={!props.postsLoading || props.posts.length > 0}
          fallback={
            <>
              <TimelinePostSkeleton />
              <TimelinePostSkeleton />
              <TimelinePostSkeleton />
            </>
          }
        >
          <Show
            when={!(props.postsError && props.posts.length === 0)}
            fallback={
              <div class="p-timeline-state">
                <p>タイムラインを読み込めませんでした</p>
                <button type="button" onClick={() => props.onRetry()}>
                  再読み込み
                </button>
              </div>
            }
          >
            <For
              each={props.posts}
              fallback={
                <div class="p-timeline-state">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 5h16M4 12h16M4 19h10" />
                  </svg>
                  <p>まだ投稿はありません</p>
                </div>
              }
            >
              {(post) => (
                <PostCard
                  post={post}
                  origin={props.origin}
                  currentActorApId={props.actor.ap_id}
                  onPatch={props.onPatchPost}
                  onRemove={props.onRemovePost}
                />
              )}
            </For>
            <Show when={props.hasMore}>
              <div class="p-timeline-more" ref={(el) => (sentinel = el)}>
                <button
                  type="button"
                  disabled={props.loadingMore}
                  onClick={() => props.onLoadMore()}
                >
                  {props.loadingMore ? "読み込み中…" : "もっと見る"}
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  );
}

function StoryViewerModal(props: {
  actor: Actor;
  actorStories: ActorStories[];
  initialActorIndex: number | null;
  initialStoryIndex?: number;
  origin?: string | null;
  onClose: () => void;
  onLike?: (story: Story) => Promise<void>;
  onShare?: (story: Story) => Promise<void>;
  onMarkViewed?: (story: Story) => Promise<void>;
  onDelete?: (story: Story) => Promise<void>;
  onReply?: (story: Story) => void;
}) {
  const app = useApp();
  const [actorIndex, setActorIndex] = createSignal(0);
  const [storyIndex, setStoryIndex] = createSignal(0);
  const [mediaError, setMediaError] = createSignal(false);
  const [paused, setPaused] = createSignal(false);

  createEffect(() => {
    const next = props.initialActorIndex;
    if (next === null || props.actorStories.length === 0) return;
    const nextActorIndex = Math.min(
      Math.max(next, 0),
      props.actorStories.length - 1,
    );
    const storyCount = props.actorStories[nextActorIndex]?.stories.length ?? 0;
    setActorIndex(nextActorIndex);
    setStoryIndex(
      Math.min(
        Math.max(props.initialStoryIndex ?? 0, 0),
        Math.max(storyCount - 1, 0),
      ),
    );
    setMediaError(false);
    setPaused(false);
  });

  const currentActorStories = createMemo(
    () => props.actorStories[actorIndex()] ?? null,
  );
  const currentStory = createMemo(
    () => currentActorStories()?.stories[storyIndex()] ?? null,
  );
  const storyCount = createMemo(
    () => currentActorStories()?.stories.length ?? 0,
  );
  const isOwnStory = createMemo(
    () => currentActorStories()?.actor.ap_id === props.actor.ap_id,
  );

  const goNext = () => {
    const group = currentActorStories();
    if (!group) return props.onClose();
    if (storyIndex() < group.stories.length - 1) {
      setStoryIndex(storyIndex() + 1);
      setMediaError(false);
      return;
    }
    if (actorIndex() < props.actorStories.length - 1) {
      setActorIndex(actorIndex() + 1);
      setStoryIndex(0);
      setMediaError(false);
      return;
    }
    props.onClose();
  };

  const goPrev = () => {
    if (storyIndex() > 0) {
      setStoryIndex(storyIndex() - 1);
      setMediaError(false);
      return;
    }
    if (actorIndex() > 0) {
      const previousIndex = actorIndex() - 1;
      const previousStories = props.actorStories[previousIndex]?.stories ?? [];
      setActorIndex(previousIndex);
      setStoryIndex(Math.max(previousStories.length - 1, 0));
      setMediaError(false);
      return;
    }
    setStoryIndex(0);
    setMediaError(false);
  };

  const handleDelete = async () => {
    const story = currentStory();
    if (!story || !props.onDelete) return;
    setPaused(true);
    const ok = await app.confirm({
      title: "ストーリーを削除",
      message: "このストーリーを削除しますか?",
      confirmLabel: "削除",
      danger: true,
    });
    if (!ok) {
      setPaused(false);
      return;
    }
    try {
      await props.onDelete(story);
    } finally {
      setPaused(false);
    }
  };

  // Auto-advance timer that supports hold-to-pause: each story change starts a
  // fresh countdown, and toggling `paused` halts/resumes it from the time that
  // was actually remaining (so the progress bar and timer stay in sync).
  createEffect(
    on([storyIndex, actorIndex, () => props.initialActorIndex], () => {
      if (props.initialActorIndex === null) return;
      const story = currentStory();
      setMediaError(false);
      if (!story) return;
      if (!story.viewed) {
        void props.onMarkViewed?.(story).catch(() => undefined);
      }
      let remaining = parseStoryDuration(story.displayDuration);
      let startedAt = performance.now();
      let timer = 0;
      const run = () => {
        startedAt = performance.now();
        timer = window.setTimeout(goNext, remaining);
      };
      const halt = () => {
        window.clearTimeout(timer);
        remaining = Math.max(0, remaining - (performance.now() - startedAt));
      };
      createEffect(() => (paused() ? halt() : run()));
      onCleanup(() => window.clearTimeout(timer));
    }),
  );

  // Escape close + focus trap live in DialogA11y; this handles the arrows.
  createEffect(() => {
    if (props.initialActorIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") goPrev();
      else if (event.key === "ArrowRight") goNext();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  let viewerRoot: HTMLDivElement | undefined;
  return (
    <Show when={props.initialActorIndex !== null && currentStory()}>
      {(story) => (
        <div
          class="p-story-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="ストーリービューア"
          ref={(el) => (viewerRoot = el)}
        >
          <DialogA11y root={() => viewerRoot} onClose={props.onClose} />
          <section class="p-story-viewer-panel">
            <button
              class="p-story-close"
              type="button"
              onClick={props.onClose}
              aria-label="閉じる"
            >
              <CloseIcon />
            </button>
            <div class="p-story-progress" aria-hidden="true">
              <For each={currentActorStories()?.stories ?? []}>
                {(_, index) => (
                  <span
                    classList={{
                      "is-done": index() < storyIndex(),
                      "is-active": index() === storyIndex(),
                    }}
                  >
                    <Show when={index() === storyIndex()}>
                      <i
                        class="p-story-progress-fill"
                        style={{
                          "animation-duration": `${parseStoryDuration(
                            story().displayDuration,
                          )}ms`,
                          "animation-play-state": paused()
                            ? "paused"
                            : "running",
                        }}
                      />
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <header class="p-story-viewer-head">
              <A
                class="p-story-viewer-author"
                href={profilePath(currentActorStories()!.actor.ap_id)}
                onClick={() => props.onClose()}
              >
                <Avatar value={currentActorStories()!.actor} />
                <div>
                  <strong>{titleFor(currentActorStories()!.actor)}</strong>
                  <span>{formatPostTime(story().published)}</span>
                </div>
              </A>
              <Show
                when={isOwnStory()}
                fallback={<em>{formatPostTime(story().published)}</em>}
              >
                <em>あなた</em>
                <button
                  class="p-story-delete"
                  type="button"
                  aria-label="ストーリーを削除"
                  onClick={() => void handleDelete()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                  </svg>
                </button>
              </Show>
            </header>
            <div
              class="p-story-card"
              onPointerDown={() => setPaused(true)}
              onPointerUp={() => setPaused(false)}
              onPointerLeave={() => setPaused(false)}
              onPointerCancel={() => setPaused(false)}
            >
              <button
                class="p-story-zone is-prev"
                type="button"
                onClick={goPrev}
                aria-label="前のストーリー"
              />
              <button
                class="p-story-zone is-next"
                type="button"
                onClick={goNext}
                aria-label="次のストーリー"
              />
              <Show
                when={mediaSrc(story(), props.origin)}
                fallback={<strong>{story().caption || "Story"}</strong>}
              >
                {(src) => (
                  <Show
                    when={
                      !mediaError() &&
                      story().attachment.mediaType.startsWith("video/")
                    }
                    fallback={
                      <Show
                        when={!mediaError()}
                        fallback={
                          <strong>メディアを読み込めませんでした</strong>
                        }
                      >
                        <img
                          src={src()}
                          alt=""
                          onError={() => setMediaError(true)}
                        />
                      </Show>
                    }
                  >
                    <video
                      src={src()}
                      autoplay
                      muted
                      playsinline
                      onError={() => setMediaError(true)}
                    />
                  </Show>
                )}
              </Show>
              <Show when={storyCount() > 1}>
                <span class="p-story-count">
                  {storyIndex() + 1} / {storyCount()}
                </span>
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
              <Show when={!isOwnStory() && props.onReply}>
                <button
                  type="button"
                  class="p-story-reply"
                  onClick={() => {
                    props.onReply?.(story());
                    props.onClose();
                  }}
                >
                  メッセージ
                </button>
              </Show>
            </div>
          </section>
        </div>
      )}
    </Show>
  );
}

function StoryComposerModal(props: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
}) {
  const [file, setFile] = createSignal<File | null>(null);
  const [caption, setCaption] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const reset = () => {
    setFile(null);
    setCaption("");
    setError(null);
    setSaving(false);
  };

  const close = () => {
    if (saving()) return;
    reset();
    props.onClose();
  };

  const submit = async () => {
    const selected = file();
    if (!selected || saving()) return;
    setSaving(true);
    setError(null);
    try {
      const uploaded = await uploadMedia(selected);
      await createStory({
        attachment: {
          url: uploaded.url,
          r2_key: uploaded.r2_key,
          content_type: uploaded.content_type,
        },
        displayDuration: selected.type.startsWith("video/") ? "PT10S" : "PT5S",
        caption: caption().trim() || undefined,
      });
      await props.onSuccess();
      reset();
      props.onClose();
    } catch (err) {
      console.error("Failed to create story:", err);
      setError("ストーリーの作成に失敗しました");
      setSaving(false);
    }
  };

  let dialogRoot: HTMLDivElement | undefined;
  return (
    <Show when={props.open}>
      <div
        class="p-story-composer"
        role="dialog"
        aria-modal="true"
        aria-label="ストーリー作成"
        ref={(el) => (dialogRoot = el)}
      >
        <DialogA11y root={() => dialogRoot} onClose={close} />
        <button
          type="button"
          class="p-story-composer-dismiss"
          aria-label="閉じる"
          onClick={close}
        />
        <form
          class="p-story-composer-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div class="p-story-composer-head">
            <h2>ストーリー作成</h2>
            <button type="button" onClick={close} aria-label="閉じる">
              <CloseIcon />
            </button>
          </div>
          <label class="p-story-file">
            <span>{file()?.name ?? "写真・動画を選択"}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm"
              onInput={(event) => {
                setFile(event.currentTarget.files?.[0] ?? null);
                setError(null);
              }}
            />
          </label>
          <textarea
            value={caption()}
            maxLength={120}
            placeholder="キャプション"
            onInput={(event) => setCaption(event.currentTarget.value)}
          />
          <Show when={error()}>
            {(message) => <p class="p-story-composer-error">{message()}</p>}
          </Show>
          <div class="p-story-composer-actions">
            <span>{caption().trim().length} / 120</span>
            <button type="submit" disabled={!file() || saving()}>
              {saving() ? "投稿中" : "投稿"}
            </button>
          </div>
        </form>
      </div>
    </Show>
  );
}

export default function App() {
  const app = useApp();
  const chat = useChat();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (): AppTab => normalizeTab(searchParams.tab);

  const [feedPosts, setFeedPosts] = createSignal<Post[]>([]);
  const [feedLoading, setFeedLoading] = createSignal(true);
  const [feedError, setFeedError] = createSignal(false);
  const [feedCursor, setFeedCursor] = createSignal<string | null>(null);
  const [feedHasMore, setFeedHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  let feedLoadedAt = 0;

  const loadFeed = async () => {
    setFeedLoading(true);
    setFeedError(false);
    try {
      const page = await fetchTimeline({ limit: 30 });
      setFeedPosts(page.posts);
      setFeedCursor(page.nextCursor);
      setFeedHasMore(page.hasMore);
    } catch {
      setFeedError(true);
    } finally {
      feedLoadedAt = Date.now();
      setFeedLoading(false);
    }
  };

  // The feed otherwise only loads once per session: refresh it when the user
  // returns to the timeline tab after it has gone stale.
  const FEED_STALE_MS = 60_000;
  createEffect(() => {
    if (tab() !== "timeline" || feedLoading()) return;
    if (Date.now() - feedLoadedAt > FEED_STALE_MS) void loadFeed();
  });

  const loadMoreFeed = async () => {
    const cursor = feedCursor();
    if (loadingMore() || !feedHasMore() || !cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchTimeline({ limit: 30, before: cursor });
      const seen = new Set(feedPosts().map((p) => p.ap_id));
      setFeedPosts((prev) => [
        ...prev,
        ...page.posts.filter((p) => !seen.has(p.ap_id)),
      ]);
      setFeedCursor(page.nextCursor);
      setFeedHasMore(page.hasMore);
    } catch {
      app.toast("読み込みに失敗しました", "error");
    } finally {
      setLoadingMore(false);
    }
  };

  createEffect(on(app.origin, () => void loadFeed()));

  const [stories, { refetch: refetchStories }] = createResource(
    app.origin,
    () => fetchStories(),
  );
  const [notes, { refetch: refetchNotes }] = createResource(app.origin, () =>
    fetchNotes(),
  );
  const [storyViewerActorIndex, setStoryViewerActorIndex] = createSignal<
    number | null
  >(null);
  const [storyViewerStoryIndex, setStoryViewerStoryIndex] = createSignal(0);
  const [storyComposerOpen, setStoryComposerOpen] = createSignal(false);
  const [postComposerOpen, setPostComposerOpen] = createSignal(false);

  const openStoryGroup = (group: ActorStories) => {
    const actualIndex = (stories() ?? []).findIndex(
      (item) => item.actor.ap_id === group.actor.ap_id,
    );
    if (actualIndex >= 0) {
      setStoryViewerStoryIndex(0);
      setStoryViewerActorIndex(actualIndex);
    }
  };

  // Notification targets use `/?story=<AP id>`. Resolve the exact active story
  // from the already-loaded story bar data; expired/deleted stories safely
  // degrade to the normal home view.
  createEffect(() => {
    const raw = searchParams.story;
    const storyApId = Array.isArray(raw) ? raw[0] : raw;
    const groups = stories() ?? [];
    if (!storyApId || stories.loading || stories.error) return;
    for (const [actorIndex, group] of groups.entries()) {
      const storyIndex = group.stories.findIndex(
        (story) => story.ap_id === storyApId,
      );
      if (storyIndex < 0) continue;
      setStoryViewerStoryIndex(storyIndex);
      setStoryViewerActorIndex(actorIndex);
      return;
    }

    setSearchParams({ story: undefined }, { replace: true });
  });

  const closeStoryViewer = () => {
    setStoryViewerActorIndex(null);
    setStoryViewerStoryIndex(0);
    if (searchParams.story) {
      setSearchParams({ story: undefined }, { replace: true });
    }
    void refetchStories();
  };

  const patchTimelinePost = (apId: string, patch: (post: Post) => Post) => {
    setFeedPosts((prev) =>
      prev.map((post) => (post.ap_id === apId ? patch(post) : post)),
    );
  };

  const removeTimelinePost = (apId: string) => {
    setFeedPosts((prev) => prev.filter((post) => post.ap_id !== apId));
  };

  return (
    <>
      <Show when={tab() === "home"}>
        <HomeView
          actor={app.actor()}
          contacts={chat.contacts()}
          contactsLoading={chat.contactsLoading()}
          notes={notes() ?? []}
          notesLoading={notes.loading}
          onTalk={chat.selectContact}
          onSaveNote={async (content) => {
            await createNote({ content });
            await refetchNotes();
          }}
          onDeleteNote={async () => {
            await deleteMyNote();
            await refetchNotes();
          }}
        />
      </Show>
      <Show when={tab() === "talk"}>
        <TalkListPane
          contacts={chat.contacts()}
          contactsLoading={chat.contactsLoading()}
          selected={chat.selected()}
          onSelect={chat.selectContact}
        />
      </Show>
      <Show when={tab() === "timeline"}>
        <TimelineView
          actor={app.actor()}
          posts={feedPosts()}
          postsLoading={feedLoading()}
          postsError={feedError()}
          hasMore={feedHasMore()}
          loadingMore={loadingMore()}
          onLoadMore={() => void loadMoreFeed()}
          origin={app.origin()}
          stories={stories() ?? []}
          onStory={openStoryGroup}
          onAddStory={() => setStoryComposerOpen(true)}
          onRetry={() => void loadFeed()}
          onPatchPost={patchTimelinePost}
          onRemovePost={removeTimelinePost}
        />
      </Show>
      <StoryViewerModal
        actor={app.actor()}
        actorStories={stories() ?? []}
        initialActorIndex={storyViewerActorIndex()}
        initialStoryIndex={storyViewerStoryIndex()}
        origin={app.origin()}
        onClose={closeStoryViewer}
        onMarkViewed={async (target) => {
          await markStoryViewed(target.ap_id);
          await refetchStories();
        }}
        onLike={async (target) => {
          if (target.liked) await unlikeStory(target.ap_id);
          else await likeStory(target.ap_id);
          await refetchStories();
        }}
        onShare={async (target) => {
          await shareStory(target.ap_id);
          await refetchStories();
        }}
        onDelete={async (target) => {
          try {
            await deleteStory(target.ap_id);
            closeStoryViewer();
            app.toast("ストーリーを削除しました");
          } catch {
            app.toast("削除に失敗しました", "error");
          }
        }}
        onReply={(target) => {
          void (async () => {
            try {
              const contact = await fetchDMContact(target.author.ap_id);
              if (contact) {
                navigate("/?tab=talk");
                chat.selectContact(contact);
              }
            } catch {
              app.toast("トークを開けませんでした", "error");
            }
          })();
        }}
      />
      <StoryComposerModal
        open={storyComposerOpen()}
        onClose={() => setStoryComposerOpen(false)}
        onSuccess={async () => {
          await refetchStories();
        }}
      />
      <Show when={tab() === "timeline"}>
        <ComposeFab onClick={() => setPostComposerOpen(true)} />
      </Show>
      <PostComposer
        open={postComposerOpen()}
        onClose={() => setPostComposerOpen(false)}
        onPosted={(post) => setFeedPosts((prev) => [post, ...prev])}
      />
    </>
  );
}
