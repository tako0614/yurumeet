import { batch, createSignal } from "solid-js";
import type { Post } from "@takosjp/yurucommu-api";

export type TimelinePage = {
  posts: Post[];
  nextCursor: string | null;
  hasMore: boolean;
};

export function createTimelineFeed(options: {
  fetchPage: (input: {
    limit: number;
    before?: string;
  }) => Promise<TimelinePage>;
  onError: (kind: "refresh" | "more") => void;
  now?: () => number;
}) {
  const [posts, setPosts] = createSignal<Post[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [loadedAt, setLoadedAt] = createSignal(0);
  let generation = 0;
  let disposed = false;
  let activeMore: object | null = null;

  const isCurrent = (requestGeneration: number) =>
    !disposed && generation === requestGeneration;

  const refresh = async () => {
    if (disposed) return;
    const requestGeneration = ++generation;
    // A new head establishes a new cursor chain. An old request may still
    // finish on the network, but must not append or settle the new chain.
    activeMore = null;
    batch(() => {
      setLoading(true);
      setLoadingMore(false);
      setError(false);
    });
    try {
      const page = await options.fetchPage({ limit: 30 });
      if (!isCurrent(requestGeneration)) return;
      batch(() => {
        setPosts(page.posts);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      });
    } catch {
      if (!isCurrent(requestGeneration)) return;
      setError(true);
      if (posts().length > 0) options.onError("refresh");
    } finally {
      if (isCurrent(requestGeneration)) {
        batch(() => {
          setLoadedAt((options.now ?? Date.now)());
          setLoading(false);
        });
      }
    }
  };

  const loadMore = async () => {
    const before = cursor();
    if (disposed || loading() || loadingMore() || !hasMore() || !before) return;
    const requestGeneration = generation;
    const ticket = {};
    activeMore = ticket;
    const ownsRequest = () =>
      isCurrent(requestGeneration) && activeMore === ticket;
    setLoadingMore(true);
    try {
      const page = await options.fetchPage({ limit: 30, before });
      if (!ownsRequest() || cursor() !== before) return;
      batch(() => {
        setPosts((prev) => {
          const seen = new Set(prev.map((post) => post.ap_id));
          const added = page.posts.filter((post) => {
            if (seen.has(post.ap_id)) return false;
            seen.add(post.ap_id);
            return true;
          });
          return [...prev, ...added];
        });
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      });
    } catch {
      if (ownsRequest() && cursor() === before) options.onError("more");
    } finally {
      if (ownsRequest()) {
        activeMore = null;
        setLoadingMore(false);
      }
    }
  };

  return {
    posts,
    setPosts,
    loading,
    error,
    cursor,
    hasMore,
    loadingMore,
    loadedAt,
    refresh,
    loadMore,
    dispose: () => {
      disposed = true;
      generation += 1;
      activeMore = null;
    },
  };
}
