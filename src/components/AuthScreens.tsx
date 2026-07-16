import { createSignal, For, onMount, Show } from "solid-js";
import {
  parseAuthConfig,
  shouldAutoStartTakosumiOidc,
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

  onMount(() => {
    void fetch(serverUrl(props.origin, "/api/auth/providers"), {
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("auth providers unavailable");
        const config = parseAuthConfig(await response.json());
        if (!config) throw new Error("invalid auth provider response");
        if (shouldAutoStartTakosumiOidc(config)) {
          window.location.assign(
            serverUrl(props.origin, "/api/auth/login/takos"),
          );
          return;
        }
        setAuthConfig(config);
      })
      .catch(() => {
        // Older/self-hosted servers may not expose provider discovery yet.
        // Keep the bootstrap-password path available as a compatibility fallback.
        setAuthConfig({ providers: [], password_enabled: true });
      })
      .finally(() => setLoadingProviders(false));
  });

  const login = async () => {
    const value = password().trim();
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
          <Show
            when={
              (authConfig()?.providers.length ?? 0) > 0 ||
              authConfig()?.password_enabled
            }
            fallback={
              <p class="p-connect-error">利用できる認証方法がありません。</p>
            }
          >
            <div class="p-connect-auth">
              <For each={authConfig()?.providers ?? []}>
                {(provider) => (
                  <a
                    class="p-connect-provider"
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
                  <input
                    type="password"
                    value={password()}
                    onInput={(event) => setPassword(event.currentTarget.value)}
                    placeholder="パスワード"
                    autocomplete="current-password"
                    autofocus={(authConfig()?.providers.length ?? 0) === 0}
                  />
                  <button
                    type="submit"
                    disabled={submitting() || !password().trim()}
                  >
                    {submitting() ? "ログイン中" : "ログイン"}
                  </button>
                </form>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={error()}>
          {(message) => <p class="p-connect-error">{message()}</p>}
        </Show>
      </section>
    </main>
  );
}
