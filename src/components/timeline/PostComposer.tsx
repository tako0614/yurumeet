import { createSignal, For, Show } from "solid-js";
import { createPost, type Post, uploadMedia } from "@takosjp/yurucommu-api";
import { useApp } from "../../lib/app-context.tsx";
import { DialogA11y } from "../../lib/dialog.tsx";
import { CloseIcon, UserAvatar } from "../../lib/ui.tsx";

const MAX_CONTENT = 5000;
const MAX_SUMMARY = 500;
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

type UploadedMedia = {
  url?: string;
  r2_key: string;
  content_type: string;
  preview: string;
  name: string;
};

const VISIBILITY: { value: string; label: string; reach: string }[] = [
  { value: "public", label: "公開", reach: "だれでも見られます" },
  { value: "unlisted", label: "未収載", reach: "フォロー中心に届きます" },
  {
    value: "followers",
    label: "フォロワー限定",
    reach: "フォロワーだけに届きます",
  },
];

export function PostComposer(props: {
  open: boolean;
  onClose: () => void;
  onPosted?: (post: Post) => void;
  replyTo?: { apId: string; author: string };
}) {
  const app = useApp();
  const [content, setContent] = createSignal("");
  const [cwOpen, setCwOpen] = createSignal(false);
  const [summary, setSummary] = createSignal("");
  const [visibility, setVisibility] = createSignal("public");
  const [media, setMedia] = createSignal<UploadedMedia[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [posting, setPosting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let fileInput: HTMLInputElement | undefined;

  const dirty = () =>
    content().trim().length > 0 ||
    summary().trim().length > 0 ||
    media().length > 0;
  const overLimit = () =>
    content().length > MAX_CONTENT || summary().length > MAX_SUMMARY;
  const canPost = () =>
    (content().trim().length > 0 || media().length > 0) &&
    !posting() &&
    !uploading() &&
    !overLimit();

  const reset = () => {
    setContent("");
    setSummary("");
    setCwOpen(false);
    setVisibility("public");
    media().forEach((item) => URL.revokeObjectURL(item.preview));
    setMedia([]);
    setError(null);
  };

  const requestClose = async () => {
    if (posting()) return;
    if (dirty()) {
      const ok = await app.confirm({
        title: "下書きを破棄",
        message: "下書きを破棄しますか?",
        confirmLabel: "破棄",
        danger: true,
      });
      if (!ok) return;
    }
    reset();
    props.onClose();
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (media().length >= MAX_ATTACHMENTS) break;
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_SIZE) {
        setError("画像は 20MB までです");
        continue;
      }
      setUploading(true);
      setError(null);
      try {
        const uploaded = await uploadMedia(file);
        setMedia((prev) => [
          ...prev,
          {
            url: uploaded.url,
            r2_key: uploaded.r2_key,
            content_type: uploaded.content_type,
            preview: URL.createObjectURL(file),
            name: "",
          },
        ]);
      } catch {
        setError("アップロードに失敗しました");
      } finally {
        setUploading(false);
      }
    }
    if (fileInput) fileInput.value = "";
  };

  const removeMedia = (index: number) => {
    setMedia((prev) => {
      const target = prev[index];
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const submit = async () => {
    if (!canPost()) return;
    setPosting(true);
    setError(null);
    try {
      const post = await createPost({
        content: content().trim(),
        summary: summary().trim() || undefined,
        visibility: visibility() !== "public" ? visibility() : undefined,
        in_reply_to: props.replyTo?.apId,
        attachments: media().map((item) => ({
          url: item.url,
          r2_key: item.r2_key,
          content_type: item.content_type,
          name: item.name.trim() || undefined,
        })),
      });
      props.onPosted?.(post);
      app.toast(props.replyTo ? "返信しました" : "投稿しました");
      reset();
      props.onClose();
    } catch {
      setError("投稿に失敗しました");
    } finally {
      setPosting(false);
    }
  };

  let dialogRoot: HTMLDivElement | undefined;
  return (
    <Show when={props.open}>
      <div
        class="p-composer"
        role="dialog"
        aria-modal="true"
        aria-label={props.replyTo ? "返信を作成" : "投稿を作成"}
        ref={(el) => (dialogRoot = el)}
      >
        <DialogA11y
          root={() => dialogRoot}
          onClose={() => void requestClose()}
        />
        <button
          type="button"
          class="p-composer-dismiss"
          aria-label="閉じる"
          onClick={() => void requestClose()}
        />
        <div class="p-composer-panel">
          <div class="p-composer-head">
            <button
              type="button"
              class="p-composer-close"
              onClick={() => void requestClose()}
              aria-label="閉じる"
            >
              <CloseIcon />
            </button>
            <strong>{props.replyTo ? "返信" : "新規投稿"}</strong>
            <button
              type="button"
              class="p-composer-submit"
              disabled={!canPost()}
              onClick={() => void submit()}
            >
              {posting() ? "送信中" : props.replyTo ? "返信" : "投稿"}
            </button>
          </div>

          <Show when={props.replyTo}>
            {(reply) => (
              <p class="p-composer-reply-to">
                <span>@{reply().author}</span> への返信
              </p>
            )}
          </Show>

          <div class="p-composer-body">
            <UserAvatar value={app.actor()} size={40} />
            <div class="p-composer-inputs">
              <Show when={cwOpen()}>
                <input
                  class="p-composer-cw"
                  type="text"
                  value={summary()}
                  maxLength={MAX_SUMMARY}
                  placeholder="内容の警告 (任意)"
                  onInput={(event) => setSummary(event.currentTarget.value)}
                />
              </Show>
              <textarea
                class="p-composer-text"
                value={content()}
                placeholder={props.replyTo ? "返信を入力" : "いまどうしてる?"}
                onInput={(event) => setContent(event.currentTarget.value)}
                autofocus
              />
              <Show when={media().length > 0}>
                <div class="p-composer-media">
                  <For each={media()}>
                    {(item, index) => (
                      <div class="p-composer-media-item">
                        <img src={item.preview} alt="" />
                        <button
                          type="button"
                          class="p-composer-media-remove"
                          aria-label="画像を削除"
                          onClick={() => removeMedia(index())}
                        >
                          <CloseIcon />
                        </button>
                        <input
                          class="p-composer-media-alt"
                          type="text"
                          value={item.name}
                          placeholder="代替テキスト"
                          onInput={(event) =>
                            setMedia((prev) =>
                              prev.map((m, i) =>
                                i === index()
                                  ? { ...m, name: event.currentTarget.value }
                                  : m,
                              ),
                            )
                          }
                        />
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>

          <Show when={error()}>
            {(message) => <p class="p-composer-error">{message()}</p>}
          </Show>

          <div class="p-composer-foot">
            <div class="p-composer-tools">
              <button
                type="button"
                class="p-composer-tool"
                aria-label="画像を追加"
                disabled={uploading() || media().length >= MAX_ATTACHMENTS}
                onClick={() => fileInput?.click()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </button>
              <button
                type="button"
                classList={{
                  "p-composer-tool": true,
                  "is-active": cwOpen(),
                }}
                aria-label="内容の警告"
                aria-pressed={cwOpen()}
                onClick={() => setCwOpen((v) => !v)}
              >
                CW
              </button>
              <Show when={!props.replyTo}>
                <select
                  class="p-composer-visibility"
                  value={visibility()}
                  onChange={(event) => setVisibility(event.currentTarget.value)}
                  aria-label="公開範囲"
                >
                  <For each={VISIBILITY}>
                    {(option) => (
                      <option value={option.value}>{option.label}</option>
                    )}
                  </For>
                </select>
              </Show>
            </div>
            <span
              classList={{
                "p-composer-count": true,
                "is-over": overLimit(),
              }}
            >
              {content().length} / {MAX_CONTENT}
            </span>
          </div>

          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => void handleFiles(event.currentTarget.files)}
          />
        </div>
      </div>
    </Show>
  );
}

export function ComposeFab(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      class="p-compose-fab"
      onClick={props.onClick}
      aria-label="投稿を作成"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );
}
