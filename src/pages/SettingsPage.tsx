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
import { DialogA11y } from "../lib/dialog.tsx";
import { fullHandle, profilePath, titleFor, UserAvatar } from "../lib/ui.tsx";
import {
  clearYurumeBrowserPushBeforeSignOut,
  resolveYurumeBrowserPushConfig,
  yurumeBrowserPushConfig,
} from "../lib/browser-push.ts";
import { suppressTakosumiOidcAutoStart } from "../lib/auth-config.ts";

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
  const [listsError, setListsError] = createSignal(false);

  // A failed fetch must be distinguishable from genuinely empty lists —
  // otherwise 「なし」 looks authoritative while blocks/mutes silently exist.
  const loadLists = () => {
    setListsError(false);
    void Promise.all([
      fetchAccounts().then((r) => {
        setAccounts(r.accounts);
        setCurrentApId(r.current_ap_id);
      }),
      fetchBlockedUsers().then(setBlocked),
      fetchMutedUsers().then(setMuted),
    ]).catch(() => setListsError(true));
  };

  onMount(() => {
    loadLists();
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
    // Armed before the reload (sessionStorage survives it): the Takosumi
    // session outlives ours, so an unsuppressed auto-start would redirect and
    // sign the user straight back in.
    suppressTakosumiOidcAutoStart();
    try {
      await clearYurumeBrowserPushBeforeSignOut();
      await logout();
    } catch {
      /* reload anyway */
    }
    window.location.reload();
  };

  // Account deletion is irreversible: a reflexive OK on a generic confirm is
  // too cheap. Require typing 「削除」 before the destructive button enables.
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const [deleteText, setDeleteText] = createSignal("");
  const [deleteBusy, setDeleteBusy] = createSignal(false);
  const deleteConfirmed = () => deleteText().trim() === "削除";
  let deleteDialogRoot: HTMLDivElement | undefined;

  const handleDelete = () => {
    setDeleteText("");
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteConfirmed() || deleteBusy()) return;
    setDeleteBusy(true);
    try {
      await clearYurumeBrowserPushBeforeSignOut();
      await deleteAccount();
      window.location.reload();
    } catch {
      app.toast("削除に失敗しました", "error");
      setDeleteBusy(false);
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
        <Show when={listsError()}>
          <section class="p-settings-section">
            <div class="p-settings-account">
              <span class="p-settings-account-main">
                <strong>設定を読み込めませんでした</strong>
                <small>
                  アカウント・ブロック・ミュートの一覧が最新ではありません
                </small>
              </span>
              <button type="button" class="p-settings-btn" onClick={loadLists}>
                再試行
              </button>
            </div>
          </section>
        </Show>
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
          <For
            each={blocked()}
            fallback={
              <p class="p-settings-empty">
                {listsError() ? "読み込めませんでした" : "なし"}
              </p>
            }
          >
            {(actor) => (
              <ModRow
                actor={actor}
                actionLabel="解除"
                onAction={() => void handleUnblock(actor)}
              />
            )}
          </For>
          <h3>ミュート中のユーザー</h3>
          <For
            each={muted()}
            fallback={
              <p class="p-settings-empty">
                {listsError() ? "読み込めませんでした" : "なし"}
              </p>
            }
          >
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
            onClick={handleDelete}
          >
            アカウントを削除
          </button>
        </section>
      </div>
      <Show when={deleteOpen()}>
        <div
          class="yc-confirm-scrim"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDeleteOpen(false);
          }}
        >
          <div
            class="yc-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="アカウントを削除"
            ref={(el) => (deleteDialogRoot = el)}
          >
            <DialogA11y
              root={() => deleteDialogRoot}
              onClose={() => setDeleteOpen(false)}
            />
            <strong>アカウントを削除</strong>
            <p>
              この操作は取り消せません。続けるには「削除」と入力してください。
            </p>
            <input
              class="p-settings-delete-input"
              type="text"
              value={deleteText()}
              placeholder="削除"
              aria-label="確認のため「削除」と入力"
              autofocus
              onInput={(event) => setDeleteText(event.currentTarget.value)}
            />
            <div class="yc-confirm-actions">
              <button
                type="button"
                class="yc-confirm-cancel"
                onClick={() => setDeleteOpen(false)}
              >
                キャンセル
              </button>
              <button
                type="button"
                class="yc-confirm-ok is-danger"
                disabled={!deleteConfirmed() || deleteBusy()}
                onClick={() => void confirmDelete()}
              >
                {deleteBusy() ? "削除中" : "削除する"}
              </button>
            </div>
          </div>
        </div>
      </Show>
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
