import { For, Show, type JSX } from "solid-js";
import { A, useLocation, useSearchParams } from "@solidjs/router";
import type { Actor } from "@takosjp/yurucommu-api";
import { UserAvatar } from "../lib/ui.tsx";

function tabKey(value: unknown): NavKey {
  return value === "home" || value === "timeline" ? value : "talk";
}

export type NavKey = "home" | "talk" | "timeline" | "notifications" | "profile";

function NavIcon(props: { name: NavKey }): JSX.Element {
  switch (props.name) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 10.182V22h18V10.182L12 2z" />
          <rect width="6" height="8" x="9" y="14" />
        </svg>
      );
    case "talk":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8.824 18.588 4 21l.653-4.573C3.006 15.001 2 13.095 2 11 2 6.582 6.477 3 12 3s10 3.582 10 8-4.477 8-10 8c-1.11 0-2.178-.145-3.176-.412Z" />
        </svg>
      );
    case "timeline":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "notifications":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    default:
      return <svg viewBox="0 0 24 24" aria-hidden="true" />;
  }
}

const TABS: { key: NavKey; label: string; href: string }[] = [
  { key: "home", label: "ホーム", href: "/?tab=home" },
  { key: "talk", label: "トーク", href: "/?tab=talk" },
  { key: "timeline", label: "タイムライン", href: "/?tab=timeline" },
  { key: "notifications", label: "通知", href: "/notifications" },
];

export function NavRail(props: {
  actor: Actor;
  active?: NavKey;
  hideOnMobile?: boolean;
  unreadNotifications?: number;
  unreadTalk?: number;
}) {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const badgeFor = (key: NavKey): number => {
    if (key === "notifications") return props.unreadNotifications ?? 0;
    if (key === "talk") return props.unreadTalk ?? 0;
    return 0;
  };
  const accessibleLabel = (key: NavKey, label: string): string => {
    const count = badgeFor(key);
    return count > 0 ? `${label}、未読 ${count}件` : label;
  };
  const activeKey = (): NavKey | undefined => {
    if (props.active) return props.active;
    const path = location.pathname;
    if (path.startsWith("/notifications")) return "notifications";
    if (path.startsWith("/profile") || path.startsWith("/users")) {
      return "profile";
    }
    if (path === "/") return tabKey(searchParams.tab);
    return undefined;
  };
  return (
    <header classList={{ "l-header": true, "is-inview": props.hideOnMobile }}>
      <div class="l-header-logo">
        <A
          href="/profile"
          aria-label={`${props.actor.name ?? "自分"} のプロフィール`}
        >
          <UserAvatar value={props.actor} />
        </A>
      </div>
      <ul class="l-header__ul">
        <For each={TABS}>
          {(tab) => (
            <li
              classList={{
                "l-header__ul-item": true,
                "is-active": activeKey() === tab.key,
              }}
            >
              <A
                href={tab.href}
                aria-label={accessibleLabel(tab.key, tab.label)}
              >
                <NavIcon name={tab.key} />
                <span>{tab.label}</span>
                <Show when={badgeFor(tab.key) > 0}>
                  <em class="l-header__badge" aria-hidden="true">
                    {badgeFor(tab.key) > 99 ? "99+" : badgeFor(tab.key)}
                  </em>
                </Show>
              </A>
            </li>
          )}
        </For>
      </ul>
    </header>
  );
}
