import { createSignal, For, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import {
  blockUser,
  bookmarkPost,
  deletePost,
  editPost,
  likePost,
  type MediaAttachment,
  muteUser,
  type Post,
  repostPost,
  unbookmarkPost,
  unlikePost,
  unrepostPost,
} from "@takosjp/yurucommu-api";
import { useApp } from "../../lib/app-context.tsx";
import {
  actorHandle,
  attachmentSrc,
  CloseIcon,
  formatPostTime,
  postPath,
  profilePath,
  renderRichText,
  stripHtml,
  titleFor,
  UserAvatar,
} from "../../lib/ui.tsx";

function VisibilityIcon(props: { visibility: Post["visibility"] }) {
  return (
    <Show when={props.visibility !== "public"}>
      <span
        class="c-timeline-visibility"
        aria-hidden="true"
        title={
          props.visibility === "direct"
            ? "ダイレクト"
            : props.visibility === "followers"
              ? "フォロワー限定"
              : "未収載"
        }
      >
        <Show
          when={props.visibility === "direct"}
          fallback={
            <Show
              when={props.visibility === "followers"}
              fallback={
                <svg viewBox="0 0 24 24">
                  <path d="M7 11V8a5 5 0 0 1 9.9-1" />
                  <rect x="4" y="11" width="16" height="10" rx="2" />
                </svg>
              }
            >
              <svg viewBox="0 0 24 24">
                <path d="M16 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" />
                <circle cx="12" cy="9" r="3" />
              </svg>
            </Show>
          }
        >
          <svg viewBox="0 0 24 24">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </Show>
      </span>
    </Show>
  );
}

export function PostMedia(props: {
  attachments: MediaAttachment[];
  origin?: string | null;
}) {
  const videos = (): { src: string; type?: string }[] =>
    props.attachments.flatMap((a) => {
      if (!(a.content_type || "").startsWith("video/")) return [];
      const src = attachmentSrc(a, props.origin);
      return src ? [{ src, type: a.content_type }] : [];
    });
  const images = (): { src: string; name?: string }[] =>
    props.attachments.flatMap((a) => {
      if (!(a.content_type || "").startsWith("image/")) return [];
      const src = attachmentSrc(a, props.origin);
      return src ? [{ src, name: a.name }] : [];
    });
  return (
    <>
      <Show when={images().length > 0}>
        <div
          classList={{
            "c-timeline-media": true,
            [`is-${Math.min(images().length, 4)}`]: true,
          }}
        >
          <For each={images().slice(0, 4)}>
            {(image, index) => (
              <a
                class="c-timeline-media-cell"
                href={image.src}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <img src={image.src} alt={image.name ?? ""} loading="lazy" />
                <Show when={index() === 3 && images().length > 4}>
                  <span class="c-timeline-media-more">
                    +{images().length - 4}
                  </span>
                </Show>
              </a>
            )}
          </For>
        </div>
      </Show>
      <For each={videos()}>
        {(video) => (
          <video
            class="c-timeline-video"
            src={video.src}
            controls
            preload="metadata"
            playsinline
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </For>
    </>
  );
}

function isRepostable(post: Post): boolean {
  return (
    (post.visibility === "public" || post.visibility === "unlisted") &&
    !post.community_ap_id
  );
}

export function PostCard(props: {
  post: Post;
  origin?: string | null;
  currentActorApId: string;
  focused?: boolean;
  onPatch: (apId: string, patch: (post: Post) => Post) => void;
  onRemove?: (apId: string) => void;
}) {
  const app = useApp();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [liking, setLiking] = createSignal(false);
  const [reposting, setReposting] = createSignal(false);
  const [bookmarking, setBookmarking] = createSignal(false);
  const [cwRevealed, setCwRevealed] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const isOwn = () => props.post.author.ap_id === props.currentActorApId;
  const body = () => stripHtml(props.post.content).trim();
  const hidden = () => !!props.post.summary && !cwRevealed();
  const openDetail = () => navigate(postPath(props.post.ap_id));

  const toggleLike = async () => {
    if (liking()) return;
    setLiking(true);
    const before = props.post;
    const next = !before.liked;
    props.onPatch(before.ap_id, (p) => ({
      ...p,
      liked: next,
      like_count: Math.max(0, p.like_count + (next ? 1 : -1)),
    }));
    try {
      if (next) await likePost(before.ap_id);
      else await unlikePost(before.ap_id);
    } catch {
      props.onPatch(before.ap_id, (p) => ({
        ...p,
        liked: before.liked,
        like_count: before.like_count,
      }));
      app.toast("操作に失敗しました", "error");
    } finally {
      setLiking(false);
    }
  };

  const toggleRepost = async () => {
    if (reposting()) return;
    setReposting(true);
    const before = props.post;
    const next = !before.reposted;
    props.onPatch(before.ap_id, (p) => ({
      ...p,
      reposted: next,
      announce_count: Math.max(0, p.announce_count + (next ? 1 : -1)),
    }));
    try {
      if (next) await repostPost(before.ap_id);
      else await unrepostPost(before.ap_id);
    } catch {
      props.onPatch(before.ap_id, (p) => ({
        ...p,
        reposted: before.reposted,
        announce_count: before.announce_count,
      }));
      app.toast("操作に失敗しました", "error");
    } finally {
      setReposting(false);
    }
  };

  const toggleBookmark = async () => {
    if (bookmarking()) return;
    setBookmarking(true);
    const before = props.post;
    const next = !before.bookmarked;
    props.onPatch(before.ap_id, (p) => ({ ...p, bookmarked: next }));
    try {
      if (next) await bookmarkPost(before.ap_id);
      else await unbookmarkPost(before.ap_id);
      app.toast(next ? "ブックマークしました" : "ブックマークを外しました");
    } catch {
      props.onPatch(before.ap_id, (p) => ({
        ...p,
        bookmarked: before.bookmarked,
      }));
      app.toast("操作に失敗しました", "error");
    } finally {
      setBookmarking(false);
    }
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    const ok = await app.confirm({
      title: "投稿を削除",
      message: "この投稿を削除しますか?",
      confirmLabel: "削除",
      danger: true,
    });
    if (!ok) return;
    try {
      await deletePost(props.post.ap_id);
      props.onRemove?.(props.post.ap_id);
      app.toast("削除しました");
    } catch {
      app.toast("削除に失敗しました", "error");
    }
  };

  const handleMute = async () => {
    setMenuOpen(false);
    try {
      await muteUser(props.post.author.ap_id);
      props.onRemove?.(props.post.ap_id);
      app.toast("ミュートしました");
    } catch {
      app.toast("ミュートに失敗しました", "error");
    }
  };

  const handleBlock = async () => {
    setMenuOpen(false);
    try {
      await blockUser(props.post.author.ap_id);
      props.onRemove?.(props.post.ap_id);
      app.toast("ブロックしました");
    } catch {
      app.toast("ブロックに失敗しました", "error");
    }
  };

  return (
    <article class="c-timeline-post">
      <header>
        <A href={profilePath(props.post.author.ap_id)} class="c-post-avatar">
          <UserAvatar value={props.post.author} />
        </A>
        <div class="c-post-ident">
          <A
            href={profilePath(props.post.author.ap_id)}
            class="c-post-name-link"
          >
            <strong>{titleFor(props.post.author)}</strong>
          </A>
          <span>
            {actorHandle(props.post.author)} ·{" "}
            {formatPostTime(props.post.published)}
            <VisibilityIcon visibility={props.post.visibility} />
            <Show when={props.post.edited_at}>
              <span class="c-post-edited"> · 編集済み</span>
            </Show>
          </span>
        </div>
        <div class="c-post-menu">
          <button
            type="button"
            class="c-post-menu-btn"
            aria-label="その他"
            aria-haspopup="true"
            aria-expanded={menuOpen()}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>
          <Show when={menuOpen()}>
            <button
              type="button"
              class="c-post-menu-scrim"
              aria-label="閉じる"
              onClick={() => setMenuOpen(false)}
            />
            <div class="c-post-menu-list" role="menu">
              <Show
                when={isOwn()}
                fallback={
                  <>
                    <button type="button" role="menuitem" onClick={handleMute}>
                      ミュート
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="is-danger"
                      onClick={handleBlock}
                    >
                      ブロック
                    </button>
                  </>
                }
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setEditing(true);
                  }}
                >
                  編集
                </button>
                <button
                  type="button"
                  role="menuitem"
                  class="is-danger"
                  onClick={handleDelete}
                >
                  削除
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </header>

      <Show when={props.post.summary}>
        <div class="c-post-cw">
          <span>{props.post.summary}</span>
          <button
            type="button"
            class="c-post-cw-toggle"
            aria-expanded={cwRevealed()}
            onClick={() => setCwRevealed((v) => !v)}
          >
            {cwRevealed() ? "隠す" : "表示"}
          </button>
        </div>
      </Show>
      <Show when={!hidden()}>
        <Show when={body()}>
          <Show
            when={!props.focused}
            fallback={
              <div class="c-post-body is-focused">{renderRichText(body())}</div>
            }
          >
            <div
              class="c-post-body"
              role="link"
              tabindex="0"
              onClick={openDetail}
              onKeyDown={(event) => {
                if (event.key === "Enter") openDetail();
              }}
            >
              {renderRichText(body())}
            </div>
          </Show>
        </Show>
        <PostMedia attachments={props.post.attachments} origin={props.origin} />
      </Show>

      <footer>
        <button
          type="button"
          class="c-timeline-action"
          classList={{ "is-active": props.post.liked }}
          onClick={() => void toggleLike()}
          aria-label={props.post.liked ? "いいねを取り消す" : "いいね"}
          aria-pressed={props.post.liked}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" />
          </svg>
          <span>{props.post.like_count || ""}</span>
        </button>

        <button
          type="button"
          class="c-timeline-action"
          onClick={() => navigate(postPath(props.post.ap_id))}
          aria-label="返信"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
          </svg>
          <span>{props.post.reply_count || ""}</span>
        </button>

        <Show when={isRepostable(props.post)}>
          <button
            type="button"
            class="c-timeline-action c-timeline-action--repost"
            classList={{ "is-active": props.post.reposted }}
            onClick={() => void toggleRepost()}
            aria-label={props.post.reposted ? "リポストを取り消す" : "リポスト"}
            aria-pressed={props.post.reposted}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m17 2 4 4-4 4" />
              <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
              <path d="m7 22-4-4 4-4" />
              <path d="M21 13v1a4 4 0 0 1-4 4H3" />
            </svg>
            <span>{props.post.announce_count || ""}</span>
          </button>
        </Show>

        <button
          type="button"
          class="c-timeline-action c-timeline-action--bookmark"
          classList={{ "is-active": props.post.bookmarked }}
          onClick={() => void toggleBookmark()}
          aria-label={
            props.post.bookmarked ? "ブックマークを外す" : "ブックマーク"
          }
          aria-pressed={props.post.bookmarked}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      </footer>

      <Show when={editing()}>
        <EditPostModal
          post={props.post}
          onClose={() => setEditing(false)}
          onSaved={(patch) =>
            props.onPatch(props.post.ap_id, (p) => ({ ...p, ...patch }))
          }
        />
      </Show>
    </article>
  );
}

function EditPostModal(props: {
  post: Post;
  onClose: () => void;
  onSaved: (patch: {
    content: string;
    summary: string | null;
    edited_at: string;
  }) => void;
}) {
  const app = useApp();
  const [content, setContent] = createSignal(stripHtml(props.post.content));
  const [summary, setSummary] = createSignal(props.post.summary ?? "");
  const [saving, setSaving] = createSignal(false);
  const canSave = () => content().trim().length > 0 && !saving();

  const save = async (event: Event) => {
    event.preventDefault();
    if (!canSave()) return;
    setSaving(true);
    try {
      const result = await editPost(props.post.ap_id, {
        content: content().trim(),
        summary: summary().trim() || null,
      });
      props.onSaved({
        content: result.content,
        summary: result.summary,
        edited_at: new Date().toISOString(),
      });
      app.toast("編集しました");
      props.onClose();
    } catch {
      app.toast("編集に失敗しました", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      class="p-composer"
      role="dialog"
      aria-modal="true"
      aria-label="投稿を編集"
    >
      <button
        type="button"
        class="p-composer-dismiss"
        aria-label="閉じる"
        onClick={props.onClose}
      />
      <form class="p-composer-panel" onSubmit={save}>
        <div class="p-composer-head">
          <button
            type="button"
            class="p-composer-close"
            onClick={props.onClose}
            aria-label="閉じる"
          >
            <CloseIcon />
          </button>
          <strong>投稿を編集</strong>
          <button type="submit" class="p-composer-submit" disabled={!canSave()}>
            {saving() ? "保存中" : "保存"}
          </button>
        </div>
        <div class="p-edit-body">
          <div class="p-edit-fields">
            <label class="p-edit-field">
              <span>内容の警告 (CW)</span>
              <input
                type="text"
                value={summary()}
                onInput={(e) => setSummary(e.currentTarget.value)}
                placeholder="任意"
              />
            </label>
            <label class="p-edit-field">
              <span>本文</span>
              <textarea
                value={content()}
                onInput={(e) => setContent(e.currentTarget.value)}
                rows={5}
                autofocus
              />
            </label>
          </div>
        </div>
      </form>
    </div>
  );
}
