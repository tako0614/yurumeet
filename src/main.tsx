import { render } from "solid-js/web";
import {
  createEffect,
  createSignal,
  ErrorBoundary,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { DialogA11y } from "./lib/dialog.tsx";
import { A, Route, Router } from "@solidjs/router";
import {
  fetchDMUnreadCount,
  fetchUnreadCount,
  refreshBrowserNotificationPush,
} from "@takosjp/yurucommu-api";
import App from "./App.tsx";
import { ServerConnect, SignedOut } from "./components/AuthScreens.tsx";
import { ChatPane } from "./components/ChatPane.tsx";
import { NavRail } from "./components/NavRail.tsx";
import {
  AppProvider,
  type ConfirmOptions,
  type ToastAction,
  type ToastTone,
  useApp,
} from "./lib/app-context.tsx";
import { ChatProvider, useChat } from "./lib/chat-context.tsx";
import {
  configureYurumeetServerOrigin,
  readYurumeetServerOrigin,
} from "./server-config.ts";
import {
  clearYurumeBrowserPushBeforeSignOut,
  createGuardedBrowserPushRuntime,
  resolveYurumeBrowserPushConfig,
} from "./lib/browser-push.ts";
import { suppressTakosumiOidcAutoStart } from "./lib/auth-config.ts";
import { createAuthSessionController } from "./lib/auth-session.ts";
import {
  postYurumeetLogout,
  readYurumeetCurrentActor,
} from "./lib/auth-request.ts";
import { installStaleAssetReload } from "./lib/chunk-reload.ts";
import "./styles.css";

const PostDetailPage = lazy(() => import("./pages/PostDetailPage.tsx"));
const ProfilePage = lazy(() => import("./pages/ProfilePage.tsx"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage.tsx"));
const BookmarksPage = lazy(() => import("./pages/BookmarksPage.tsx"));
const SettingsPage = lazy(() => import("./pages/SettingsPage.tsx"));
const CommunityPage = lazy(() => import("./pages/CommunityPage.tsx"));

const initialOrigin = readYurumeetServerOrigin();
if (initialOrigin) configureYurumeetServerOrigin(initialOrigin);

let toastSeq = 0;

type ConfirmState = {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
  cleanup: () => void;
};

function AppRoot(props: { children?: JSX.Element }) {
  const [serverOrigin, setServerOrigin] = createSignal<string | null>(
    initialOrigin,
  );
  const authSession = createAuthSessionController(
    {
      readCurrentActor: readYurumeetCurrentActor,
      postLogout: postYurumeetLogout,
      clearPush: clearYurumeBrowserPushBeforeSignOut,
      suppressOidc: suppressTakosumiOidcAutoStart,
    },
    {
      origin: initialOrigin,
      actor: null,
      logoutErrorText:
        "ログアウトできませんでした。現在もログインしています。もう一度ログアウトしてください。",
      observationErrorText:
        "認証状態を確認できませんでした。サーバーへの接続を確認して再試行してください。",
    },
  );
  const [auth, setAuth] = createSignal(authSession.read());
  let authScopeEpoch = 0;
  let authScope = JSON.stringify([initialOrigin, null]);
  const unsubscribeAuth = authSession.subscribe((state) => {
    const scope = JSON.stringify([state.origin, state.actor?.ap_id ?? null]);
    if (scope !== authScope) {
      authScope = scope;
      authScopeEpoch += 1;
    }
    setAuth(state);
  });
  const actor = () => auth().actor;
  const refetchActor = () => authSession.refresh();
  onCleanup(() => {
    unsubscribeAuth();
    authSession.dispose();
  });
  if (initialOrigin) void refetchActor();
  const [toasts, setToasts] = createSignal<
    { id: number; message: string; tone: ToastTone; action?: ToastAction }[]
  >([]);
  const [unreadTalk, setUnreadTalk] = createSignal(0);
  const [unreadNotifications, setUnreadNotifications] = createSignal(0);
  const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(
    null,
  );

  const settleConfirm = (value: boolean, expected = confirmState()) => {
    const state = confirmState();
    if (!state || state !== expected) return;
    setConfirmState(null);
    state.cleanup();
    state.resolve(value);
  };

  const confirm = (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      // An already-retired caller must not replace another live dialog.
      if (options.signal?.aborted) {
        resolve(false);
        return;
      }
      settleConfirm(false);
      const abort = () => settleConfirm(false, state);
      const state: ConfirmState = {
        options,
        resolve,
        cleanup: () => options.signal?.removeEventListener("abort", abort),
      };
      setConfirmState(state);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });

  let logoutConfirmPending = false;
  const requestLogout = async () => {
    const captured = authSession.read();
    const capturedEpoch = authScopeEpoch;
    if (
      logoutConfirmPending ||
      captured.logoutBusy ||
      !captured.actor ||
      !captured.origin
    )
      return;
    logoutConfirmPending = true;
    try {
      const accepted = await confirm({
        title: "ログアウト",
        message: "ログアウトしますか?",
        confirmLabel: "ログアウト",
      });
      const current = authSession.read();
      if (
        !accepted ||
        authScopeEpoch !== capturedEpoch ||
        current.origin !== captured.origin ||
        current.actor?.ap_id !== captured.actor.ap_id ||
        current.logoutBusy
      )
        return;
      // The confirmation has settled before auth state can unmount its host.
      await authSession.logout();
    } finally {
      logoutConfirmPending = false;
    }
  };

  createEffect(() => {
    if (auth().error || !actor()) settleConfirm(false);
  });
  onCleanup(() => settleConfirm(false));

  const refreshBadges = () => {
    if (auth().error || auth().loading || !actor()) return;
    fetchDMUnreadCount()
      .then((r) => setUnreadTalk(r.total ?? 0))
      .catch(() => {});
    fetchUnreadCount()
      .then((n) => setUnreadNotifications(n ?? 0))
      .catch(() => {});
  };

  onMount(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshBadges();
    }, 20000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshBadges();
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    });
  });
  createEffect(() => {
    if (auth().error || auth().loading || !actor()) return;
    const origin = auth().origin;
    if (!origin) return;
    const epoch = authScopeEpoch;
    const cleanup = new AbortController();
    onCleanup(() => cleanup.abort());
    const runtime = createGuardedBrowserPushRuntime(cleanup.signal, origin);
    refreshBadges();
    void resolveYurumeBrowserPushConfig()
      .then((config) => {
        if (
          cleanup.signal.aborted ||
          authScopeEpoch !== epoch ||
          auth().error ||
          auth().loading ||
          !actor() ||
          config?.serverOrigin !== origin
        )
          return;
        return refreshBrowserNotificationPush(config, runtime);
      })
      .catch(() => {});
  });

  const dismissToast = (id: number) => {
    setToasts((prev) => prev.filter((entry) => entry.id !== id));
  };

  const toast = (
    message: string,
    tone: ToastTone = "info",
    action?: ToastAction,
  ) => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message, tone, action }]);
    // Leave actionable toasts (undo) up longer than pure notices.
    window.setTimeout(() => dismissToast(id), action ? 6000 : 3600);
  };

  const connectServer = (origin: string) => {
    settleConfirm(false);
    authSession.configure(origin, null, true);
    setServerOrigin(origin);
    void refetchActor();
  };

  const ToastHost = () => (
    <div class="yc-toast-host" aria-live="polite" aria-atomic="false">
      <For each={toasts()}>
        {(entry) => (
          <div
            classList={{ "yc-toast": true, "is-error": entry.tone === "error" }}
            // Errors must interrupt the screen reader (assertive), not queue
            // behind whatever it is currently reading.
            role={entry.tone === "error" ? "alert" : undefined}
          >
            {entry.message}
            <Show when={entry.action}>
              {(action) => (
                <button
                  type="button"
                  class="yc-toast-action"
                  onClick={() => {
                    dismissToast(entry.id);
                    action().run();
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
          </div>
        )}
      </For>
    </div>
  );

  return (
    <Show
      when={serverOrigin()}
      fallback={<ServerConnect onConnect={connectServer} />}
    >
      {(origin) => (
        <Show
          // A server/network failure is NOT "signed out": show a connection
          // error with retry instead of the sign-in screen. While a retry is
          // in flight the normal loading branch below takes over.
          when={!auth().error || auth().loading}
          fallback={
            <ConnectionError
              message={
                auth().logoutError
                  ? "ログアウトの完了を確認できませんでした。認証状態を再確認してください。"
                  : (auth().error ?? undefined)
              }
              onRetry={() => void refetchActor()}
            />
          }
        >
          <Show
            when={!auth().error && actor()?.ap_id}
            keyed
            fallback={
              <Show
                when={!auth().loading && auth().navigationAllowed}
                fallback={<div class="yc-boot" />}
              >
                <SignedOut origin={origin()} />
              </Show>
            }
          >
            {(_principal) => (
              <AppProvider
                value={{
                  // Key the provider lifetime by AP identity, preserving the
                  // current same-principal profile through ordinary refresh.
                  actor: () => actor()!,
                  origin,
                  refetchActor: () => void refetchActor(),
                  logout: requestLogout,
                  logoutBusy: () => auth().logoutBusy,
                  toast,
                  confirm,
                  unreadTalk,
                  unreadNotifications,
                  refreshBadges,
                }}
              >
                <Show when={auth().logoutBusy || auth().logoutError}>
                  <div
                    class="yc-logout-status"
                    role={auth().logoutError ? "alert" : "status"}
                  >
                    <span>
                      {auth().logoutBusy
                        ? "ログアウトの結果を確認しています…"
                        : auth().logoutError}
                    </span>
                    <Show when={auth().logoutError && !auth().logoutBusy}>
                      <button
                        type="button"
                        onClick={() => void requestLogout()}
                      >
                        もう一度ログアウト
                      </button>
                    </Show>
                  </div>
                </Show>
                <ChatProvider>
                  <Shell>{props.children}</Shell>
                </ChatProvider>
                <ToastHost />
                <ConfirmHost state={confirmState()} onSettle={settleConfirm} />
              </AppProvider>
            )}
          </Show>
        </Show>
      )}
    </Show>
  );
}

function NotFoundPage() {
  return (
    <main class="p-notfound">
      <section>
        <h1>ページが見つかりません</h1>
        <p>お探しのページは存在しないか、移動した可能性があります。</p>
        <A href="/">ホームに戻る</A>
      </section>
    </main>
  );
}

function ConnectionError(props: { onRetry: () => void; message?: string }) {
  return (
    <main class="p-connect">
      <section>
        <div class="connect-logo">
          <span>yurumeet</span>
        </div>
        <h1>接続エラー</h1>
        <p role="alert">
          {props.message ?? "サーバーに接続できませんでした。"}
        </p>
        <button type="button" onClick={props.onRetry}>
          再試行
        </button>
      </section>
    </main>
  );
}

function Shell(props: { children?: JSX.Element }) {
  const app = useApp();
  const chat = useChat();
  return (
    <>
      <NavRail
        actor={app.actor()}
        hideOnMobile={!!chat.selected()}
        unreadTalk={app.unreadTalk()}
        unreadNotifications={app.unreadNotifications()}
      />
      <div class="app-main" classList={{ "is-chat-open": !!chat.selected() }}>
        <div class="app-panel">{props.children}</div>
        <div class="app-chat">
          <ChatPane />
        </div>
      </div>
    </>
  );
}

function ConfirmHost(props: {
  state: ConfirmState | null;
  onSettle: (value: boolean, state: ConfirmState) => void;
}) {
  let dialogRoot: HTMLDivElement | undefined;
  return (
    <Show when={props.state} keyed>
      {(state) => (
        <div
          class="yc-confirm-scrim"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget)
              props.onSettle(false, state);
          }}
        >
          <div
            class="yc-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label={state.options.title}
            ref={(el) => (dialogRoot = el)}
          >
            <DialogA11y
              root={() => dialogRoot}
              onClose={() => props.onSettle(false, state)}
            />
            <strong>{state.options.title}</strong>
            <Show when={state.options.message}>
              <p>{state.options.message}</p>
            </Show>
            <div class="yc-confirm-actions">
              {/* Destructive confirms start focused on the SAFE choice so a
                  reflexive Enter can't execute the dangerous action. */}
              <button
                type="button"
                class="yc-confirm-cancel"
                autofocus={!!state.options.danger}
                onClick={() => props.onSettle(false, state)}
              >
                {state.options.cancelLabel ?? "キャンセル"}
              </button>
              <button
                type="button"
                autofocus={!state.options.danger}
                classList={{
                  "yc-confirm-ok": true,
                  "is-danger": !!state.options.danger,
                }}
                onClick={() => props.onSettle(true, state)}
              >
                {state.options.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

// Mirrors yurucommu's AppErrorFallback: a rendering failure anywhere below the
// Router (most often a route chunk that no longer exists after a redeploy) has
// to end in something the user can act on, not a blank page.
function AppErrorFallback() {
  return (
    <main class="p-connect">
      <section>
        <div class="connect-logo">
          <span>yurumeet</span>
        </div>
        <h1>問題が発生しました</h1>
        <p>
          画面を表示できませんでした。再読み込みすると復帰する場合があります。
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          再読み込み
        </button>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("[yurume] root element not found");
}

// A redeploy replaces the hashed asset names the open tab still points at, so a
// lazy route resolves to a 404 and rejects. Recover by reloading (index.html is
// no-cache) before that reaches the boundary below.
installStaleAssetReload();

render(
  () => (
    <ErrorBoundary fallback={() => <AppErrorFallback />}>
      <Router root={AppRoot}>
        <Route path="/" component={App} />
        <Route path="/post/*postId" component={PostDetailPage} />
        <Route path="/profile" component={ProfilePage} />
        <Route path="/profile/*actorId" component={ProfilePage} />
        <Route path="/users/:username" component={ProfilePage} />
        <Route path="/notifications" component={NotificationsPage} />
        <Route path="/bookmarks" component={BookmarksPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/communities/*communityId" component={CommunityPage} />
        {/* Unknown paths get a real 404 view instead of silently rendering
          the talk app; every deep-link route is declared above. */}
        <Route path="*" component={NotFoundPage} />
      </Router>
    </ErrorBoundary>
  ),
  root,
);
