import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import {
  acceptCommunityJoinRequest,
  type CommunityDetail,
  type CommunityJoinRequest,
  type CommunityMember,
  type CommunitySettings,
  createCommunityInvite,
  fetchCommunity,
  fetchCommunityJoinRequests,
  fetchCommunityMembers,
  fetchDMContact,
  joinCommunity,
  leaveCommunity,
  rejectCommunityJoinRequest,
  removeCommunityMember,
  updateCommunityMemberRole,
  updateCommunitySettings,
} from "@takosjp/yurucommu-api";
import { uploadProductMedia } from "../lib/media-upload.ts";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { useApp } from "../lib/app-context.tsx";
import { useChat } from "../lib/chat-context.tsx";
import { createEscapeClose, DialogA11y } from "../lib/dialog.tsx";
import {
  CloseIcon,
  decodeApIdParam,
  profilePath,
  SpinnerIcon,
  titleFor,
  UserAvatar,
} from "../lib/ui.tsx";

const ROLE_LABEL: Record<string, string> = {
  owner: "オーナー",
  moderator: "モデレーター",
  member: "メンバー",
};

const JOIN_POLICY_LABEL: Record<string, string> = {
  open: "だれでも参加できます",
  approval: "参加には承認が必要です",
  invite: "参加には招待が必要です",
};

export default function CommunityPage() {
  const params = useParams();
  const app = useApp();
  const chat = useChat();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const communityId = () => decodeApIdParam(params.communityId);
  const inviteId = () => {
    const raw = searchParams.invite;
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value?.trim() || null;
  };

  const [community, setCommunity] = createSignal<CommunityDetail | null>(null);
  const [members, setMembers] = createSignal<CommunityMember[]>([]);
  const [requests, setRequests] = createSignal<CommunityJoinRequest[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  const [membersError, setMembersError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal<{
    community: CommunityDetail;
    isCurrent: () => boolean;
  } | null>(null);
  const [inviting, setInviting] = createSignal(false);
  const [memberMenuFor, setMemberMenuFor] = createSignal<string | null>(null);
  const [memberBusy, setMemberBusy] = createSignal<string | null>(null);

  const isOwner = () => community()?.member_role === "owner";
  const canInvite = () =>
    community()?.member_role === "owner" ||
    community()?.member_role === "moderator";

  createEscapeClose(
    () => memberMenuFor() !== null,
    () => setMemberMenuFor(null),
  );

  let gen = 0;
  // Returning to the same ID starts a new route lifetime too.
  let routeEpoch = 0;
  const captureRoute = () => {
    const epoch = routeEpoch;
    const id = communityId();
    return () => epoch === routeEpoch && id === communityId();
  };
  onCleanup(() => {
    ++routeEpoch;
    ++gen;
  });
  const load = () => {
    const id = communityId();
    const myGen = ++gen;
    const isCurrent = captureRoute();
    setLoading(true);
    setError(false);
    setMembersError(false);
    setCommunity(null);
    setMembers([]);
    setRequests([]);
    void (async () => {
      try {
        const detail = await fetchCommunity(id);
        if (myGen !== gen || !isCurrent()) return;
        setCommunity(detail);
        // A members fetch failure must not render as 「メンバーがいません」.
        const list = await fetchCommunityMembers(id).catch(() => null);
        if (myGen !== gen || !isCurrent()) return;
        setMembersError(list === null);
        setMembers(list ?? []);
        if (detail.member_role === "owner") {
          const reqs = await fetchCommunityJoinRequests(id).catch(() => []);
          if (myGen !== gen || !isCurrent()) return;
          setRequests(reqs);
        }
      } catch {
        if (myGen === gen && isCurrent()) setError(true);
      } finally {
        if (myGen === gen && isCurrent()) setLoading(false);
      }
    })();
  };
  createEffect(
    on(communityId, () => {
      ++routeEpoch;
      setSettingsOpen(null);
      setBusy(false);
      setInviting(false);
      setMemberMenuFor(null);
      setMemberBusy(null);
      load();
    }),
  );

  const openChat = async () => {
    const c = community();
    if (!c) return;
    const isCurrent = captureRoute();
    try {
      const contact = await fetchDMContact(c.ap_id);
      if (!isCurrent()) return;
      if (contact) {
        // Navigate FIRST so the chat's history entry sits on top of the talk
        // tab (back then closes the chat instead of resurrecting this page).
        navigate("/?tab=talk");
        chat.selectContact(contact);
      } else {
        // Don't leave the button as a silent dead end when the group chat
        // can't be resolved.
        app.toast("トークを開けませんでした", "error");
      }
    } catch {
      if (isCurrent()) app.toast("トークを開けませんでした", "error");
    }
  };

  const handleJoin = async () => {
    const c = community();
    if (!c || busy()) return;
    const isCurrent = captureRoute();
    setBusy(true);
    try {
      const invite = inviteId();
      const { status } = await joinCommunity(
        c.ap_id,
        invite ? { inviteId: invite } : undefined,
      );
      if (status === "joined") chat.refetchContacts();
      if (!isCurrent()) return;
      if (status === "joined") {
        setCommunity({ ...c, is_member: true, member_role: "member" });
        app.toast("参加しました");
        load();
      } else if (status === "pending") {
        setCommunity({ ...c, join_status: "pending" });
        app.toast("参加リクエストを送りました");
      } else {
        app.toast(
          invite
            ? "この招待は使えませんでした"
            : "参加には招待リンクが必要です",
          invite ? "error" : "info",
        );
      }
    } catch {
      if (isCurrent()) app.toast("参加に失敗しました", "error");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const handleLeave = async () => {
    const c = community();
    if (!c || busy()) return;
    const isCurrent = captureRoute();
    setBusy(true);
    try {
      const ok = await app.confirm({
        title: "グループを退出",
        message: `${c.display_name} を退出しますか?`,
        confirmLabel: "退出",
        danger: true,
      });
      if (!ok || !isCurrent()) return;
      await leaveCommunity(c.ap_id);
      chat.refetchContacts();
      if (!isCurrent()) return;
      setCommunity({ ...c, is_member: false, member_role: null });
      app.toast("退出しました");
    } catch {
      if (isCurrent()) app.toast("退出に失敗しました", "error");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const handleRequest = async (
    req: CommunityJoinRequest,
    action: "accept" | "reject",
  ) => {
    const c = community();
    if (!c) return;
    const isCurrent = captureRoute();
    try {
      if (action === "accept") {
        await acceptCommunityJoinRequest(c.ap_id, req.ap_id);
      } else {
        await rejectCommunityJoinRequest(c.ap_id, req.ap_id);
      }
      if (!isCurrent()) return;
      setRequests((prev) => prev.filter((r) => r.ap_id !== req.ap_id));
      app.toast(action === "accept" ? "承認しました" : "拒否しました");
    } catch {
      if (isCurrent()) app.toast("操作に失敗しました", "error");
    }
  };

  const handleCreateInvite = async () => {
    const c = community();
    if (!c || inviting()) return;
    const isCurrent = captureRoute();
    setInviting(true);
    try {
      const invite = await createCommunityInvite(c.ap_id);
      if (!isCurrent()) return;
      // Canonical share origin = the server origin, matching QR / profile
      // share links (which must resolve there for federation). The yurumeet
      // worker serves the app at that origin, so the invite route works.
      const url = `${app.origin()}/communities/${encodeURIComponent(
        c.ap_id,
      )}?invite=${encodeURIComponent(invite.invite_id)}`;
      await navigator.clipboard.writeText(url);
      if (isCurrent()) app.toast("招待リンクをコピーしました");
    } catch {
      if (isCurrent()) app.toast("招待リンクを作成できませんでした", "error");
    } finally {
      if (isCurrent()) setInviting(false);
    }
  };

  const handleKick = async (member: CommunityMember) => {
    const c = community();
    if (!c || memberBusy()) return;
    const isCurrent = captureRoute();
    setMemberMenuFor(null);
    setMemberBusy(member.ap_id);
    try {
      const ok = await app.confirm({
        title: "メンバーを削除",
        message: `${titleFor(member)} をグループから削除しますか?`,
        confirmLabel: "削除",
        danger: true,
      });
      if (!ok || !isCurrent()) return;
      await removeCommunityMember(c.ap_id, member.ap_id);
      if (!isCurrent()) return;
      setMembers((prev) => prev.filter((m) => m.ap_id !== member.ap_id));
      setCommunity((prev) =>
        prev
          ? { ...prev, member_count: Math.max(0, prev.member_count - 1) }
          : prev,
      );
      app.toast("メンバーを削除しました");
    } catch {
      if (isCurrent()) app.toast("操作に失敗しました", "error");
    } finally {
      if (isCurrent()) setMemberBusy(null);
    }
  };

  const handleRoleChange = async (
    member: CommunityMember,
    role: "moderator" | "member",
  ) => {
    const c = community();
    if (!c || memberBusy()) return;
    const isCurrent = captureRoute();
    setMemberMenuFor(null);
    setMemberBusy(member.ap_id);
    try {
      await updateCommunityMemberRole(c.ap_id, member.ap_id, role);
      if (!isCurrent()) return;
      setMembers((prev) =>
        prev.map((m) => (m.ap_id === member.ap_id ? { ...m, role } : m)),
      );
      app.toast(
        role === "moderator"
          ? "モデレーターにしました"
          : "メンバーに戻しました",
      );
    } catch {
      if (isCurrent()) app.toast("操作に失敗しました", "error");
    } finally {
      if (isCurrent()) setMemberBusy(null);
    }
  };

  return (
    <PageLayout>
      <PageHeader title={community()?.display_name ?? "グループ"} />
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
            when={!error() && community()}
            fallback={
              <div class="p-timeline-state">
                <p>グループを読み込めませんでした</p>
                <button type="button" onClick={load}>
                  再読み込み
                </button>
              </div>
            }
          >
            {(c) => (
              <>
                <div class="p-community-head">
                  <div class="p-community-avatar">
                    <UserAvatar
                      value={{ name: c().display_name, icon_url: c().icon_url }}
                      size={72}
                    />
                  </div>
                  <strong class="p-community-name">{c().display_name}</strong>
                  <span class="p-community-handle">@{c().name}</span>
                  <Show when={c().summary}>
                    <p class="p-community-summary">{c().summary}</p>
                  </Show>
                  <p class="p-community-stats">
                    <span>{c().member_count} メンバー</span>
                    <Show when={c().visibility === "private"}>
                      <span class="p-community-badge">非公開</span>
                    </Show>
                    <Show when={JOIN_POLICY_LABEL[c().join_policy]}>
                      <span class="p-community-policy">
                        {JOIN_POLICY_LABEL[c().join_policy]}
                      </span>
                    </Show>
                  </p>
                  <div class="p-community-actions">
                    <Show
                      when={c().is_member}
                      fallback={
                        <button
                          type="button"
                          class="p-community-join"
                          disabled={busy() || c().join_status === "pending"}
                          onClick={() => void handleJoin()}
                        >
                          {c().join_status === "pending"
                            ? "リクエスト済み"
                            : c().join_policy === "invite" && !inviteId()
                              ? "招待制"
                              : "参加"}
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="p-community-open"
                        onClick={() => void openChat()}
                      >
                        トークを開く
                      </button>
                      <Show when={canInvite()}>
                        <button
                          type="button"
                          class="p-community-invite"
                          disabled={inviting()}
                          onClick={() => void handleCreateInvite()}
                        >
                          {inviting() ? "作成中…" : "招待リンク"}
                        </button>
                      </Show>
                      <Show when={isOwner()}>
                        <button
                          type="button"
                          class="p-community-settings"
                          onClick={() =>
                            setSettingsOpen({
                              community: c(),
                              isCurrent: captureRoute(),
                            })
                          }
                        >
                          設定
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="p-community-leave"
                        disabled={busy()}
                        onClick={() => void handleLeave()}
                      >
                        退出
                      </button>
                    </Show>
                  </div>
                </div>

                <Show when={isOwner() && requests().length > 0}>
                  <section class="p-community-section">
                    <h2>参加リクエスト</h2>
                    <For each={requests()}>
                      {(req) => (
                        <div class="p-community-member">
                          <A
                            href={profilePath(req.ap_id)}
                            class="p-community-member-link"
                          >
                            <UserAvatar value={req} size={40} />
                            <span>
                              <strong>{titleFor(req)}</strong>
                              <small>@{req.preferred_username}</small>
                            </span>
                          </A>
                          <div class="p-community-req-actions">
                            <button
                              type="button"
                              class="is-primary"
                              onClick={() => void handleRequest(req, "accept")}
                            >
                              承認
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleRequest(req, "reject")}
                            >
                              拒否
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </section>
                </Show>

                <section class="p-community-section">
                  <h2>メンバー ({c().member_count})</h2>
                  <Show when={membersError()}>
                    <div class="p-timeline-state">
                      <p>メンバーを読み込めませんでした</p>
                      <button type="button" onClick={load}>
                        再読み込み
                      </button>
                    </div>
                  </Show>
                  <For
                    each={members()}
                    fallback={
                      <Show when={!membersError()}>
                        <p class="p-detail-empty">メンバーがいません</p>
                      </Show>
                    }
                  >
                    {(member) => (
                      <div class="p-community-member">
                        <A
                          href={profilePath(member.ap_id)}
                          class="p-community-member-link"
                        >
                          <UserAvatar value={member} size={40} />
                          <span>
                            <strong>{titleFor(member)}</strong>
                            <small>@{member.preferred_username}</small>
                          </span>
                        </A>
                        <span class="p-community-role">
                          {ROLE_LABEL[member.role] ?? member.role}
                        </span>
                        <Show
                          when={
                            isOwner() &&
                            member.role !== "owner" &&
                            member.ap_id !== app.actor().ap_id
                          }
                        >
                          <div class="p-community-member-more">
                            <button
                              type="button"
                              class="p-community-member-menu-btn"
                              aria-label={`${titleFor(member)} のメンバー操作`}
                              aria-haspopup="true"
                              aria-expanded={memberMenuFor() === member.ap_id}
                              disabled={memberBusy() === member.ap_id}
                              onClick={() =>
                                setMemberMenuFor(
                                  memberMenuFor() === member.ap_id
                                    ? null
                                    : member.ap_id,
                                )
                              }
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true">
                                <circle cx="5" cy="12" r="1.6" />
                                <circle cx="12" cy="12" r="1.6" />
                                <circle cx="19" cy="12" r="1.6" />
                              </svg>
                            </button>
                            <Show when={memberMenuFor() === member.ap_id}>
                              <button
                                type="button"
                                class="c-post-menu-scrim"
                                aria-label="閉じる"
                                onClick={() => setMemberMenuFor(null)}
                              />
                              <div class="c-post-menu-list" role="menu">
                                <Show
                                  when={member.role === "moderator"}
                                  fallback={
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() =>
                                        void handleRoleChange(
                                          member,
                                          "moderator",
                                        )
                                      }
                                    >
                                      モデレーターにする
                                    </button>
                                  }
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() =>
                                      void handleRoleChange(member, "member")
                                    }
                                  >
                                    メンバーに戻す
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  role="menuitem"
                                  class="is-danger"
                                  onClick={() => void handleKick(member)}
                                >
                                  グループから削除
                                </button>
                              </div>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </section>

                <Show when={settingsOpen()} keyed>
                  {(opened) => (
                    <CommunitySettingsModal
                      community={opened.community}
                      onClose={() => {
                        if (settingsOpen() === opened) setSettingsOpen(null);
                      }}
                      onSaved={(updated) => {
                        if (!opened.isCurrent() || settingsOpen() !== opened)
                          return;
                        setCommunity((prev) =>
                          prev ? { ...prev, ...updated } : prev,
                        );
                        setSettingsOpen(null);
                        app.toast("グループ設定を更新しました");
                      }}
                    />
                  )}
                </Show>
              </>
            )}
          </Show>
        </Show>
      </div>
    </PageLayout>
  );
}

function CommunitySettingsModal(props: {
  community: CommunityDetail;
  onClose: () => void;
  onSaved: (updated: Partial<CommunityDetail>) => void;
}) {
  const initialCommunity = props.community;
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const [displayName, setDisplayName] = createSignal(
    initialCommunity.display_name,
  );
  const [summary, setSummary] = createSignal(initialCommunity.summary ?? "");
  const [iconUrl, setIconUrl] = createSignal(initialCommunity.icon_url ?? "");
  const [joinPolicy, setJoinPolicy] = createSignal(
    initialCommunity.join_policy,
  );
  const [uploading, setUploading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const canSave = () =>
    displayName().trim().length > 0 && !saving() && !uploading();

  const uploadIcon = async (file: File | undefined) => {
    if (!file || !active || saving() || uploading()) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await uploadProductMedia(file);
      if (!active) return;
      setIconUrl(uploaded.url ?? "");
    } catch {
      if (active) setError("画像のアップロードに失敗しました");
    } finally {
      if (active) setUploading(false);
    }
  };

  const save = async (event: Event) => {
    event.preventDefault();
    if (!active || !canSave()) return;
    setSaving(true);
    setError(null);
    const settings: CommunitySettings = {
      display_name: displayName().trim(),
      summary: summary().trim(),
      join_policy: joinPolicy(),
      ...(iconUrl() ? { icon_url: iconUrl() } : {}),
    };
    try {
      await updateCommunitySettings(initialCommunity.ap_id, settings);
      if (!active) return;
      props.onSaved({
        display_name: settings.display_name,
        summary: settings.summary || null,
        icon_url: settings.icon_url || initialCommunity.icon_url,
        join_policy: settings.join_policy,
      });
    } catch {
      if (active) setError("設定を保存できませんでした");
    } finally {
      if (active) setSaving(false);
    }
  };

  let dialogRoot: HTMLDivElement | undefined;
  return (
    <div
      class="p-composer"
      role="dialog"
      aria-modal="true"
      aria-label="グループ設定"
      ref={(el) => (dialogRoot = el)}
    >
      <DialogA11y root={() => dialogRoot} onClose={props.onClose} />
      <button
        type="button"
        class="p-composer-dismiss"
        aria-label="閉じる"
        onClick={props.onClose}
      />
      <form class="p-composer-panel" onSubmit={save}>
        <div class="p-composer-head">
          <button
            type="button"
            class="p-composer-close"
            onClick={props.onClose}
            aria-label="閉じる"
          >
            <CloseIcon />
          </button>
          <strong>グループ設定</strong>
          <button type="submit" class="p-composer-submit" disabled={!canSave()}>
            {saving() ? "保存中" : "保存"}
          </button>
        </div>
        <div class="p-edit-body">
          <label class="p-edit-avatar p-edit-avatar--community">
            <UserAvatar
              value={{
                name: displayName() || initialCommunity.display_name,
                icon_url: iconUrl() || null,
              }}
              size={72}
            />
            <span class="p-edit-avatar-cta">{uploading() ? "…" : "変更"}</span>
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => void uploadIcon(e.currentTarget.files?.[0])}
            />
          </label>
          <div class="p-edit-fields">
            <label class="p-edit-field">
              <span>表示名</span>
              <input
                type="text"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
                autofocus
              />
            </label>
            <label class="p-edit-field">
              <span>説明</span>
              <textarea
                value={summary()}
                rows={3}
                onInput={(e) => setSummary(e.currentTarget.value)}
              />
            </label>
            <label class="p-edit-field">
              <span>参加方法</span>
              <select
                value={joinPolicy()}
                onChange={(e) =>
                  setJoinPolicy(
                    e.currentTarget.value as CommunityDetail["join_policy"],
                  )
                }
              >
                <option value="open">だれでも参加できる</option>
                <option value="approval">承認制</option>
                <option value="invite">招待制</option>
              </select>
            </label>
          </div>
          <Show when={error()}>
            {(message) => <p class="p-composer-error">{message()}</p>}
          </Show>
        </div>
      </form>
    </div>
  );
}
