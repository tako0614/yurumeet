import { createEffect, createSignal, For, on, Show } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import {
  acceptCommunityJoinRequest,
  type CommunityDetail,
  type CommunityJoinRequest,
  type CommunityMember,
  fetchCommunity,
  fetchCommunityJoinRequests,
  fetchCommunityMembers,
  fetchDMContact,
  joinCommunity,
  leaveCommunity,
  rejectCommunityJoinRequest,
} from "@takosjp/yurucommu-api";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { useApp } from "../lib/app-context.tsx";
import { useChat } from "../lib/chat-context.tsx";
import {
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

export default function CommunityPage() {
  const params = useParams();
  const app = useApp();
  const chat = useChat();
  const navigate = useNavigate();
  const communityId = () => decodeApIdParam(params.communityId);

  const [community, setCommunity] = createSignal<CommunityDetail | null>(null);
  const [members, setMembers] = createSignal<CommunityMember[]>([]);
  const [requests, setRequests] = createSignal<CommunityJoinRequest[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const isOwner = () => community()?.member_role === "owner";

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
        chat.selectContact(contact);
        navigate("/?tab=talk");
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
      const { status } = await joinCommunity(c.ap_id);
      if (status === "joined") {
        setCommunity({ ...c, is_member: true, member_role: "member" });
        chat.refetchContacts();
        app.toast("参加しました");
      } else if (status === "pending") {
        setCommunity({ ...c, join_status: "pending" });
        app.toast("参加リクエストを送りました");
      } else {
        app.toast("招待が必要です");
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
                            : c().join_policy === "invite"
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
                      </div>
                    )}
                  </For>
                </section>
              </>
            )}
          </Show>
        </Show>
      </div>
    </PageLayout>
  );
}
