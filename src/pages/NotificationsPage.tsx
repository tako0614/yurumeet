import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import {
  acceptFollowRequest,
  fetchNotifications,
  markNotificationsRead,
  type Notification,
  rejectFollowRequest,
} from "@takosjp/yurucommu-api";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { useApp } from "../lib/app-context.tsx";
import {
  formatPostTime,
  postPath,
  profilePath,
  SpinnerIcon,
  titleFor,
  UserAvatar,
} from "../lib/ui.tsx";

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "reply", label: "返信" },
  { key: "mention", label: "メンション" },
  { key: "follow", label: "フォロー" },
  { key: "like", label: "いいね" },
];

const TEXT: Record<Notification["type"], string> = {
  follow: "さんがフォローしました",
  follow_request: "さんがフォローをリクエストしました",
  like: "さんがいいねしました",
  announce: "さんがリポストしました",
  reply: "さんが返信しました",
  mention: "さんがメンションしました",
};

function NotifIcon(props: { type: Notification["type"] }): JSX.Element {
  const cls = () => `c-notif-icon is-${props.type}`;
  return (
    <span class={cls()} aria-hidden="true">
      <Show when={props.type === "like"}>
        <svg viewBox="0 0 24 24">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" />
        </svg>
      </Show>
      <Show when={props.type === "announce"}>
        <svg viewBox="0 0 24 24">
          <path d="m17 2 4 4-4 4" />
          <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
          <path d="m7 22-4-4 4-4" />
          <path d="M21 13v1a4 4 0 0 1-4 4H3" />
        </svg>
      </Show>
      <Show when={props.type === "reply"}>
        <svg viewBox="0 0 24 24">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
        </svg>
      </Show>
      <Show when={props.type === "mention"}>
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
          <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" />
        </svg>
      </Show>
      <Show when={props.type === "follow" || props.type === "follow_request"}>
        <svg viewBox="0 0 24 24">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M19 8v6M22 11h-6" />
        </svg>
      </Show>
    </span>
  );
}

export default function NotificationsPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [items, setItems] = createSignal<Notification[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  const [pending, setPending] = createSignal<Record<string, boolean>>({});
  const [filter, setFilter] = createSignal("all");
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);

  let loadGen = 0;
  const load = () => {
    const type = filter();
    const myGen = ++loadGen;
    setLoading(true);
    setError(false);
    setCursor(null);
    setHasMore(false);
    void (async () => {
      try {
        const page = await fetchNotifications({ limit: 30, type });
        if (myGen !== loadGen) return;
        setItems(page.notifications);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        const unread = page.notifications
          .filter((n) => !n.read)
          .map((n) => n.id);
        if (unread.length > 0) {
          try {
            await markNotificationsRead(unread);
            app.refreshBadges();
          } catch {
            /* mark-read failure must not discard the loaded list */
          }
        }
      } catch {
        if (myGen === loadGen) setError(true);
      } finally {
        if (myGen === loadGen) setLoading(false);
      }
    })();
  };

  const loadMore = async () => {
    const before = cursor();
    if (loadingMore() || !hasMore() || !before) return;
    setLoadingMore(true);
    try {
      const page = await fetchNotifications({
        limit: 30,
        type: filter(),
        before,
      });
      const seen = new Set(items().map((n) => n.id));
      setItems((prev) => [
        ...prev,
        ...page.notifications.filter((n) => !seen.has(n.id)),
      ]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      app.toast("通知を読み込めませんでした", "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const selectFilter = (key: string) => {
    if (key === filter()) return;
    setFilter(key);
    load();
  };

  onMount(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", onVisible),
    );
  });

  const targetPath = (n: Notification) =>
    n.object_ap_id ? postPath(n.object_ap_id) : profilePath(n.actor.ap_id);

  const handleRequest = async (
    n: Notification,
    action: "accept" | "reject",
  ) => {
    if (pending()[n.id]) return;
    setPending((p) => ({ ...p, [n.id]: true }));
    try {
      if (action === "accept") await acceptFollowRequest(n.actor.ap_id);
      else await rejectFollowRequest(n.actor.ap_id);
      setItems((prev) => prev.filter((x) => x.id !== n.id));
      app.toast(action === "accept" ? "承認しました" : "拒否しました");
    } catch {
      app.toast("操作に失敗しました", "error");
    } finally {
      setPending((p) => ({ ...p, [n.id]: false }));
    }
  };

  return (
    <PageLayout active="notifications">
      <PageHeader title="通知" back={false} />
      <div class="p-notif-filters" role="tablist">
        <For each={FILTERS}>
          {(f) => (
            <button
              type="button"
              role="tab"
              aria-selected={filter() === f.key}
              classList={{
                "p-notif-filter": true,
                "is-active": filter() === f.key,
              }}
              onClick={() => selectFilter(f.key)}
            >
              {f.label}
            </button>
          )}
        </For>
      </div>
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
                <p>通知を読み込めませんでした</p>
                <button type="button" onClick={load}>
                  再読み込み
                </button>
              </div>
            }
          >
            <For
              each={items()}
              fallback={
                <div class="p-timeline-state">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <p>通知はありません</p>
                </div>
              }
            >
              {(n) => (
                <div
                  classList={{ "c-notif": true, "is-unread": !n.read }}
                  role={n.type === "follow_request" ? undefined : "link"}
                  tabindex={n.type === "follow_request" ? undefined : 0}
                  onClick={() => {
                    if (n.type !== "follow_request") navigate(targetPath(n));
                  }}
                  onKeyDown={(event) => {
                    if (
                      n.type !== "follow_request" &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      navigate(targetPath(n));
                    }
                  }}
                >
                  <NotifIcon type={n.type} />
                  <A
                    href={profilePath(n.actor.ap_id)}
                    class="c-notif-avatar"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <UserAvatar value={n.actor} size={40} />
                  </A>
                  <div class="c-notif-main">
                    <p>
                      <A
                        href={profilePath(n.actor.ap_id)}
                        class="c-notif-name"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <strong>{titleFor(n.actor)}</strong>
                      </A>
                      {TEXT[n.type]}
                    </p>
                    <span>{formatPostTime(n.created_at)}</span>
                    <Show when={n.type === "follow_request"}>
                      <div class="c-notif-actions">
                        <button
                          type="button"
                          class="is-primary"
                          disabled={pending()[n.id]}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRequest(n, "accept");
                          }}
                        >
                          承認
                        </button>
                        <button
                          type="button"
                          disabled={pending()[n.id]}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRequest(n, "reject");
                          }}
                        >
                          拒否
                        </button>
                      </div>
                    </Show>
                  </div>
                  <Show when={!n.read}>
                    <span class="c-notif-dot" aria-hidden="true" />
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
        </Show>
      </div>
    </PageLayout>
  );
}
