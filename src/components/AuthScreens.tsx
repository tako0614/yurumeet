import { createSignal, Show } from "solid-js";
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
          <span>Y</span>
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
          <span>Y</span>
        </div>
        <h1>サインイン</h1>
        <p>この yurucommu のアカウントで Yurumeet を開きます。</p>
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
          />
          <button type="submit" disabled={submitting()}>
            {submitting() ? "ログイン中" : "ログイン"}
          </button>
        </form>
        <Show when={error()}>
          {(message) => <p class="p-connect-error">{message()}</p>}
        </Show>
      </section>
    </main>
  );
}
