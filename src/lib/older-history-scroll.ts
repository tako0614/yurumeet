import type { AppliedOlderHistory } from "./history-read-coordinator.ts";

type ScrollElement = Pick<
  HTMLElement,
  "scrollHeight" | "scrollTop" | "isConnected"
>;

/** Own the interval from starting an older read through its scroll frame. */
export function createOlderHistoryScroll(
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
) {
  let generation = 0;
  let busy = false;
  let frame: { id: number; finish: () => void } | null = null;

  const invalidate = () => {
    generation++;
    busy = false;
    if (frame) {
      const pending = frame;
      frame = null;
      cancel(pending.id);
      pending.finish();
    }
  };

  return {
    invalidate,
    run: async (
      element: ScrollElement,
      loadOlder: () => Promise<AppliedOlderHistory | null>,
      isElementCurrent: () => boolean,
    ): Promise<void> => {
      if (busy) return;
      busy = true;
      const token = generation;
      const height = element.scrollHeight;
      const top = element.scrollTop;
      const canScroll = (applied: AppliedOlderHistory) =>
        token === generation &&
        applied.isCurrent() &&
        element.isConnected &&
        isElementCurrent();
      try {
        const applied = await loadOlder();
        if (!applied || !canScroll(applied)) return;
        await new Promise<void>((finish) => {
          const id = schedule(() => {
            try {
              if (!canScroll(applied)) return;
              const grown = element.scrollHeight - height;
              if (grown > 0) element.scrollTop = top + grown;
            } finally {
              if (frame?.id === id) frame = null;
              finish();
            }
          });
          frame = { id, finish };
        });
      } finally {
        // An invalidated read must not release a newer conversation's latch.
        if (token === generation) busy = false;
      }
    },
  };
}
