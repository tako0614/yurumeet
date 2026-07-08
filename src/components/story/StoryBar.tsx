import { For, Show, type JSX } from "solid-js";
import type { ActorStories } from "@takosjp/yurucommu-api";

type StoryActor = {
  ap_id: string;
  name?: string | null;
  preferred_username?: string;
  username?: string;
  icon_url?: string | null;
};

type StoryBarLabels = {
  yourStory: string;
  addStory: string;
};

interface StoryBarProps {
  actor: StoryActor;
  actorStories: ActorStories[];
  labels: StoryBarLabels;
  renderAvatar: (actor: StoryActor) => JSX.Element;
  onStoryClick: (actorStories: ActorStories, index: number) => void;
  onAddStory?: () => void;
}

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export function StoryBar(props: StoryBarProps) {
  const myStories = () =>
    props.actorStories.find((group) => group.actor.ap_id === props.actor.ap_id);
  const hasMyStories = () => (myStories()?.stories.length ?? 0) > 0;
  const otherStories = () =>
    props.actorStories.filter(
      (group) => group.actor.ap_id !== props.actor.ap_id,
    );

  const openMine = () => {
    const group = myStories();
    if (group && hasMyStories()) {
      props.onStoryClick(group, 0);
      return;
    }
    props.onAddStory?.();
  };

  return (
    <div class="yc-story-bar">
      <div class="yc-story-tile">
        <div class="yc-story-avatar-wrap">
          <button
            type="button"
            classList={{
              "yc-story-ring": true,
              "is-new": !!myStories()?.has_unviewed,
              "is-empty": !hasMyStories(),
            }}
            onClick={openMine}
          >
            <span>{props.renderAvatar(props.actor)}</span>
          </button>
          <Show when={props.onAddStory}>
            <button
              type="button"
              class="yc-story-add"
              aria-label={props.labels.addStory}
              onClick={(event) => {
                event.stopPropagation();
                props.onAddStory?.();
              }}
            >
              <PlusIcon />
            </button>
          </Show>
        </div>
        <span>
          {hasMyStories() ? props.labels.yourStory : props.labels.addStory}
        </span>
      </div>

      <For each={otherStories()}>
        {(group, index) => (
          <button
            type="button"
            class="yc-story-tile"
            onClick={() => props.onStoryClick(group, index())}
          >
            <span
              classList={{
                "yc-story-ring": true,
                "is-new": group.has_unviewed,
              }}
            >
              <span>{props.renderAvatar(group.actor)}</span>
            </span>
            <span>{group.actor.name || group.actor.preferred_username}</span>
          </button>
        )}
      </For>
    </div>
  );
}
