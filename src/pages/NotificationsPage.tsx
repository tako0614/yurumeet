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
  archiveAllNotifications,
  archiveNotifications,
  fetchNotifications,
  markNotificationsRead,
  type Notification,
  rejectFollowRequest,
  unarchiveNotifications,
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
  { key: "announce", label: "リポスト" },
];

type NotificationTarget = Notification & {
  target_url?: string | null;
  target_kind?: "post" | "story" | "profile" | "community" | "notifications";
};

function targetsStory(notification: Notification): boolean {
  return (
    (notification as NotificationTarget).target_kind === "story" ||
    !!notification.object_ap_id?.includes("/ap/stories/")
  );
}

function safeNotificationPath(value: string | null | undefined): string | null {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/.test(value)
  ) {
    return null;
  }
  return value;
}

const TEXT: Record<Notification["type"], string> = {
  follow: "さんがフォローしました",
  follow_request: "さんがフォローをリクエストしました",
  like: "さんがいいねしました",
  announce: "さんがリポストしました",
  reply: "さんが返信しました",
  mention: "さんがメンションしました",
};

function notificationText(notification: Notification): string {
  if (notification.type === "like" && targetsStory(notification)) {
    return "さんがストーリーにいいねしました";
  }
  return TEXT[notification.type];
}

function ArchiveIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M6 7v13h12V7M9 11h6M5 3h14l1 4H4l1-4Z" />
    </svg>
  );
}

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
  const [viewArchived, setViewArchived] = createSignal(false);
  const [archiving, setArchiving] = createSignal<Record<string, boolean>>({});
  const [archivingAll, setArchivingAll] = createSignal(false);
  const archiveMutationPending = () =>
    archivingAll() || Object.values(archiving()).some(Boolean);

  let loadGen = 0;
  const load = () => {
    const type = filter();
    const archived = viewArchived();
    const myGen = ++loadGen;
    setLoading(true);
    setError(false);
    setCursor(null);
    setHasMore(false);
    void (async () => {
      try {
        const page = await fetchNotifications({ limit: 30, type, archived });
        if (myGen !== loadGen) return;
        setItems(page.notifications);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
        const unread = (archived ? [] : page.notifications)
          .filter((n) => !n.read)
          .map((n) => n.id);
        if (unread.length > 0) {
          try {
            await markNotificationsRead(unread);
            if (myGen === loadGen) {
              const marked = new Set(unread);
              setItems((prev) =>
                prev.map((n) =>
                  !n.read && marked.has(n.id) ? { ...n, read: true } : n,
                ),
              );
              app.refreshBadges();
            }
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
    if (loadingMore() || archiveMutationPending() || !hasMore() || !before) {
      return;
    }
    const myGen = loadGen;
    const type = filter();
    const archived = viewArchived();
    setLoadingMore(true);
    try {
      const page = await fetchNotifications({
        limit: 30,
        type,
        before,
        archived,
      });
      if (
        myGen !== loadGen ||
        type !== filter() ||
        archived !== viewArchived()
      ) {
        return;
      }
      const seen = new Set(items().map((n) => n.id));
      setItems((prev) => [
        ...prev,
        ...page.notifications.filter((n) => !seen.has(n.id)),
      ]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);

      const unread = (archived ? [] : page.notifications)
        .filter((n) => !n.read)
        .map((n) => n.id);
      if (unread.length > 0) {
        try {
          await markNotificationsRead(unread);
          if (myGen === loadGen) {
            const marked = new Set(unread);
            setItems((prev) =>
              prev.map((n) =>
                !n.read && marked.has(n.id) ? { ...n, read: true } : n,
              ),
            );
            app.refreshBadges();
          }
        } catch {
          /* keep the rows unread when the server write fails */
        }
      }
    } catch {
      app.toast("通知を読み込めませんでした", "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const selectFilter = (key: string) => {
    if (archiveMutationPending() || key === filter()) return;
    setFilter(key);
    load();
  };

  const toggleArchived = () => {
    if (archiveMutationPending()) return;
    setViewArchived((value) => !value);
    load();
  };

  onMount(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    const onFocus = () => load();
    document.addEventListener("visibilitychange", onVisible);
    globalThis.addEventListener("focus", onFocus);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisible);
      globalThis.removeEventListener("focus", onFocus);
    });
  });

  const targetPath = (n: Notification): string | null => {
    const declaredTarget = safeNotificationPath(
      (n as NotificationTarget).target_url,
    );
    if (declaredTarget) return declaredTarget;
    if (targetsStory(n) && n.object_ap_id) {
      return `/?story=${encodeURIComponent(n.object_ap_id)}`;
    }
    if (n.type === "follow" || n.type === "follow_request") {
      return profilePath(n.actor.ap_id);
    }
    return n.object_ap_id ? postPath(n.object_ap_id) : null;
  };

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
      app.refreshBadges();
      app.toast(action === "accept" ? "承認しました" : "拒否しました");
    } catch {
      app.toast("操作に失敗しました", "error");
    } finally {
      setPending((p) => ({ ...p, [n.id]: false }));
    }
  };

  const handleArchiveToggle = async (notification: Notification) => {
    if (archivingAll() || archiving()[notification.id]) return;
    const archived = viewArchived();
    setArchiving((prev) => ({ ...prev, [notification.id]: true }));
    setItems((prev) => prev.filter((item) => item.id !== notification.id));
    try {
      if (archived) await unarchiveNotifications([notification.id]);
      else await archiveNotifications([notification.id]);
      app.refreshBadges();
      // Invalidate any focus refresh/load-more result that raced the write and
      // reload the view that is current when the mutation completes.
      load();
    } catch {
      app.toast(
        archived
          ? "アーカイブを解除できませんでした"
          : "アーカイブできませんでした",
        "error",
      );
      load();
    } finally {
      setArchiving((prev) => {
        const next = { ...prev };
        delete next[notification.id];
        return next;
      });
    }
  };

  const handleArchiveAll = async () => {
    if (
      archiveMutationPending() ||
      viewArchived() ||
      filter() !== "all" ||
      items().length === 0
    ) {
      return;
    }
    setArchivingAll(true);
    try {
      await archiveAllNotifications();
      app.refreshBadges();
      load();
    } catch {
      app.toast("通知をアーカイブできませんでした", "error");
      load();
    } finally {
      setArchivingAll(false);
    }
  };

  return (
    <PageLayout active="notifications">
      <PageHeader
        title={viewArchived() ? "アーカイブ" : "通知"}
        back={false}
        actions={
          <>
            <Show
              when={!viewArchived() && filter() === "all" && items().length > 0}
            >
              <button
                type="button"
                class="p-notif-header-action"
                disabled={archiveMutationPending()}
                onClick={() => void handleArchiveAll()}
              >
                すべてアーカイブ
              </button>
            </Show>
            <button
              type="button"
              class="p-notif-header-action"
              disabled={archiveMutationPending()}
              onClick={toggleArchived}
            >
              {viewArchived() ? "受信箱" : "アーカイブ"}
            </button>
          </>
        }
      />
      <div
        class="p-notif-filters"
        role="tablist"
        aria-label="通知の種類"
        onKeyDown={(event) => {
          // Roving arrow-key navigation between the filter tabs.
          if (
            event.key !== "ArrowRight" &&
            event.key !== "ArrowLeft" &&
            event.key !== "Home" &&
            event.key !== "End"
          ) {
            return;
          }
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]:not(:disabled)',
            ),
          );
          if (tabs.length === 0) return;
          const current = tabs.findIndex(
            (tab) => tab === document.activeElement,
          );
          let next: number;
          if (event.key === "Home") next = 0;
          else if (event.key === "End") next = tabs.length - 1;
          else if (event.key === "ArrowRight") {
            next = current < 0 ? 0 : (current + 1) % tabs.length;
          } else {
            next =
              current < 0
                ? tabs.length - 1
                : (current - 1 + tabs.length) % tabs.length;
          }
          event.preventDefault();
          tabs[next].focus();
          tabs[next].click();
        }}
      >
        <For each={FILTERS}>
          {(f) => (
            <button
              type="button"
              role="tab"
              aria-selected={filter() === f.key}
              tabindex={filter() === f.key ? 0 : -1}
              disabled={archiveMutationPending()}
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
                  <p>
                    {viewArchived()
                      ? "アーカイブした通知はありません"
                      : "通知はありません"}
                  </p>
                </div>
              }
            >
              {(n) => {
                const target = targetPath(n);
                const rowLinked =
                  !!target && (viewArchived() || n.type !== "follow_request");
                return (
                  <div
                    classList={{ "c-notif": true, "is-unread": !n.read }}
                    role={rowLinked ? "link" : undefined}
                    tabindex={rowLinked ? 0 : undefined}
                    onClick={() => {
                      if (rowLinked && target) navigate(target);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        rowLinked &&
                        target &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        navigate(target);
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
                        {notificationText(n)}
                      </p>
                      <span>{formatPostTime(n.created_at)}</span>
                      <Show
                        when={!viewArchived() && n.type === "follow_request"}
                      >
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
                    <button
                      type="button"
                      class="c-notif-archive"
                      disabled={archivingAll() || archiving()[n.id]}
                      aria-label={
                        viewArchived() ? "アーカイブを解除" : "アーカイブ"
                      }
                      title={viewArchived() ? "アーカイブを解除" : "アーカイブ"}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleArchiveToggle(n);
                      }}
                    >
                      <ArchiveIcon />
                    </button>
                  </div>
                );
              }}
            </For>
            <Show when={hasMore()}>
              <div class="p-timeline-more">
                <button
                  type="button"
                  disabled={loadingMore() || archiveMutationPending()}
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
