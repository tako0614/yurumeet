import { createSignal, Index, Show } from "solid-js";
import { type Actor, updateProfile, uploadMedia } from "@takosjp/yurucommu-api";
import { CloseIcon, UserAvatar } from "../../lib/ui.tsx";

const MAX_NAME = 50;
const MAX_BIO = 500;
const MAX_FIELDS = 4;

export function ProfileEditModal(props: {
  actor: Actor;
  onClose: () => void;
  onSaved: (updated: Actor) => void;
}) {
  const [name, setName] = createSignal(props.actor.name ?? "");
  const [summary, setSummary] = createSignal(props.actor.summary ?? "");
  const [iconUrl, setIconUrl] = createSignal(props.actor.icon_url ?? "");
  const [headerUrl, setHeaderUrl] = createSignal(props.actor.header_url ?? "");
  const [isPrivate, setIsPrivate] = createSignal(!!props.actor.is_private);
  const [fields, setFields] = createSignal<{ name: string; value: string }[]>(
    props.actor.fields?.map((f) => ({ ...f })) ?? [],
  );
  const [uploading, setUploading] = createSignal<null | "icon" | "header">(
    null,
  );

  const cleanFields = () =>
    fields()
      .map((f) => ({ name: f.name.trim(), value: f.value.trim() }))
      .filter((f) => f.name && f.value);
  const updateField = (index: number, key: "name" | "value", value: string) =>
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, [key]: value } : f)),
    );
  const addField = () =>
    setFields((prev) =>
      prev.length >= MAX_FIELDS ? prev : [...prev, { name: "", value: "" }],
    );
  const removeField = (index: number) =>
    setFields((prev) => prev.filter((_, i) => i !== index));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const upload = async (file: File | undefined, target: "icon" | "header") => {
    if (!file) return;
    setUploading(target);
    setError(null);
    try {
      const uploaded = await uploadMedia(file);
      if (target === "icon") setIconUrl(uploaded.url ?? "");
      else setHeaderUrl(uploaded.url ?? "");
    } catch {
      setError("画像のアップロードに失敗しました");
    } finally {
      setUploading(null);
    }
  };

  const save = async () => {
    if (saving() || uploading()) return;
    setSaving(true);
    setError(null);
    try {
      const nextFields = cleanFields();
      await updateProfile({
        name: name().trim() || undefined,
        summary: summary().trim(),
        icon_url: iconUrl() || undefined,
        header_url: headerUrl() || undefined,
        is_private: isPrivate(),
        fields: nextFields,
      });
      props.onSaved({
        ...props.actor,
        name: name().trim() || props.actor.name,
        summary: summary().trim(),
        icon_url: iconUrl() || props.actor.icon_url,
        header_url: headerUrl() || props.actor.header_url,
        is_private: isPrivate(),
        fields: nextFields,
      });
    } catch {
      setError("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      class="p-composer"
      role="dialog"
      aria-modal="true"
      aria-label="プロフィールを編集"
    >
      <button
        type="button"
        class="p-composer-dismiss"
        aria-label="閉じる"
        onClick={props.onClose}
      />
      <div class="p-composer-panel">
        <div class="p-composer-head">
          <button
            type="button"
            class="p-composer-close"
            onClick={props.onClose}
            aria-label="閉じる"
          >
            <CloseIcon />
          </button>
          <strong>プロフィールを編集</strong>
          <button
            type="button"
            class="p-composer-submit"
            disabled={saving() || !!uploading()}
            onClick={() => void save()}
          >
            {saving() ? "保存中" : "保存"}
          </button>
        </div>

        <div class="p-edit-body">
          <label class="p-edit-banner">
            <Show when={headerUrl()}>
              {(src) => <img src={src()} alt="" />}
            </Show>
            <span class="p-edit-banner-cta">
              {uploading() === "header" ? "アップロード中…" : "ヘッダーを変更"}
            </span>
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) =>
                void upload(e.currentTarget.files?.[0], "header")
              }
            />
          </label>

          <label class="p-edit-avatar">
            <UserAvatar
              value={{ ...props.actor, icon_url: iconUrl() || null }}
              size={72}
            />
            <span class="p-edit-avatar-cta">
              {uploading() === "icon" ? "…" : "変更"}
            </span>
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => void upload(e.currentTarget.files?.[0], "icon")}
            />
          </label>

          <div class="p-edit-fields">
            <label class="p-edit-field">
              <span>表示名</span>
              <input
                type="text"
                value={name()}
                maxLength={MAX_NAME}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>
            <label class="p-edit-field">
              <span>自己紹介</span>
              <textarea
                value={summary()}
                maxLength={MAX_BIO}
                rows={4}
                onInput={(e) => setSummary(e.currentTarget.value)}
              />
            </label>
            <label class="p-edit-toggle">
              <span>
                <strong>非公開アカウント</strong>
                <small>フォローを承認制にします</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={isPrivate()}
                onChange={(e) => setIsPrivate(e.currentTarget.checked)}
              />
            </label>

            <div class="p-edit-extra">
              <div class="p-edit-extra-head">
                <span>追加情報</span>
                <Show when={fields().length < MAX_FIELDS}>
                  <button type="button" onClick={addField}>
                    ＋ 項目を追加
                  </button>
                </Show>
              </div>
              <Index each={fields()}>
                {(field, index) => (
                  <div class="p-edit-extra-row">
                    <input
                      type="text"
                      value={field().name}
                      placeholder="ラベル"
                      onInput={(e) =>
                        updateField(index, "name", e.currentTarget.value)
                      }
                    />
                    <input
                      type="text"
                      value={field().value}
                      placeholder="内容"
                      onInput={(e) =>
                        updateField(index, "value", e.currentTarget.value)
                      }
                    />
                    <button
                      type="button"
                      class="p-edit-extra-remove"
                      aria-label="削除"
                      onClick={() => removeField(index)}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                )}
              </Index>
            </div>
          </div>

          <Show when={error()}>
            {(message) => <p class="p-composer-error">{message()}</p>}
          </Show>
        </div>
      </div>
    </div>
  );
}
