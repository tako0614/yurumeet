import { createSignal, For, onMount, Show } from "solid-js";
import {
  claimTakosumiOidcAutoStart,
  parseAuthConfig,
  shouldAutoStartTakosumiOidc,
  suppressTakosumiOidcAutoStart,
  type AuthConfig,
} from "../lib/auth-config.ts";
import {
  configureYurumeetServerOrigin,
  normalizeServerOrigin,
  saveYurumeetServerOrigin,
  serverUrl,
} from "../server-config.ts";

export function ServerConnect(props: { onConnect: (origin: string) => void }) {
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const connect = () => {
    const origin = normalizeServerOrigin(value());
    if (!origin) {
      setError("開発用の yurucommu API 配信先を入力してください。");
      return;
    }
    saveYurumeetServerOrigin(origin);
    configureYurumeetServerOrigin(origin);
    props.onConnect(origin);
  };
  return (
    <main class="p-connect">
      <section>
        <div class="connect-logo">
          <span>yurumeet</span>
        </div>
        <h1>Yurumeet</h1>
        <p>
          yurucommu の同じアカウントと API を、ホーム / トーク / タイムライン
          の画面として開きます。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <input
            value={value()}
            onInput={(event) => setValue(event.currentTarget.value)}
            placeholder="開発用 API origin"
            inputmode="url"
            autocomplete="url"
          />
          <button type="submit">開く</button>
        </form>
        <Show when={error()}>
          {(message) => <p class="p-connect-error">{message()}</p>}
        </Show>
      </section>
    </main>
  );
}

export function SignedOut(props: { origin: string }) {
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [loadingProviders, setLoadingProviders] = createSignal(true);
  const [authConfig, setAuthConfig] = createSignal<AuthConfig | null>(null);

  const [authConfigError, setAuthConfigError] = createSignal(false);
  const [callbackFailed, setCallbackFailed] = createSignal(false);
  let receivedCallbackError = false;

  const loadAuthConfig = async () => {
    setLoadingProviders(true);
    setAuthConfigError(false);
    setAuthConfig(null);
    try {
      const response = await fetch(
        serverUrl(props.origin, "/api/auth/providers"),
        {
          credentials: "include",
        },
      );
      if (!response.ok) throw new Error("auth providers unavailable");
      const config = parseAuthConfig(await response.json());
      if (!config) throw new Error("invalid auth provider response");
      setAuthConfig(config);
      if (
        !receivedCallbackError &&
        shouldAutoStartTakosumiOidc(config) &&
        claimTakosumiOidcAutoStart()
      ) {
        window.location.assign(
          serverUrl(props.origin, "/api/auth/login/takos"),
        );
      }
    } catch {
      setAuthConfig(null);
      setAuthConfigError(true);
    } finally {
      setLoadingProviders(false);
    }
  };

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("error")) {
      receivedCallbackError = true;
      setCallbackFailed(true);
      suppressTakosumiOidcAutoStart();
      // Never reflect callback error details into the page. Keep unrelated
      // route/query/hash state while consuming the failure once.
      params.delete("error");
      params.delete("error_description");
      const query = params.toString();
      try {
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname +
            (query ? `?${query}` : "") +
            window.location.hash,
        );
      } catch {
        // A restricted history API must not prevent manual sign-in recovery.
      }
    }
    void loadAuthConfig();
  });

  const visibleError = () =>
    authConfigError()
      ? "認証方法を取得できませんでした。接続を確認して再試行してください。"
      : (error() ??
        (callbackFailed()
          ? "外部アカウントでのログインに失敗しました。もう一度お試しください。"
          : null));

  const login = async () => {
    const value = password();
    if (!value) {
      setError("パスワードを入力してください。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(serverUrl(props.origin, "/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: value }),
      });
      if (!response.ok) {
        setError("ログインできませんでした。");
        return;
      }
      window.location.reload();
    } catch {
      setError("ログインできませんでした。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main class="p-connect">
      <section>
        <div class="connect-logo">
          <span>yurumeet</span>
        </div>
        <h1>サインイン</h1>
        <p>この yurucommu のアカウントで Yurumeet を開きます。</p>
        <Show when={!loadingProviders()} fallback={<p>認証方法を確認中です</p>}>
          <Show when={authConfigError()}>
            <button type="button" onClick={() => void loadAuthConfig()}>
              再試行
            </button>
          </Show>
          <Show
            when={
              (authConfig()?.providers.length ?? 0) > 0 ||
              authConfig()?.password_enabled
            }
            fallback={
              <Show when={!authConfigError()}>
                <p class="p-connect-error">利用できる認証方法がありません。</p>
              </Show>
            }
          >
            <div class="p-connect-auth">
              <For each={authConfig()?.providers ?? []}>
                {(provider) => (
                  <a
                    class="p-connect-provider"
                    rel="external"
                    href={serverUrl(
                      props.origin,
                      `/api/auth/login/${encodeURIComponent(provider.id)}`,
                    )}
                  >
                    <span class="p-connect-provider-icon" aria-hidden="true">
                      {provider.name.slice(0, 1).toUpperCase()}
                    </span>
                    {provider.name}でログイン
                  </a>
                )}
              </For>
              <Show
                when={
                  (authConfig()?.providers.length ?? 0) > 0 &&
                  authConfig()?.password_enabled
                }
              >
                <div class="p-connect-divider">
                  <span>または</span>
                </div>
              </Show>
              <Show when={authConfig()?.password_enabled}>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void login();
                  }}
                >
                  <label for="yurumeet-password">パスワード</label>
                  <input
                    id="yurumeet-password"
                    type="password"
                    value={password()}
                    onInput={(event) => setPassword(event.currentTarget.value)}
                    placeholder="パスワード"
                    autocomplete="current-password"
                    aria-invalid={error() ? true : undefined}
                    aria-describedby={
                      error() ? "yurumeet-login-error" : undefined
                    }
                    autofocus={(authConfig()?.providers.length ?? 0) === 0}
                  />
                  <button type="submit" disabled={submitting() || !password()}>
                    {submitting() ? "ログイン中" : "ログイン"}
                  </button>
                </form>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={visibleError()}>
          {(message) => (
            <p id="yurumeet-login-error" class="p-connect-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </section>
    </main>
  );
}
