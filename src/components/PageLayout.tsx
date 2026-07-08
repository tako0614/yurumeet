import { Show, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { NavKey } from "./NavRail.tsx";
import { BackIcon } from "../lib/ui.tsx";

/**
 * A routed page renders inside the shell's left content panel (the persistent
 * chat lives to its right). This is just the scrolling page container; the
 * NavRail is provided once by the shell. `active` is accepted for call-site
 * compatibility but is no longer used here.
 */
export function PageLayout(props: { active?: NavKey; children: JSX.Element }) {
  void props.active;
  return <div class="p-page">{props.children}</div>;
}

export function PageHeader(props: {
  title: string;
  subtitle?: string;
  back?: boolean;
  actions?: JSX.Element;
}) {
  const navigate = useNavigate();
  return (
    <div class="p-page-header">
      <Show when={props.back !== false}>
        <button
          type="button"
          class="p-page-back"
          onClick={() => navigate(-1)}
          aria-label="戻る"
        >
          <BackIcon />
        </button>
      </Show>
      <div class="p-page-header-main">
        <h1>{props.title}</h1>
        <Show when={props.subtitle}>
          <span>{props.subtitle}</span>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="p-page-header-actions">{props.actions}</div>
      </Show>
    </div>
  );
}
