import { createSignal, For, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import {
  type AccountInfo,
  type Actor,
  deleteAccount,
  fetchAccounts,
  fetchBlockedUsers,
  fetchMutedUsers,
  logout,
  switchAccount,
  unblockUser,
  unmuteUser,
} from "@takosjp/yurucommu-api";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { useApp } from "../lib/app-context.tsx";
import { fullHandle, profilePath, titleFor, UserAvatar } from "../lib/ui.tsx";

export default function SettingsPage() {
  const app = useApp();
  const [accounts, setAccounts] = createSignal<AccountInfo[]>([]);
  const [currentApId, setCurrentApId] = createSignal("");
  const [blocked, setBlocked] = createSignal<Actor[]>([]);
  const [muted, setMuted] = createSignal<Actor[]>([]);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void fetchAccounts()
      .then((r) => {
        setAccounts(r.accounts);
        setCurrentApId(r.current_ap_id);
      })
      .catch(() => {});
    void fetchBlockedUsers()
      .then(setBlocked)
      .catch(() => {});
    void fetchMutedUsers()
      .then(setMuted)
      .catch(() => {});
  });

  const handleSwitch = async (apId: string) => {
    if (apId === currentApId() || busy()) return;
    setBusy(true);
    try {
      await switchAccount(apId);
      window.location.reload();
    } catch {
      app.toast("アカウントを切り替えられませんでした", "error");
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    const ok = await app.confirm({
      title: "ログアウト",
      message: "ログアウトしますか?",
      confirmLabel: "ログアウト",
    });
    if (!ok) return;
    try {
      await logout();
    } catch {
      /* reload anyway */
    }
    window.location.reload();
  };

  const handleDelete = async () => {
    const ok = await app.confirm({
      title: "アカウントを削除",
      message: "本当にアカウントを削除しますか? この操作は取り消せません。",
      confirmLabel: "削除する",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteAccount();
      window.location.reload();
    } catch {
      app.toast("削除に失敗しました", "error");
    }
  };

  const handleUnblock = async (actor: Actor) => {
    try {
      await unblockUser(actor.ap_id);
      setBlocked((prev) => prev.filter((a) => a.ap_id !== actor.ap_id));
      app.toast("ブロックを解除しました");
    } catch {
      app.toast("操作に失敗しました", "error");
    }
  };

  const handleUnmute = async (actor: Actor) => {
    try {
      await unmuteUser(actor.ap_id);
      setMuted((prev) => prev.filter((a) => a.ap_id !== actor.ap_id));
      app.toast("ミュートを解除しました");
    } catch {
      app.toast("操作に失敗しました", "error");
    }
  };

  return (
    <PageLayout>
      <PageHeader title="設定" />
      <div class="p-page-body p-settings">
        <section class="p-settings-section">
          <h2>アカウント</h2>
          <For each={accounts()}>
            {(account) => (
              <div class="p-settings-account">
                <UserAvatar value={account} size={40} />
                <span class="p-settings-account-main">
                  <strong>{titleFor(account)}</strong>
                  <small>@{account.preferred_username}</small>
                </span>
                <Show
                  when={account.ap_id !== currentApId()}
                  fallback={<span class="p-settings-current">使用中</span>}
                >
                  <button
                    type="button"
                    class="p-settings-btn"
                    disabled={busy()}
                    onClick={() => void handleSwitch(account.ap_id)}
                  >
                    切り替え
                  </button>
                </Show>
              </div>
            )}
          </For>
          <A class="p-settings-row" href="/bookmarks">
            ブックマーク
          </A>
          <button
            type="button"
            class="p-settings-row"
            onClick={() => void handleLogout()}
          >
            ログアウト
          </button>
        </section>

        <section class="p-settings-section">
          <h2>プライバシー</h2>
          <h3>ブロック中のユーザー</h3>
          <For each={blocked()} fallback={<p class="p-settings-empty">なし</p>}>
            {(actor) => (
              <ModRow
                actor={actor}
                actionLabel="解除"
                onAction={() => void handleUnblock(actor)}
              />
            )}
          </For>
          <h3>ミュート中のユーザー</h3>
          <For each={muted()} fallback={<p class="p-settings-empty">なし</p>}>
            {(actor) => (
              <ModRow
                actor={actor}
                actionLabel="解除"
                onAction={() => void handleUnmute(actor)}
              />
            )}
          </For>
        </section>

        <section class="p-settings-section">
          <button
            type="button"
            class="p-settings-danger"
            onClick={() => void handleDelete()}
          >
            アカウントを削除
          </button>
        </section>
      </div>
    </PageLayout>
  );
}

function ModRow(props: {
  actor: Actor;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div class="p-settings-account">
      <A href={profilePath(props.actor.ap_id)} class="p-settings-account-link">
        <UserAvatar value={props.actor} size={40} />
        <span class="p-settings-account-main">
          <strong>{titleFor(props.actor)}</strong>
          <small>{fullHandle(props.actor)}</small>
        </span>
      </A>
      <button type="button" class="p-settings-btn" onClick={props.onAction}>
        {props.actionLabel}
      </button>
    </div>
  );
}
