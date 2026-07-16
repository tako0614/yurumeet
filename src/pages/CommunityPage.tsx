import { createEffect, createSignal, For, on, Show } from "solid-js";
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
  uploadMedia,
} from "@takosjp/yurucommu-api";
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
  const [busy, setBusy] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
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
  const load = () => {
    const id = communityId();
    const myGen = ++gen;
    setLoading(true);
    setError(false);
    setCommunity(null);
    setMembers([]);
    setRequests([]);
    void (async () => {
      try {
        const detail = await fetchCommunity(id);
        if (myGen !== gen) return;
        setCommunity(detail);
        const list = await fetchCommunityMembers(id).catch(() => []);
        if (myGen !== gen) return;
        setMembers(list);
        if (detail.member_role === "owner") {
          const reqs = await fetchCommunityJoinRequests(id).catch(() => []);
          if (myGen !== gen) return;
          setRequests(reqs);
        }
      } catch {
        if (myGen === gen) setError(true);
      } finally {
        if (myGen === gen) setLoading(false);
      }
    })();
  };
  createEffect(on(communityId, load));

  const openChat = async () => {
    const c = community();
    if (!c) return;
    try {
      const contact = await fetchDMContact(c.ap_id);
      if (contact) {
        // Navigate FIRST so the chat's history entry sits on top of the talk
        // tab (back then closes the chat instead of resurrecting this page).
        navigate("/?tab=talk");
        chat.selectContact(contact);
      }
    } catch {
      app.toast("トークを開けませんでした", "error");
    }
  };

  const handleJoin = async () => {
    const c = community();
    if (!c || busy()) return;
    setBusy(true);
    try {
      const invite = inviteId();
      const { status } = await joinCommunity(
        c.ap_id,
        invite ? { inviteId: invite } : undefined,
      );
      if (status === "joined") {
        setCommunity({ ...c, is_member: true, member_role: "member" });
        chat.refetchContacts();
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
      app.toast("参加に失敗しました", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = async () => {
    const c = community();
    if (!c || busy()) return;
    const ok = await app.confirm({
      title: "グループを退出",
      message: `${c.display_name} を退出しますか?`,
      confirmLabel: "退出",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await leaveCommunity(c.ap_id);
      setCommunity({ ...c, is_member: false, member_role: null });
      chat.refetchContacts();
      app.toast("退出しました");
    } catch {
      app.toast("退出に失敗しました", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleRequest = async (
    req: CommunityJoinRequest,
    action: "accept" | "reject",
  ) => {
    const c = community();
    if (!c) return;
    try {
      if (action === "accept") {
        await acceptCommunityJoinRequest(c.ap_id, req.ap_id);
      } else {
        await rejectCommunityJoinRequest(c.ap_id, req.ap_id);
      }
      setRequests((prev) => prev.filter((r) => r.ap_id !== req.ap_id));
      app.toast(action === "accept" ? "承認しました" : "拒否しました");
    } catch {
      app.toast("操作に失敗しました", "error");
    }
  };

  const handleCreateInvite = async () => {
    const c = community();
    if (!c || inviting()) return;
    setInviting(true);
    try {
      const invite = await createCommunityInvite(c.ap_id);
      const url = `${window.location.origin}/communities/${encodeURIComponent(
        c.ap_id,
      )}?invite=${encodeURIComponent(invite.invite_id)}`;
      await navigator.clipboard.writeText(url);
      app.toast("招待リンクをコピーしました");
    } catch {
      app.toast("招待リンクを作成できませんでした", "error");
    } finally {
      setInviting(false);
    }
  };

  const handleKick = async (member: CommunityMember) => {
    const c = community();
    if (!c || memberBusy()) return;
    setMemberMenuFor(null);
    const ok = await app.confirm({
      title: "メンバーを削除",
      message: `${titleFor(member)} をグループから削除しますか?`,
      confirmLabel: "削除",
      danger: true,
    });
    if (!ok) return;
    setMemberBusy(member.ap_id);
    try {
      await removeCommunityMember(c.ap_id, member.ap_id);
      setMembers((prev) => prev.filter((m) => m.ap_id !== member.ap_id));
      setCommunity((prev) =>
        prev
          ? { ...prev, member_count: Math.max(0, prev.member_count - 1) }
          : prev,
      );
      app.toast("メンバーを削除しました");
    } catch {
      app.toast("操作に失敗しました", "error");
    } finally {
      setMemberBusy(null);
    }
  };

  const handleRoleChange = async (
    member: CommunityMember,
    role: "moderator" | "member",
  ) => {
    const c = community();
    if (!c || memberBusy()) return;
    setMemberMenuFor(null);
    setMemberBusy(member.ap_id);
    try {
      await updateCommunityMemberRole(c.ap_id, member.ap_id, role);
      setMembers((prev) =>
        prev.map((m) => (m.ap_id === member.ap_id ? { ...m, role } : m)),
      );
      app.toast(
        role === "moderator"
          ? "モデレーターにしました"
          : "メンバーに戻しました",
      );
    } catch {
      app.toast("操作に失敗しました", "error");
    } finally {
      setMemberBusy(null);
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
                          onClick={() => setSettingsOpen(true)}
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
                  <For
                    each={members()}
                    fallback={<p class="p-detail-empty">メンバーがいません</p>}
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

                <Show when={settingsOpen()}>
                  <CommunitySettingsModal
                    community={c()}
                    onClose={() => setSettingsOpen(false)}
                    onSaved={(updated) => {
                      setCommunity((prev) =>
                        prev ? { ...prev, ...updated } : prev,
                      );
                      setSettingsOpen(false);
                      app.toast("グループ設定を更新しました");
                    }}
                  />
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
  const [displayName, setDisplayName] = createSignal(
    props.community.display_name,
  );
  const [summary, setSummary] = createSignal(props.community.summary ?? "");
  const [iconUrl, setIconUrl] = createSignal(props.community.icon_url ?? "");
  const [joinPolicy, setJoinPolicy] = createSignal(props.community.join_policy);
  const [uploading, setUploading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const canSave = () =>
    displayName().trim().length > 0 && !saving() && !uploading();

  const uploadIcon = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await uploadMedia(file);
      setIconUrl(uploaded.url ?? "");
    } catch {
      setError("画像のアップロードに失敗しました");
    } finally {
      setUploading(false);
    }
  };

  const save = async (event: Event) => {
    event.preventDefault();
    if (!canSave()) return;
    setSaving(true);
    setError(null);
    const settings: CommunitySettings = {
      display_name: displayName().trim(),
      summary: summary().trim(),
      join_policy: joinPolicy(),
      ...(iconUrl() ? { icon_url: iconUrl() } : {}),
    };
    try {
      await updateCommunitySettings(props.community.ap_id, settings);
      props.onSaved({
        display_name: settings.display_name,
        summary: settings.summary || null,
        icon_url: iconUrl() || props.community.icon_url,
        join_policy: joinPolicy(),
      });
    } catch {
      setError("設定を保存できませんでした");
      setSaving(false);
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
                name: displayName() || props.community.display_name,
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
