import { createSignal, For, onMount, Show } from "solid-js";
import { A } from "@solidjs/router";
import {
  type AccountInfo,
  type Actor,
  type BrowserNotificationPushState,
  deleteAccount,
  disableBrowserNotificationPush,
  enableBrowserNotificationPush,
  fetchAccounts,
  fetchBlockedUsers,
  fetchMutedUsers,
  getBrowserNotificationPushState,
  logout,
  refreshBrowserNotificationPush,
  switchAccount,
  unblockUser,
  unmuteUser,
} from "@takosjp/yurucommu-api";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { useApp } from "../lib/app-context.tsx";
import { fullHandle, profilePath, titleFor, UserAvatar } from "../lib/ui.tsx";
import {
  clearYurumeBrowserPushBeforeSignOut,
  resolveYurumeBrowserPushConfig,
  yurumeBrowserPushConfig,
} from "../lib/browser-push.ts";

export default function SettingsPage() {
  const app = useApp();
  const [accounts, setAccounts] = createSignal<AccountInfo[]>([]);
  const [currentApId, setCurrentApId] = createSignal("");
  const [blocked, setBlocked] = createSignal<Actor[]>([]);
  const [muted, setMuted] = createSignal<Actor[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [pushConfig, setPushConfig] =
    createSignal<ReturnType<typeof yurumeBrowserPushConfig>>(null);
  const [pushState, setPushState] =
    createSignal<BrowserNotificationPushState>("unconfigured");
  const [pushBusy, setPushBusy] = createSignal(false);
  const [pushConfigResolved, setPushConfigResolved] = createSignal(false);
  const [pushRegistrationError, setPushRegistrationError] = createSignal(false);

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
    void (async () => {
      try {
        const config = await resolveYurumeBrowserPushConfig();
        setPushConfig(config);
        let state = await getBrowserNotificationPushState(config);
        if (config && state === "enabled") {
          state = await refreshBrowserNotificationPush(config);
        }
        setPushState(state);
      } catch {
        setPushRegistrationError(true);
        setPushState("disabled");
      } finally {
        setPushConfigResolved(true);
      }
    })();
  });

  const handleTogglePush = async () => {
    const config = pushConfig();
    if (!config || pushBusy()) return;
    setPushBusy(true);
    setPushRegistrationError(false);
    try {
      const next =
        pushState() === "enabled"
          ? await disableBrowserNotificationPush(config)
          : (await enableBrowserNotificationPush(config)).state;
      setPushState(next);
      if (next === "enabled") app.toast("プッシュ通知を有効にしました");
      if (next === "disabled") app.toast("プッシュ通知を無効にしました");
    } catch {
      setPushRegistrationError(true);
      app.toast("プッシュ通知の設定に失敗しました", "error");
    } finally {
      setPushBusy(false);
    }
  };

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
      await clearYurumeBrowserPushBeforeSignOut();
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
      await clearYurumeBrowserPushBeforeSignOut();
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
          <h2>通知</h2>
          <div class="p-settings-account">
            <span class="p-settings-account-main">
              <strong>プッシュ通知</strong>
              <small>
                {!pushConfigResolved()
                  ? "通知設定を確認中です"
                  : pushRegistrationError()
                    ? "サーバーへの登録を確認できませんでした"
                    : pushStateLabel(pushState())}
              </small>
            </span>
            <button
              type="button"
              class="p-settings-btn"
              disabled={
                pushBusy() ||
                !pushConfigResolved() ||
                pushState() === "unsupported" ||
                pushState() === "unconfigured" ||
                pushState() === "denied"
              }
              onClick={() => void handleTogglePush()}
            >
              {pushBusy()
                ? "更新中"
                : pushState() === "enabled"
                  ? "無効にする"
                  : "有効にする"}
            </button>
          </div>
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

function pushStateLabel(state: BrowserNotificationPushState): string {
  switch (state) {
    case "enabled":
      return "このブラウザで有効です";
    case "disabled":
      return "このブラウザでは無効です";
    case "denied":
      return "ブラウザの通知設定でブロックされています";
    case "unconfigured":
      return "この環境では通知配信が設定されていません";
    default:
      return "このブラウザはプッシュ通知に対応していません";
  }
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
