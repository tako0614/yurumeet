import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { fetchBookmarks, type Post } from "@takosjp/yurucommu-api";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { PostCard } from "../components/timeline/PostCard.tsx";
import { useApp } from "../lib/app-context.tsx";
import { createTimelineFeed } from "../lib/timeline-feed.ts";
import { SpinnerIcon } from "../lib/ui.tsx";

export default function BookmarksPage() {
  const app = useApp();
  const feed = createTimelineFeed({
    fetchPage: fetchBookmarks,
    onError: (kind) =>
      app.toast(
        kind === "refresh"
          ? "ブックマークを確認できませんでした。表示中の一覧は更新されていません"
          : "読み込みに失敗しました",
        "error",
      ),
  });
  const { posts, loading, error, hasMore, loadingMore } = feed;
  // A refreshed Post is a new For item. Pending IDs must survive that remount.
  const [pendingBookmarks, setPendingBookmarks] = createSignal(
    new Set<string>(),
  );
  const bookmarkPendingChanged = (apId: string, pending: boolean) =>
    setPendingBookmarks((previous) => {
      const next = new Set(previous);
      if (pending) next.add(apId);
      else next.delete(apId);
      return next;
    });
  onMount(() => void feed.refresh());
  onCleanup(feed.dispose);
  const patchPost = (apId: string, patch: (p: Post) => Post) =>
    feed.setPosts((prev) => prev.map((p) => (p.ap_id === apId ? patch(p) : p)));
  const removePost = feed.acknowledgeRemoved;

  return (
    <PageLayout>
      <PageHeader
        title="ブックマーク"
        actions={
          <button
            type="button"
            disabled={loading()}
            onClick={() => void feed.refresh()}
          >
            最新に更新
          </button>
        }
      />
      <div class="p-page-body">
        <Show
          when={!loading() || posts().length > 0}
          fallback={
            <div class="p-detail-loading">
              <SpinnerIcon />
            </div>
          }
        >
          <Show when={error() && posts().length > 0}>
            <div class="p-timeline-state" role="status">
              <p>
                ブックマークを確認できませんでした。表示中の一覧は更新されていません
              </p>
              <button type="button" onClick={() => void feed.refresh()}>
                再読み込み
              </button>
            </div>
          </Show>
          <Show
            when={!error() || posts().length > 0}
            fallback={
              <div class="p-timeline-state">
                <p>ブックマークを読み込めませんでした</p>
                <button type="button" onClick={() => void feed.refresh()}>
                  再読み込み
                </button>
              </div>
            }
          >
            <For
              each={posts()}
              fallback={
                <div class="p-timeline-state">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                  <p>
                    {hasMore()
                      ? "続きのブックマークを読み込んでください"
                      : "ブックマークはありません"}
                  </p>
                </div>
              }
            >
              {(post) => (
                <PostCard
                  post={post}
                  origin={app.origin()}
                  currentActorApId={app.actor().ap_id}
                  onPatch={patchPost}
                  onRemove={removePost}
                  bookmarkPending={pendingBookmarks().has(post.ap_id)}
                  onBookmarkPendingChange={bookmarkPendingChanged}
                  onBookmarkChange={(apId, bookmarked) => {
                    if (!bookmarked) removePost(apId);
                  }}
                />
              )}
            </For>
            <Show when={hasMore()}>
              <div class="p-timeline-more">
                <button
                  type="button"
                  disabled={loading() || loadingMore() || error()}
                  onClick={() => void feed.loadMore()}
                >
                  {loadingMore() ? "読み込み中…" : "もっと見る"}
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </PageLayout>
  );
}
