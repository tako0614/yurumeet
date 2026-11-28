import type { ActorStories } from "@takosjp/yurucommu-api";

export type StoryVideoLike = {
  pause: () => void;
  play: () => Promise<void> | void;
};

/**
 * Keep an active story `<video>` element's playback state in lockstep with the
 * StoryViewerModal pause state (pause button, Spacebar, pointer hold, confirm).
 */
export function syncStoryVideoPlayback(
  video: StoryVideoLike | null | undefined,
  paused: boolean,
): void {
  if (!video) return;
  if (paused) {
    video.pause();
    return;
  }
  const result = video.play();
  if (result && typeof (result as Promise<void>).catch === "function") {
    void (result as Promise<void>).catch(() => {});
  }
}

export type StoryDeepLinkResult =
  | { kind: "wait" }
  | { kind: "clear" }
  | { kind: "open"; actorIndex: number; storyIndex: number };

/**
 * Safely resolve a `/?story=<AP id>` notification deep link without reading the
 * SolidJS `stories` resource while it is loading or errored (reading a failed
 * resource throws and trips the root `<ErrorBoundary>`).
 */
export function resolveStoryDeepLink(
  storyApId: string | undefined,
  resource: {
    loading: boolean;
    error: unknown;
    read: () => ActorStories[] | undefined;
  },
): StoryDeepLinkResult {
  if (!storyApId || resource.loading || resource.error) {
    return { kind: "wait" };
  }
  const groups = resource.read() ?? [];
  for (const [actorIndex, group] of groups.entries()) {
    const storyIndex = group.stories.findIndex(
      (story) => story.ap_id === storyApId,
    );
    if (storyIndex >= 0) {
      return { kind: "open", actorIndex, storyIndex };
    }
  }
  return { kind: "clear" };
}
