import type { createStory } from "@takosjp/yurucommu-api";

type StoryPayload = Parameters<typeof createStory>[0];
type UploadedStoryMedia = {
  url?: string;
  r2_key: string;
  content_type: string;
};

/** Submit one click-time draft; later editor changes cannot alter its payload. */
export async function submitStoryDraft<Created>(
  draft: { file: File; caption: string },
  effects: {
    upload: (file: File) => Promise<UploadedStoryMedia>;
    create: (payload: StoryPayload) => Promise<Created>;
  },
): Promise<Created> {
  const selected = draft.file;
  const caption = draft.caption.trim() || undefined;
  const displayDuration = selected.type.startsWith("video/") ? "PT10S" : "PT5S";
  const uploaded = await effects.upload(selected);
  // The upload response supplies media references, never new editor metadata.
  return effects.create({
    attachment: {
      url: uploaded.url,
      r2_key: uploaded.r2_key,
      content_type: uploaded.content_type,
    },
    displayDuration,
    caption,
  });
}
