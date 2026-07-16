import { createSignal, For, onMount, Show } from "solid-js";
import { fetchBookmarks, type Post } from "@takosjp/yurucommu-api";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { PostCard } from "../components/timeline/PostCard.tsx";
import { useApp } from "../lib/app-context.tsx";
import { SpinnerIcon } from "../lib/ui.tsx";

export default function BookmarksPage() {
  const app = useApp();
  const [posts, setPosts] = createSignal<Post[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);

  const load = () => {
    setLoading(true);
    setError(false);
    setCursor(null);
    setHasMore(false);
    void (async () => {
      try {
        const page = await fetchBookmarks({ limit: 30 });
        setPosts(page.posts);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  };
  onMount(load);

  const loadMore = async () => {
    const before = cursor();
    if (loadingMore() || !hasMore() || !before) return;
    setLoadingMore(true);
    try {
      const page = await fetchBookmarks({ limit: 30, before });
      const seen = new Set(posts().map((p) => p.ap_id));
      setPosts((prev) => [
        ...prev,
        ...page.posts.filter((p) => !seen.has(p.ap_id)),
      ]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      app.toast("読み込みに失敗しました", "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const patchPost = (apId: string, patch: (p: Post) => Post) =>
    setPosts((prev) => prev.map((p) => (p.ap_id === apId ? patch(p) : p)));
  const removePost = (apId: string) =>
    setPosts((prev) => prev.filter((p) => p.ap_id !== apId));

  return (
    <PageLayout>
      <PageHeader title="ブックマーク" />
      <div class="p-page-body">
        <Show
          when={!loading()}
          fallback={
            <div class="p-detail-loading">
              <SpinnerIcon />
            </div>
          }
        >
          <Show
            when={!error()}
            fallback={
              <div class="p-timeline-state">
                <p>ブックマークを読み込めませんでした</p>
                <button type="button" onClick={load}>
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
                  <p>ブックマークはありません</p>
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
                />
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
        </Show>
      </div>
    </PageLayout>
  );
}
