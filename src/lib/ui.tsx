import { Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { serverUrl } from "../server-config.ts";

/** Minimal actor-ish shape shared by Actor, PostAuthor, DMContact, etc. */
export type ActorLike = {
  ap_id?: string;
  name?: string | null;
  preferred_username?: string;
  username?: string;
  icon_url?: string | null;
};

export function titleFor(value: ActorLike): string {
  return value.name || value.preferred_username || value.username || "Yurumeet";
}

export function initialFor(value: ActorLike): string {
  return titleFor(value).slice(0, 1).toUpperCase() || "Y";
}

export function actorHandle(value: ActorLike): string {
  const handle = value.preferred_username || value.username || "user";
  return handle.startsWith("@") ? handle : `@${handle}`;
}

/** Secondary line for a conversation/contact row. */
export function contactSubtitle(contact: {
  type?: "user" | "community";
  username?: string;
  preferred_username?: string;
  member_count?: number;
}): string {
  if (contact.type === "community") {
    return contact.member_count
      ? `${contact.member_count}人のメンバー`
      : "グループ";
  }
  const username = contact.username ?? "";
  return username.startsWith("@")
    ? username
    : `@${contact.preferred_username ?? username}`;
}

/** Full federated handle `@user@domain` when a domain can be derived. */
export function fullHandle(value: ActorLike): string {
  const username = value.username ?? "";
  if (username.includes("@")) {
    return username.startsWith("@") ? username : `@${username}`;
  }
  return actorHandle(value);
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatPostTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 1) return "今";
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}日`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * Timestamp for a conversation-list row: time of day for today, "昨日" for
 * yesterday, month/day within the last year, otherwise a full date. (A bare
 * HH:MM reads as "today" for rows that are actually weeks old.)
 */
export function formatListTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(new Date()) - startOfDay(date)) / 86400000,
  );
  if (diffDays <= 0) return formatTime(value);
  if (diffDays === 1) return "昨日";
  if (diffDays < 365) {
    return new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatJoined(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
  }).format(date);
}

export function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** "今日" / "昨日" / "M月D日" for a chat date divider. */
export function formatDayLabel(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(new Date()) - startOfDay(d)) / 86400000,
  );
  if (diffDays === 0) return "今日";
  if (diffDays === 1) return "昨日";
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
  }).format(d);
}

/**
 * Render plain post text with URLs turned into real links and `@mentions` /
 * `#hashtags` highlighted. Links stop click propagation so tapping them does not
 * also trigger an ancestor's navigate-to-detail handler.
 */
export function renderRichText(text: string): JSX.Element {
  const pattern =
    /(https?:\/\/[^\s]+)|(@[\p{L}\p{N}_.-]+(?:@[\p{L}\p{N}_.-]+)?)|(#[\p{L}\p{N}_]+)/gu;
  const nodes: JSX.Element[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const [whole, url, mention, hashtag] = match;
    if (url) {
      const href = url.replace(/[.,!?;:)]+$/, "");
      const trail = url.slice(href.length);
      nodes.push(
        <a
          href={href}
          class="c-rich-link"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {href.replace(/^https?:\/\//, "")}
        </a>,
      );
      if (trail) nodes.push(trail);
    } else if (mention) {
      nodes.push(<span class="c-rich-tag">{mention}</span>);
    } else if (hashtag) {
      nodes.push(<span class="c-rich-tag">{hashtag}</span>);
    } else {
      nodes.push(whole);
    }
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Human "あとN時間 / Nか分" until a short-lived note expires. */
export function formatNoteExpiry(value: string | null | undefined): string {
  if (!value) return "";
  const ms = new Date(value).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "まもなく消えます";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `あと${minutes}分で消えます`;
  const hours = Math.round(minutes / 60);
  return `あと${hours}時間で消えます`;
}

export function stripHtml(value: string): string {
  if (typeof document === "undefined") return value.replace(/<[^>]*>/g, " ");
  const el = document.createElement("div");
  el.innerHTML = value;
  return el.textContent || el.innerText || "";
}

export function attachmentSrc(
  attachment: { url?: string; r2_key?: string },
  origin?: string | null,
): string | undefined {
  const direct = attachment.url;
  if (direct) {
    if (/^https?:\/\//.test(direct)) return direct;
    return origin ? serverUrl(origin, direct) : direct;
  }
  const key = attachment.r2_key?.replace(/^uploads\//, "");
  if (!key || !origin) return undefined;
  return serverUrl(origin, `/media/${key}`);
}

/**
 * Decode an ActivityPub id carried in a URL path segment (`/post/<id>`,
 * `/profile/<id>`). An AP id is a full URL, so it is percent-encoded into the
 * segment; a full-page load collapses `://` to `:/` and splits the segment,
 * so the matching routes use a splat (`*param`) and this reassembles the tail.
 */
export function decodeApIdParam(raw: string | undefined | null): string {
  if (!raw) return "";
  let value = raw;
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // leave raw if not valid percent-encoding
    }
  }
  return value.replace(/^(https?):\/(?!\/)/i, "$1://");
}

/** Route path to a profile, keyed by the actor AP id (a full URL). */
export function profilePath(apId: string | undefined | null): string {
  if (!apId) return "/profile";
  return `/profile/${encodeURIComponent(apId)}`;
}

/** Route path to a post detail view, keyed by the post AP id. */
export function postPath(apId: string): string {
  return `/post/${encodeURIComponent(apId)}`;
}

/** Route path to a community page, keyed by the community AP id. */
export function communityPath(apId: string): string {
  return `/communities/${encodeURIComponent(apId)}`;
}

export function UserAvatar(props: {
  value: ActorLike;
  size?: number;
  class?: string;
}): JSX.Element {
  const style = () =>
    props.size
      ? {
          width: `${props.size}px`,
          height: `${props.size}px`,
          "font-size": `${Math.round(props.size * 0.4)}px`,
        }
      : undefined;
  return (
    <span
      class={`yc-avatar ${props.class ?? ""}`}
      style={style()}
      aria-hidden="true"
    >
      <Show when={props.value.icon_url} fallback={initialFor(props.value)}>
        {(src) => <img src={src()} alt="" />}
      </Show>
    </span>
  );
}

/** An avatar that navigates to the actor's profile when tapped. */
export function AvatarLink(props: {
  value: ActorLike;
  size?: number;
  class?: string;
}): JSX.Element {
  return (
    <A
      href={profilePath(props.value.ap_id ?? null)}
      class={`yc-avatar-link ${props.class ?? ""}`}
      aria-label={`${titleFor(props.value)} のプロフィール`}
    >
      <UserAvatar value={props.value} size={props.size} />
    </A>
  );
}

/** A display name that navigates to the actor's profile when tapped. */
export function NameLink(props: {
  value: ActorLike;
  class?: string;
}): JSX.Element {
  return (
    <A
      href={profilePath(props.value.ap_id ?? null)}
      class={`yc-name-link ${props.class ?? ""}`}
    >
      {titleFor(props.value)}
    </A>
  );
}

export function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function PlusIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function BackIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="14 18 8 12 14 6 14 6" />
    </svg>
  );
}

export function SpinnerIcon(): JSX.Element {
  return (
    <svg class="yc-spinner" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
