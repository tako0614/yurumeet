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

  const load = () => {
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const page = await fetchBookmarks({ limit: 30 });
        setPosts(page.posts);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  };
  onMount(load);

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
          </Show>
        </Show>
      </div>
    </PageLayout>
  );
}
