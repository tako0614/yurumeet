import { render } from "solid-js/web";
import {
  createEffect,
  createResource,
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
  fetchCurrentActor,
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
import { resolveYurumeBrowserPushConfig } from "./lib/browser-push.ts";
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

function AppRoot(props: { children?: JSX.Element }) {
  const [serverOrigin, setServerOrigin] = createSignal<string | null>(
    initialOrigin,
  );
  const [actor, { refetch: refetchActor }] = createResource(
    serverOrigin,
    fetchCurrentActor,
  );
  const [toasts, setToasts] = createSignal<
    { id: number; message: string; tone: ToastTone; action?: ToastAction }[]
  >([]);
  const [unreadTalk, setUnreadTalk] = createSignal(0);
  const [unreadNotifications, setUnreadNotifications] = createSignal(0);
  const [confirmState, setConfirmState] = createSignal<{
    options: ConfirmOptions;
    resolve: (value: boolean) => void;
  } | null>(null);

  const confirm = (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      setConfirmState({ options, resolve });
    });

  const settleConfirm = (value: boolean) => {
    const state = confirmState();
    if (!state) return;
    setConfirmState(null);
    state.resolve(value);
  };

  const refreshBadges = () => {
    if (!actor()) return;
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
    if (!actor()) return;
    refreshBadges();
    void resolveYurumeBrowserPushConfig()
      .then((config) =>
        config ? refreshBrowserNotificationPush(config) : undefined,
      )
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
          when={!actor.error || actor.loading}
          fallback={<ConnectionError onRetry={() => void refetchActor()} />}
        >
          <Show
            when={actor()}
            fallback={
              <Show when={!actor.loading} fallback={<div class="yc-boot" />}>
                <SignedOut origin={origin()} />
              </Show>
            }
          >
            {(currentActor) => (
              <AppProvider
                value={{
                  actor: currentActor,
                  origin,
                  refetchActor: () => void refetchActor(),
                  toast,
                  confirm,
                  unreadTalk,
                  unreadNotifications,
                  refreshBadges,
                }}
              >
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

function ConnectionError(props: { onRetry: () => void }) {
  return (
    <main class="p-connect">
      <section>
        <div class="connect-logo">
          <span>yurumeet</span>
        </div>
        <h1>接続エラー</h1>
        <p>サーバーに接続できませんでした。</p>
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
  state: { options: ConfirmOptions; resolve: (value: boolean) => void } | null;
  onSettle: (value: boolean) => void;
}) {
  let dialogRoot: HTMLDivElement | undefined;
  return (
    <Show when={props.state}>
      {(state) => (
        <div
          class="yc-confirm-scrim"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) props.onSettle(false);
          }}
        >
          <div
            class="yc-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label={state().options.title}
            ref={(el) => (dialogRoot = el)}
          >
            <DialogA11y
              root={() => dialogRoot}
              onClose={() => props.onSettle(false)}
            />
            <strong>{state().options.title}</strong>
            <Show when={state().options.message}>
              <p>{state().options.message}</p>
            </Show>
            <div class="yc-confirm-actions">
              {/* Destructive confirms start focused on the SAFE choice so a
                  reflexive Enter can't execute the dangerous action. */}
              <button
                type="button"
                class="yc-confirm-cancel"
                autofocus={!!state().options.danger}
                onClick={() => props.onSettle(false)}
              >
                {state().options.cancelLabel ?? "キャンセル"}
              </button>
              <button
                type="button"
                autofocus={!state().options.danger}
                classList={{
                  "yc-confirm-ok": true,
                  "is-danger": !!state().options.danger,
                }}
                onClick={() => props.onSettle(true)}
              >
                {state().options.confirmLabel ?? "OK"}
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
