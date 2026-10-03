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
  let refreshCreated: Set<string> | null = null;
  let chainRemoved = new Set<string>();
  let refreshRemoved: Set<string> | null = null;

  const isCurrent = (requestGeneration: number) =>
    !disposed && generation === requestGeneration;

  const refresh = async () => {
    if (disposed) return;
    const requestGeneration = ++generation;
    const createdIds = new Set<string>();
    refreshCreated = createdIds;
    const removedIds = new Set<string>();
    refreshRemoved = removedIds;
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
        // A GET snapshot can predate a successful creation ACK. Retain only
        // ACKs from this refresh window, taking current rows so local patches
        // and removals are respected. A later refresh has no such overlay.
        setPosts((rows) => {
          const currentCreated = new Map(
            rows
              .filter((post) => createdIds.has(post.ap_id))
              .map((post) => [post.ap_id, post]),
          );
          const seen = new Set<string>();
          const head = page.posts
            .filter((post) => {
              if (removedIds.has(post.ap_id)) return false;
              if (seen.has(post.ap_id)) return false;
              seen.add(post.ap_id);
              return (
                !createdIds.has(post.ap_id) || currentCreated.has(post.ap_id)
              );
            })
            .map((post) => currentCreated.get(post.ap_id) ?? post);
          // Rows already in the server head keep its order. Only a creation
          // missing from that earlier snapshot is added ahead of the head.
          return [
            ...Array.from(currentCreated.values()).filter(
              (post) => !seen.has(post.ap_id),
            ),
            ...head,
          ];
        });
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      });
      // Only a successful new head replaces the cursor-chain removal fence.
      // A failed refresh retains the previous cursor and its confirmed removals.
      chainRemoved = removedIds;
    } catch {
      if (!isCurrent(requestGeneration)) return;
      setError(true);
      if (posts().length > 0) options.onError("refresh");
    } finally {
      if (isCurrent(requestGeneration)) {
        refreshCreated = null;
        refreshRemoved = null;
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
            if (chainRemoved.has(post.ap_id)) return false;
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
    acknowledgeCreated: (post: Post) => {
      if (disposed) return;
      refreshCreated?.add(post.ap_id);
      setPosts((rows) => {
        const existing = rows.findIndex((row) => row.ap_id === post.ap_id);
        if (existing < 0) return [post, ...rows];
        // A head may observe the committed object before its POST ACK arrives.
        // Keep that row's current fields/order rather than inserting the ACK's
        // older representation or a second canonical ID.
        return rows.filter(
          (row, index) => row.ap_id !== post.ap_id || index === existing,
        );
      });
    },
    acknowledgeRemoved: (apId: string) => {
      if (disposed) return;
      chainRemoved.add(apId);
      refreshRemoved?.add(apId);
      refreshCreated?.delete(apId);
      setPosts((rows) => rows.filter((post) => post.ap_id !== apId));
    },
    dispose: () => {
      disposed = true;
      generation += 1;
      activeMore = null;
      refreshCreated = null;
      refreshRemoved = null;
    },
  };
}
