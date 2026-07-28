import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
// Type-only: the ~300KB html5-qrcode runtime is dynamically imported inside
// startScanner() so it loads only when the user opens the scanner tab.
import type { Html5Qrcode } from "html5-qrcode";
import { useNavigate } from "@solidjs/router";
import {
  type Actor,
  fetchActor,
  fetchDMContact,
  follow,
  searchRemote,
} from "@takosjp/yurucommu-api";
import { useApp } from "../lib/app-context.tsx";
import { useChat } from "../lib/chat-context.tsx";
import { DialogA11y } from "../lib/dialog.tsx";
import { parseScannedContact } from "../lib/qr-contact.ts";
import {
  CloseIcon,
  fullHandle,
  SpinnerIcon,
  titleFor,
  UserAvatar,
} from "../lib/ui.tsx";
import { QrSvg } from "./QrSvg.tsx";

/**
 * True when the resolved actor really is the account the scanned handle
 * names: `searchRemote` is a free-text search, so its first hit can be an
 * unrelated look-alike. Compare username + AP-id host against the handle.
 */
function actorMatchesHandle(actor: Actor, handle: string): boolean {
  const match = /^@?([^@\s]+)@([^@\s/]+)$/.exec(handle);
  if (!match) return false;
  const [, user, host] = match;
  let apHost: string;
  try {
    apHost = new URL(actor.ap_id).host;
  } catch {
    return false;
  }
  const username = (actor.preferred_username || actor.username || "")
    .replace(/^@/, "")
    .split("@")[0];
  return (
    apHost.toLowerCase() === host.toLowerCase() &&
    username.toLowerCase() === user.toLowerCase()
  );
}

export function QRCodeModal(props: { onClose: () => void }) {
  const app = useApp();
  const chat = useChat();
  const navigate = useNavigate();

  const [tab, setTab] = createSignal<"myqr" | "scan">("myqr");
  const [scanning, setScanning] = createSignal(false);
  const [lookingUp, setLookingUp] = createSignal(false);
  const [scanResult, setScanResult] = createSignal<Actor | null>(null);
  const [scanError, setScanError] = createSignal<string | null>(null);
  const [followBusy, setFollowBusy] = createSignal(false);
  const [followDone, setFollowDone] = createSignal(false);
  // A follow of a private local account or any remote account lands as a
  // pending request (awaiting approval), not an established follow.
  const [followPending, setFollowPending] = createSignal(false);
  let scannerRef: Html5Qrcode | null = null;
  let dialogRoot: HTMLDivElement | undefined;

  const myOrigin = () => app.origin();
  const myHost = () => {
    try {
      return new URL(myOrigin()).host;
    } catch {
      return window.location.host;
    }
  };

  // Same payload shape as yurucommu's QR so both products (and any fediverse
  // server reachable over WebFinger) can resolve it: a canonical profile URL
  // carrying the AP id, plus the username fragment for remote scanners.
  const qrUrl = () =>
    `${myOrigin()}/profile/${encodeURIComponent(
      app.actor().ap_id,
    )}#${app.actor().preferred_username}`;

  const stopScannerSafely = async () => {
    const scanner = scannerRef;
    if (!scanner) return;
    // Null the ref FIRST so tab flips / re-entries can't double-stop, and a
    // fresh startScanner() always builds a new instance.
    scannerRef = null;
    try {
      await scanner.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("not running")) {
        console.warn("Failed to stop QR scanner:", err);
      }
    }
    try {
      scanner.clear();
    } catch {
      /* container already unmounted */
    }
  };

  onCleanup(() => {
    void stopScannerSafely();
  });

  // Start/stop scanner when the tab changes. Track ONLY `tab`: startScanner()
  // writes setScanning(true) synchronously, so a bare effect that also read
  // scanning()/scanResult() would re-trigger itself.
  createEffect(
    on(tab, (current) => {
      if (current === "scan" && !scanning() && !scanResult()) {
        void startScanner();
      } else if (current !== "scan" && scannerRef) {
        void stopScannerSafely();
        setScanning(false);
      }
    }),
  );

  const lookUp = async (decodedText: string) => {
    setLookingUp(true);
    try {
      const target = parseScannedContact(decodedText, myHost(), myOrigin());
      if (!target) {
        setScanError("このコードは友だち追加用ではありません");
        return;
      }
      if (target.kind === "local") {
        const actor = await fetchActor(target.apId);
        setScanResult(actor);
      } else {
        const results = await searchRemote(target.handle);
        const matched = results.find((actor) =>
          actorMatchesHandle(actor, target.handle),
        );
        if (matched) setScanResult(matched);
        else setScanError("ユーザーが見つかりませんでした");
      }
    } catch (err) {
      console.error("QR contact lookup failed:", err);
      setScanError("ユーザーを確認できませんでした");
    } finally {
      setLookingUp(false);
    }
  };

  const startScanner = async () => {
    setScanError(null);
    setScanning(true);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("yurumeet-qr-scanner");
      scannerRef = scanner;
      // html5-qrcode can deliver further decode callbacks for frames already
      // in flight before stop() resolves — latch the first hit so one scan
      // triggers exactly one lookup.
      let handled = false;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        async (decodedText) => {
          if (handled) return;
          handled = true;
          await stopScannerSafely();
          setScanning(false);
          await lookUp(decodedText);
        },
        () => {}, // ignore per-frame decode misses
      );
    } catch (err) {
      console.error("Failed to start QR scanner:", err);
      setScanError("カメラを起動できませんでした");
      setScanning(false);
    }
  };

  const isSelf = () => scanResult()?.ap_id === app.actor().ap_id;

  const handleFollow = async () => {
    const result = scanResult();
    if (!result || followBusy()) return;
    setFollowBusy(true);
    try {
      const { status } = await follow(result.ap_id);
      if (status === "pending") setFollowPending(true);
      else setFollowDone(true);
      chat.refetchContacts();
    } catch (err) {
      console.error("Failed to follow:", err);
      app.toast("フォローに失敗しました", "error");
    } finally {
      setFollowBusy(false);
    }
  };

  const openTalk = async () => {
    const result = scanResult();
    if (!result) return;
    try {
      const contact = await fetchDMContact(result.ap_id);
      if (contact) {
        props.onClose();
        navigate("/?tab=talk");
        chat.selectContact(contact);
      } else {
        app.toast("相互フォローになるとトークできます");
      }
    } catch {
      app.toast("トークを開けませんでした", "error");
    }
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${titleFor(app.actor())} を友だち追加`,
          url: qrUrl(),
        });
      } catch {
        // user cancelled sharing
      }
    } else {
      try {
        await navigator.clipboard.writeText(qrUrl());
        app.toast("リンクをコピーしました");
      } catch {
        app.toast("コピーに失敗しました", "error");
      }
    }
  };

  const resetScan = () => {
    setScanResult(null);
    setScanError(null);
    setFollowDone(false);
    setFollowPending(false);
    setLookingUp(false);
    if (tab() === "scan") void startScanner();
  };

  return (
    <div
      class="p-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="友だち追加"
      ref={(el) => (dialogRoot = el)}
    >
      <DialogA11y root={() => dialogRoot} onClose={props.onClose} />
      <button
        type="button"
        class="p-sheet-dismiss"
        aria-label="閉じる"
        onClick={props.onClose}
      />
      <div class="p-sheet-panel">
        <div class="p-sheet-head">
          <strong>友だち追加</strong>
          <button type="button" onClick={props.onClose} aria-label="閉じる">
            <CloseIcon />
          </button>
        </div>
        <div class="p-qr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab() === "myqr"}
            classList={{ "is-active": tab() === "myqr" }}
            onClick={() => setTab("myqr")}
          >
            マイQRコード
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab() === "scan"}
            classList={{ "is-active": tab() === "scan" }}
            onClick={() => setTab("scan")}
          >
            スキャン
          </button>
        </div>
        <div class="p-sheet-body p-qr-body">
          <Show
            when={tab() === "myqr"}
            fallback={
              <div class="p-qr-scan">
                <Show when={lookingUp()}>
                  <div class="p-qr-state">
                    <SpinnerIcon />
                    <p>確認中…</p>
                  </div>
                </Show>

                <Show when={!lookingUp() && scanResult()}>
                  {(result) => (
                    <div class="p-qr-result">
                      <UserAvatar value={result()} size={72} />
                      <strong>{titleFor(result())}</strong>
                      <small>{fullHandle(result())}</small>
                      <Show when={result().summary}>
                        <p class="p-qr-result-bio">{result().summary}</p>
                      </Show>
                      <Show
                        when={!isSelf()}
                        fallback={<p class="p-qr-self">これはあなたです</p>}
                      >
                        <div class="p-qr-result-actions">
                          <Show
                            when={
                              !followDone() &&
                              !followPending() &&
                              !result().is_following
                            }
                            fallback={
                              <span
                                classList={{
                                  "p-qr-followed": true,
                                  "is-pending": followPending(),
                                }}
                              >
                                {followPending()
                                  ? "リクエスト済み"
                                  : result().is_following && !followDone()
                                    ? "フォロー中"
                                    : "追加しました"}
                              </span>
                            }
                          >
                            <button
                              type="button"
                              class="p-qr-follow"
                              disabled={followBusy()}
                              onClick={() => void handleFollow()}
                            >
                              {followBusy() ? "追加中…" : "友だち追加"}
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="p-qr-talk"
                            onClick={() => void openTalk()}
                          >
                            トーク
                          </button>
                        </div>
                        <Show when={followDone() && !result().is_followed_by}>
                          {/* 友だち追加 is a one-way follow; the 友だち list
                              shows mutuals only — say so instead of leaving
                              the new addition invisibly "missing". */}
                          <p class="p-qr-hint">
                            相手が追加すると友だちに表示されます
                          </p>
                        </Show>
                      </Show>
                      <button
                        type="button"
                        class="p-qr-again"
                        onClick={resetScan}
                      >
                        もう一度スキャン
                      </button>
                    </div>
                  )}
                </Show>

                <Show when={!lookingUp() && !scanResult() && scanError()}>
                  <div class="p-qr-state">
                    <p class="p-qr-error">{scanError()}</p>
                    <button
                      type="button"
                      class="p-qr-again"
                      onClick={resetScan}
                    >
                      もう一度試す
                    </button>
                  </div>
                </Show>

                <Show when={!lookingUp() && !scanResult() && !scanError()}>
                  <div id="yurumeet-qr-scanner" class="p-qr-viewfinder" />
                  <Show when={scanning()}>
                    <p class="p-qr-hint">
                      友だちのQRコードを読み取ってください
                    </p>
                  </Show>
                </Show>
              </div>
            }
          >
            <div class="p-qr-mine">
              <UserAvatar value={app.actor()} size={56} />
              <strong>{titleFor(app.actor())}</strong>
              <small>{fullHandle(app.actor())}</small>
              <div class="p-qr-code">
                <QrSvg
                  value={qrUrl()}
                  size={192}
                  label="友だち追加用のQRコード"
                />
              </div>
              <p class="p-qr-hint">
                このコードをスキャンすると友だち追加できます
              </p>
              <button
                type="button"
                class="p-qr-share"
                onClick={() => void handleShare()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="6" cy="12" r="2.4" />
                  <circle cx="17" cy="6" r="2.4" />
                  <circle cx="17" cy="18" r="2.4" />
                  <path d="m8.2 10.9 6.6-3.8M8.2 13.1l6.6 3.8" />
                </svg>
                リンクを共有
              </button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
