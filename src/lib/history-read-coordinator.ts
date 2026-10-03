/**
 * Orders full history reads and newest-page polls for one open conversation.
 * A new full read invalidates polls already in flight. A successful poll that
 * started after that read takes ownership of its result, so a slower full
 * response cannot replace or fail the usable history.
 */
export type AppliedOlderHistory = { isCurrent: () => boolean };

export function createHistoryReadCoordinator() {
  let generation = 0;
  let pollSucceeded = false;

  const isCurrent = (token: number) => token === generation;

  return {
    generation: () => generation,
    isCurrent,
    invalidate: () => {
      generation++;
      pollSucceeded = false;
    },
    runOlder: async <T>(
      read: () => Promise<T>,
      handlers: {
        isScopeCurrent: () => boolean;
        /** True only when new canonical rows remain in the displayed list. */
        onSuccess: (value: T) => boolean;
        onFailure: () => void;
      },
    ): Promise<AppliedOlderHistory | null> => {
      const token = generation;
      const canApply = () => isCurrent(token) && handlers.isScopeCurrent();
      let value: T;
      try {
        value = await read();
      } catch {
        if (canApply()) handlers.onFailure();
        return null;
      }
      if (!canApply()) return null;
      const prepended = handlers.onSuccess(value);
      // A consumer may refresh or switch scope inside its apply callback.
      return prepended && canApply() ? { isCurrent: canApply } : null;
    },
    runFull: async <T>(
      read: () => Promise<T>,
      handlers: {
        isScopeCurrent: () => boolean;
        onStart: () => void;
        onSuccess: (value: T) => void;
        onFailure: () => void;
        onFinally: () => void;
      },
    ): Promise<void> => {
      const token = ++generation;
      pollSucceeded = false;
      const canApply = () =>
        isCurrent(token) && !pollSucceeded && handlers.isScopeCurrent();
      handlers.onStart();
      let value: T;
      try {
        value = await read();
      } catch {
        if (canApply()) handlers.onFailure();
        if (canApply()) handlers.onFinally();
        return;
      }
      if (!canApply()) return;
      try {
        handlers.onSuccess(value);
      } finally {
        if (canApply()) handlers.onFinally();
      }
    },
    runPoll: async <T>(
      read: () => Promise<T>,
      handlers: {
        isScopeCurrent: () => boolean;
        onSuccess: (value: T) => void;
        onFailure: () => void;
      },
    ): Promise<number | null> => {
      const token = generation;
      const canApply = () => isCurrent(token) && handlers.isScopeCurrent();
      let value: T;
      try {
        value = await read();
      } catch {
        if (canApply()) handlers.onFailure();
        return null;
      }
      if (!canApply()) return null;
      pollSucceeded = true;
      handlers.onSuccess(value);
      return isCurrent(token) ? token : null;
    },
  };
}
