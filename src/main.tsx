import { render } from "solid-js/web";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { DialogA11y } from "./lib/dialog.tsx";
import { Route, Router } from "@solidjs/router";
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
  type ToastTone,
  useApp,
} from "./lib/app-context.tsx";
import { ChatProvider, useChat } from "./lib/chat-context.tsx";
import {
  configureYurumeetServerOrigin,
  readYurumeetServerOrigin,
} from "./server-config.ts";
import { resolveYurumeBrowserPushConfig } from "./lib/browser-push.ts";
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
    { id: number; message: string; tone: ToastTone }[]
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

  const toast = (message: string, tone: ToastTone = "info") => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((entry) => entry.id !== id));
    }, 3600);
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
          >
            {entry.message}
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
      )}
    </Show>
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
              <button
                type="button"
                class="yc-confirm-cancel"
                onClick={() => props.onSettle(false)}
              >
                {state().options.cancelLabel ?? "キャンセル"}
              </button>
              <button
                type="button"
                autofocus
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

const root = document.getElementById("root");
if (!root) {
  throw new Error("[yurume] root element not found");
}

render(
  () => (
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
      <Route path="*" component={App} />
    </Router>
  ),
  root,
);
