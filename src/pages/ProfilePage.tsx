import { createEffect, createSignal, For, on, Show } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import {
  type Actor,
  blockUser,
  fetchActor,
  fetchActorPosts,
  fetchDMContact,
  fetchFollowers,
  fetchFollowing,
  follow,
  logout,
  muteUser,
  type Post,
  reportContent,
  unblockUser,
  unfollow,
  unmuteUser,
} from "@takosjp/yurucommu-api";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { PostCard } from "../components/timeline/PostCard.tsx";
import { ProfileEditModal } from "../components/profile/ProfileEditModal.tsx";
import { useApp } from "../lib/app-context.tsx";
import { useChat } from "../lib/chat-context.tsx";
import { createEscapeClose, DialogA11y } from "../lib/dialog.tsx";
import { clearYurumeBrowserPushBeforeSignOut } from "../lib/browser-push.ts";
import {
  attachmentSrc,
  CloseIcon,
  decodeApIdParam,
  formatJoined,
  fullHandle,
  postPath,
  profilePath,
  SpinnerIcon,
  titleFor,
  UserAvatar,
} from "../lib/ui.tsx";

export default function ProfilePage() {
  const params = useParams();
  const app = useApp();
  const navigate = useNavigate();

  const targetActorId = () => {
    if (params.actorId) return decodeApIdParam(params.actorId);
    if (params.username) return `${app.origin()}/ap/users/${params.username}`;
    return app.actor().ap_id;
  };
  const isOwn = () => targetActorId() === app.actor().ap_id;

  const [profile, setProfile] = createSignal<Actor | null>(null);
  const [posts, setPosts] = createSignal<Post[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  const [isFollowing, setIsFollowing] = createSignal(false);
  const [followPending, setFollowPending] = createSignal(false);
  const [followBusy, setFollowBusy] = createSignal(false);
  const [editOpen, setEditOpen] = createSignal(false);
  const [followList, setFollowList] = createSignal<
    "followers" | "following" | null
  >(null);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [ownMenuOpen, setOwnMenuOpen] = createSignal(false);
  const [reportOpen, setReportOpen] = createSignal(false);
  const [muted, setMuted] = createSignal(false);
  const [blocked, setBlocked] = createSignal(false);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const chat = useChat();

  createEscapeClose(menuOpen, () => setMenuOpen(false));
  createEscapeClose(ownMenuOpen, () => setOwnMenuOpen(false));

  const canSeePosts = () => {
    const p = profile();
    return !p?.is_private || isFollowing() || isOwn();
  };

  let gen = 0;
  const load = () => {
    const id = targetActorId();
    const myGen = ++gen;
    setLoading(true);
    setError(false);
    setProfile(null);
    setPosts([]);
    setFollowPending(false);
    setMenuOpen(false);
    setMuted(false);
    setBlocked(false);
    setCursor(null);
    setHasMore(false);
    void (async () => {
      try {
        const actor = await fetchActor(id);
        if (myGen !== gen) return;
        setProfile(actor);
        setIsFollowing(!!actor.is_following);
        const page = await fetchActorPosts(id, { limit: 20 });
        if (myGen !== gen) return;
        setPosts(page.posts);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch {
        if (myGen === gen) setError(true);
      } finally {
        if (myGen === gen) setLoading(false);
      }
    })();
  };
  createEffect(on(targetActorId, load));

  const loadMorePosts = () => {
    const p = profile();
    if (!p || loadingMore() || !hasMore() || !cursor()) return;
    setLoadingMore(true);
    const myGen = gen;
    void (async () => {
      try {
        const page = await fetchActorPosts(p.ap_id, {
          limit: 20,
          before: cursor() ?? undefined,
        });
        if (myGen !== gen) return;
        const seen = new Set(posts().map((x) => x.ap_id));
        setPosts((prev) => [
          ...prev,
          ...page.posts.filter((x) => !seen.has(x.ap_id)),
        ]);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch {
        /* keep what we have */
      } finally {
        if (myGen === gen) setLoadingMore(false);
      }
    })();
  };

  const openMessage = async () => {
    const p = profile();
    if (!p) return;
    try {
      const contact = await fetchDMContact(p.ap_id);
      if (contact) {
        // Navigate FIRST so the chat's history entry sits on top of the talk
        // tab (back then closes the chat instead of resurrecting this page).
        navigate("/?tab=talk");
        chat.selectContact(contact);
      }
    } catch {
      app.toast("トークを開けませんでした", "error");
    }
  };

  const toggleMute = async () => {
    const p = profile();
    if (!p) return;
    setMenuOpen(false);
    try {
      if (muted()) {
        await unmuteUser(p.ap_id);
        setMuted(false);
        app.toast("ミュートを解除しました");
      } else {
        await muteUser(p.ap_id);
        setMuted(true);
        app.toast("ミュートしました");
      }
    } catch {
      app.toast("操作に失敗しました", "error");
    }
  };

  const toggleBlock = async () => {
    const p = profile();
    if (!p) return;
    setMenuOpen(false);
    try {
      if (blocked()) {
        await unblockUser(p.ap_id);
        setBlocked(false);
        app.toast("ブロックを解除しました");
      } else {
        const ok = await app.confirm({
          title: "ブロック",
          message: `${titleFor(p)} をブロックしますか?`,
          confirmLabel: "ブロック",
          danger: true,
        });
        if (!ok) return;
        await blockUser(p.ap_id);
        setBlocked(true);
        setIsFollowing(false);
        app.toast("ブロックしました");
      }
    } catch {
      app.toast("操作に失敗しました", "error");
    }
  };

  const report = () => {
    setMenuOpen(false);
    setReportOpen(true);
  };

  const submitReport = async (reason: string) => {
    const p = profile();
    if (!p) return;
    try {
      await reportContent({ targetActorApId: p.ap_id, reason });
      app.toast("報告しました");
    } catch {
      app.toast("報告に失敗しました", "error");
    } finally {
      setReportOpen(false);
    }
  };

  const handleLogout = async () => {
    setOwnMenuOpen(false);
    const ok = await app.confirm({
      title: "ログアウト",
      message: "ログアウトしますか?",
      confirmLabel: "ログアウト",
    });
    if (!ok) return;
    try {
      await clearYurumeBrowserPushBeforeSignOut();
      await logout();
    } catch {
      /* proceed to reload anyway */
    }
    window.location.reload();
  };

  const copyLink = () => {
    const p = profile();
    if (!p) return;
    setMenuOpen(false);
    const url = `${app.origin()}${profilePath(p.ap_id)}`;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => app.toast("リンクをコピーしました"))
      .catch(() => app.toast("コピーに失敗しました", "error"));
  };

  const handleFollow = async () => {
    const target = profile();
    if (!target || followBusy() || followPending()) return;
    setFollowBusy(true);
    try {
      if (isFollowing()) {
        await unfollow(target.ap_id);
        setIsFollowing(false);
        setProfile((p) =>
          p ? { ...p, follower_count: Math.max(0, p.follower_count - 1) } : p,
        );
      } else {
        const { status } = await follow(target.ap_id);
        if (status === "pending") {
          setFollowPending(true);
          app.toast("フォローリクエストを送りました");
        } else {
          setIsFollowing(true);
          setProfile((p) =>
            p ? { ...p, follower_count: p.follower_count + 1 } : p,
          );
        }
      }
    } catch {
      app.toast("操作に失敗しました", "error");
    } finally {
      setFollowBusy(false);
    }
  };

  const patchPost = (apId: string, patch: (p: Post) => Post) =>
    setPosts((prev) => prev.map((p) => (p.ap_id === apId ? patch(p) : p)));
  const removePost = (apId: string) =>
    setPosts((prev) => prev.filter((p) => p.ap_id !== apId));

  const bannerUrl = () => {
    const p = profile();
    return p?.header_url
      ? attachmentSrc({ url: p.header_url }, app.origin())
      : undefined;
  };

  return (
    <PageLayout active={isOwn() ? "profile" : undefined}>
      <PageHeader title={profile() ? titleFor(profile()!) : "プロフィール"} />
      <div class="p-profile">
        <Show when={!loading()} fallback={<ProfileLoading />}>
          <Show
            when={!error()}
            fallback={
              <div class="p-timeline-state">
                <p>プロフィールを読み込めませんでした</p>
                <button type="button" onClick={load}>
                  再読み込み
                </button>
              </div>
            }
          >
            <Show when={profile()}>
              {(p) => (
                <>
                  <div class="p-profile-head">
                    <div
                      class="p-profile-banner"
                      classList={{ "has-image": !!bannerUrl() }}
                    >
                      <Show when={bannerUrl()}>
                        {(src) => <img src={src()} alt="" />}
                      </Show>
                    </div>
                    <div class="p-profile-id">
                      <div class="p-profile-avatar">
                        <UserAvatar value={p()} size={92} />
                      </div>
                      <div class="p-profile-actions">
                        <Show
                          when={!isOwn()}
                          fallback={
                            <>
                              <div class="p-profile-more">
                                <button
                                  type="button"
                                  class="p-profile-icon-btn"
                                  aria-label="メニュー"
                                  aria-haspopup="true"
                                  aria-expanded={ownMenuOpen()}
                                  onClick={() => setOwnMenuOpen((v) => !v)}
                                >
                                  <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <circle cx="5" cy="12" r="1.6" />
                                    <circle cx="12" cy="12" r="1.6" />
                                    <circle cx="19" cy="12" r="1.6" />
                                  </svg>
                                </button>
                                <Show when={ownMenuOpen()}>
                                  <button
                                    type="button"
                                    class="c-post-menu-scrim"
                                    aria-label="閉じる"
                                    onClick={() => setOwnMenuOpen(false)}
                                  />
                                  <div class="c-post-menu-list" role="menu">
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setOwnMenuOpen(false);
                                        navigate("/bookmarks");
                                      }}
                                    >
                                      ブックマーク
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setOwnMenuOpen(false);
                                        navigate("/settings");
                                      }}
                                    >
                                      設定
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      class="is-danger"
                                      onClick={() => void handleLogout()}
                                    >
                                      ログアウト
                                    </button>
                                  </div>
                                </Show>
                              </div>
                              <button
                                type="button"
                                class="p-profile-edit"
                                onClick={() => setEditOpen(true)}
                              >
                                プロフィールを編集
                              </button>
                            </>
                          }
                        >
                          <div class="p-profile-more">
                            <button
                              type="button"
                              class="p-profile-icon-btn"
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
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => void toggleMute()}
                                >
                                  {muted() ? "ミュート解除" : "ミュート"}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  class="is-danger"
                                  onClick={() => void toggleBlock()}
                                >
                                  {blocked() ? "ブロック解除" : "ブロック"}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => void report()}
                                >
                                  報告
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={copyLink}
                                >
                                  リンクをコピー
                                </button>
                              </div>
                            </Show>
                          </div>
                          <button
                            type="button"
                            class="p-profile-icon-btn"
                            aria-label="メッセージ"
                            onClick={() => void openMessage()}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            classList={{
                              "p-profile-follow": true,
                              "is-following": isFollowing(),
                              "is-pending": followPending(),
                            }}
                            disabled={followBusy() || followPending()}
                            onClick={() => void handleFollow()}
                          >
                            {followPending()
                              ? "リクエスト済み"
                              : isFollowing()
                                ? "フォロー中"
                                : p().is_followed_by
                                  ? "フォローバック"
                                  : "フォロー"}
                          </button>
                        </Show>
                      </div>
                    </div>
                    <div class="p-profile-meta">
                      <strong class="p-profile-name">
                        {titleFor(p())}
                        <Show when={p().is_private}>
                          <svg
                            class="p-profile-lock"
                            viewBox="0 0 24 24"
                            aria-label="非公開アカウント"
                          >
                            <rect x="4" y="11" width="16" height="10" rx="2" />
                            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                          </svg>
                        </Show>
                      </strong>
                      <span class="p-profile-handle">
                        {fullHandle(p())}
                        <Show when={p().is_followed_by && !isOwn()}>
                          <span class="p-profile-chip">
                            フォローされています
                          </span>
                        </Show>
                      </span>
                      <Show when={p().moved_to}>
                        {(moved) => (
                          <A
                            class="p-profile-moved"
                            href={profilePath(moved())}
                          >
                            このアカウントは引っ越しました →
                          </A>
                        )}
                      </Show>
                      <Show when={p().summary}>
                        <p class="p-profile-bio">{p().summary}</p>
                      </Show>
                      <Show when={(p().fields ?? []).length > 0}>
                        <dl class="p-profile-fields">
                          <For each={p().fields}>
                            {(field) => (
                              <Show when={field.name && field.value}>
                                <div class="p-profile-field">
                                  <dt>{field.name}</dt>
                                  <dd>
                                    <Show
                                      when={/^https?:\/\//.test(field.value)}
                                      fallback={field.value}
                                    >
                                      <a
                                        href={field.value}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        {field.value}
                                      </a>
                                    </Show>
                                  </dd>
                                </div>
                              </Show>
                            )}
                          </For>
                        </dl>
                      </Show>
                      <Show when={p().created_at}>
                        <p class="p-profile-joined">
                          {formatJoined(p().created_at)} に参加
                        </p>
                      </Show>
                      <div class="p-profile-stats">
                        <button
                          type="button"
                          onClick={() => setFollowList("following")}
                        >
                          <strong>{p().following_count}</strong> フォロー
                        </button>
                        <button
                          type="button"
                          onClick={() => setFollowList("followers")}
                        >
                          <strong>{p().follower_count}</strong> フォロワー
                        </button>
                        <span>
                          <strong>{p().post_count}</strong> 投稿
                        </span>
                      </div>
                    </div>
                  </div>

                  <div class="p-profile-posts">
                    <Show
                      when={canSeePosts()}
                      fallback={
                        <div class="p-timeline-state">
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <rect x="4" y="11" width="16" height="10" rx="2" />
                            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                          </svg>
                          <p>
                            このアカウントは非公開です。フォローが承認されると投稿が表示されます。
                          </p>
                        </div>
                      }
                    >
                      <For
                        each={posts()}
                        fallback={
                          <p class="p-detail-empty">まだ投稿はありません</p>
                        }
                      >
                        {(post) => (
                          <PostCard
                            post={post}
                            origin={app.origin()}
                            currentActorApId={app.actor().ap_id}
                            onPatch={patchPost}
                            onRemove={removePost}
                          />
                        )}
                      </For>
                      <Show when={hasMore()}>
                        <button
                          type="button"
                          class="p-load-more"
                          disabled={loadingMore()}
                          onClick={loadMorePosts}
                        >
                          {loadingMore() ? "読み込み中…" : "もっと見る"}
                        </button>
                      </Show>
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={editOpen() && profile()}>
        <ProfileEditModal
          actor={profile()!}
          onClose={() => setEditOpen(false)}
          onSaved={(updated) => {
            setProfile(updated);
            app.refetchActor();
            setEditOpen(false);
            app.toast("プロフィールを更新しました");
          }}
        />
      </Show>

      <Show when={followList() && profile()}>
        <FollowListModal
          actorId={profile()!.ap_id}
          mode={followList()!}
          selfApId={app.actor().ap_id}
          onClose={() => setFollowList(null)}
          onOpenProfile={(apId) => {
            setFollowList(null);
            navigate(profilePath(apId));
          }}
        />
      </Show>

      <Show when={reportOpen() && profile()}>
        <ReportModal
          name={titleFor(profile()!)}
          onClose={() => setReportOpen(false)}
          onSubmit={submitReport}
        />
      </Show>
    </PageLayout>
  );
}

const REPORT_REASONS = [
  "スパム・宣伝",
  "いやがらせ・攻撃的",
  "なりすまし",
  "不適切なコンテンツ",
];

function ReportModal(props: {
  name: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const canSubmit = () => !!reason() && !submitting();

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!canSubmit()) return;
    setSubmitting(true);
    const text = detail().trim()
      ? `${reason()}: ${detail().trim()}`
      : reason()!;
    await props.onSubmit(text);
    setSubmitting(false);
  };

  let dialogRoot: HTMLDivElement | undefined;
  return (
    <div
      class="p-composer"
      role="dialog"
      aria-modal="true"
      aria-label="報告"
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
          <strong>{props.name} を報告</strong>
          <button
            type="submit"
            class="p-composer-submit"
            disabled={!canSubmit()}
          >
            {submitting() ? "送信中" : "報告"}
          </button>
        </div>
        <div class="p-edit-body">
          <div class="p-report-reasons">
            <For each={REPORT_REASONS}>
              {(item) => (
                <button
                  type="button"
                  classList={{
                    "p-report-reason": true,
                    "is-active": reason() === item,
                  }}
                  onClick={() => setReason(item)}
                >
                  {item}
                </button>
              )}
            </For>
          </div>
          <div class="p-edit-fields">
            <label class="p-edit-field">
              <span>詳細 (任意)</span>
              <textarea
                value={detail()}
                onInput={(e) => setDetail(e.currentTarget.value)}
                rows={3}
                placeholder="状況を補足できます"
              />
            </label>
          </div>
        </div>
      </form>
    </div>
  );
}

function ProfileLoading() {
  return (
    <div class="p-detail-loading">
      <SpinnerIcon />
    </div>
  );
}

function FollowListModal(props: {
  actorId: string;
  mode: "followers" | "following";
  selfApId: string;
  onClose: () => void;
  onOpenProfile: (apId: string) => void;
}) {
  const app = useApp();
  const [actors, setActors] = createSignal<Actor[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [followState, setFollowState] = createSignal<Record<string, boolean>>(
    {},
  );
  const [busyId, setBusyId] = createSignal<string | null>(null);

  // The follow-list API is OFFSET-paged: the next offset must count the raw
  // rows fetched so far, NOT the rows kept after de-duplication — otherwise a
  // page of duplicates re-fetches the same window forever.
  let fetchedCount = 0;

  const fetchPage = (offset: number) =>
    props.mode === "followers"
      ? fetchFollowers(props.actorId, { limit: 50, offset })
      : fetchFollowing(props.actorId, { limit: 50, offset });

  const applyState = (list: Actor[]) => {
    setFollowState((prev) => {
      const next = { ...prev };
      for (const a of list)
        if (!(a.ap_id in next)) next[a.ap_id] = !!a.is_following;
      return next;
    });
  };

  void (async () => {
    try {
      const page = await fetchPage(0);
      fetchedCount = page.actors.length;
      setActors(page.actors);
      applyState(page.actors);
      setHasMore(page.hasMore && page.actors.length > 0);
    } catch {
      setActors([]);
    } finally {
      setLoading(false);
    }
  })();

  const loadMore = async () => {
    if (loadingMore() || !hasMore()) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(fetchedCount);
      fetchedCount += page.actors.length;
      const seen = new Set(actors().map((a) => a.ap_id));
      const fresh = page.actors.filter((a) => !seen.has(a.ap_id));
      setActors((prev) => [...prev, ...fresh]);
      applyState(fresh);
      // An empty page means the offset ran past the end regardless of what
      // `hasMore` claims — stop offering a button that can't make progress.
      setHasMore(page.hasMore && page.actors.length > 0);
    } catch {
      app.toast("読み込みに失敗しました", "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleFollow = async (actor: Actor) => {
    if (busyId()) return;
    setBusyId(actor.ap_id);
    const following = followState()[actor.ap_id];
    setFollowState((prev) => ({ ...prev, [actor.ap_id]: !following }));
    try {
      if (following) await unfollow(actor.ap_id);
      else await follow(actor.ap_id);
    } catch {
      setFollowState((prev) => ({ ...prev, [actor.ap_id]: following }));
      app.toast("操作に失敗しました", "error");
    } finally {
      setBusyId(null);
    }
  };

  let dialogRoot: HTMLDivElement | undefined;
  return (
    <div
      class="p-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={props.mode === "followers" ? "フォロワー" : "フォロー中"}
      ref={(el) => (dialogRoot = el)}
    >
      <DialogA11y root={() => dialogRoot} onClose={props.onClose} />
      <button
        type="button"
        class="p-sheet-dismiss"
        aria-label="閉じる"
        onClick={props.onClose}
      />
      <div class="p-sheet-panel">
        <div class="p-sheet-head">
          <strong>
            {props.mode === "followers" ? "フォロワー" : "フォロー中"}
          </strong>
          <button type="button" onClick={props.onClose} aria-label="閉じる">
            <CloseIcon />
          </button>
        </div>
        <div class="p-sheet-body">
          <Show
            when={!loading()}
            fallback={
              <div class="p-detail-loading">
                <SpinnerIcon />
              </div>
            }
          >
            <For
              each={actors()}
              fallback={<p class="p-detail-empty">まだいません</p>}
            >
              {(actor) => (
                <div class="p-sheet-row">
                  <button
                    type="button"
                    class="p-sheet-row-open"
                    onClick={() => props.onOpenProfile(actor.ap_id)}
                  >
                    <UserAvatar value={actor} size={40} />
                    <span class="p-sheet-row-main">
                      <strong>{titleFor(actor)}</strong>
                      <small>{fullHandle(actor)}</small>
                    </span>
                  </button>
                  <Show when={actor.ap_id !== props.selfApId}>
                    <button
                      type="button"
                      classList={{
                        "p-sheet-follow": true,
                        "is-following": followState()[actor.ap_id],
                      }}
                      disabled={busyId() === actor.ap_id}
                      onClick={() => void toggleFollow(actor)}
                    >
                      {followState()[actor.ap_id] ? "フォロー中" : "フォロー"}
                    </button>
                  </Show>
                </div>
              )}
            </For>
            <Show when={hasMore()}>
              <div class="p-timeline-more">
                <button
                  type="button"
                  disabled={loadingMore()}
                  onClick={() => void loadMore()}
                >
                  {loadingMore() ? "読み込み中…" : "もっと見る"}
                </button>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
