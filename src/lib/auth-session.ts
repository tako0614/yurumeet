import type { Actor } from "@takosjp/yurucommu-api";

export interface AuthSessionState {
  readonly origin: string | null;
  readonly actor: Actor | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly logoutBusy: boolean;
  readonly logoutError: string | null;
  /** True only after an auth observation has confirmed an anonymous session. */
  readonly navigationAllowed: boolean;
}

export interface AuthSessionDependencies {
  /** Returns null only when the current session is confirmed anonymous. */
  readCurrentActor(origin: string): Promise<Actor | null>;
  postLogout(origin: string): Promise<Response>;
  clearPush(signal: AbortSignal): Promise<void>;
  suppressOidc(): void;
}

export interface AuthSessionInitialState {
  origin: string | null;
  actor: Actor | null;
  loading?: boolean;
  error?: string | null;
  /** Localized text shown when the session is still authenticated after logout. */
  logoutErrorText: string;
  /** Localized text shown when the post-logout auth observation is unavailable. */
  observationErrorText: string;
}

export interface AuthSessionController {
  read(): AuthSessionState;
  subscribe(listener: (state: AuthSessionState) => void): () => void;
  configure(
    origin: string | null,
    actor?: Actor | null,
    loading?: boolean,
  ): void;
  refresh(): Promise<void>;
  logout(): Promise<boolean>;
  dispose(): void;
}

/**
 * Root-lifetime auth state and async-operation fences, independent of UI or
 * framework lifecycle. All async work is bound to the configured origin and
 * scope generation; principal equality is checked by AP actor identity.
 */
export function createAuthSessionController(
  dependencies: AuthSessionDependencies,
  initial: AuthSessionInitialState,
): AuthSessionController {
  let generation = 0;
  let refreshTicket = 0;
  let disposed = false;
  let pushCleanup: AbortController | null = null;
  let pendingLogout: { origin: string; principal: string } | null = null;
  const listeners = new Set<(state: AuthSessionState) => void>();
  const strings = {
    logoutErrorText: initial.logoutErrorText,
    observationErrorText: initial.observationErrorText,
  };
  let state: AuthSessionState = Object.freeze({
    origin: initial.origin,
    actor: initial.actor,
    loading: initial.loading ?? false,
    error: initial.error ?? null,
    logoutBusy: false,
    logoutError: null,
    navigationAllowed: false,
  });

  const publish = (next: AuthSessionState) => {
    if (disposed) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // UI observers must not affect auth operations.
      }
    }
  };

  const scopeMatches = (
    capturedGeneration: number,
    origin: string,
    principal: string,
  ) =>
    // AP identity equality alone cannot validate work after reconfiguration;
    // generation also separates successive local auth-session lifetimes.
    !disposed &&
    generation === capturedGeneration &&
    state.origin === origin &&
    state.actor?.ap_id === principal;

  return {
    read() {
      return state;
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      try {
        listener(state);
      } catch {
        // Match update notification behavior for a synchronous initial read.
      }
      return () => listeners.delete(listener);
    },
    configure(origin, actor = null, loading = false) {
      if (disposed) return;
      pushCleanup?.abort();
      pendingLogout = null;
      generation += 1;
      refreshTicket += 1;
      publish({
        origin,
        actor,
        loading,
        error: null,
        logoutBusy: false,
        logoutError: null,
        navigationAllowed: false,
      });
    },
    async refresh() {
      if (disposed || state.logoutBusy || !state.origin) return;
      const origin = state.origin;
      const previousActor = state.actor;
      const previousLogoutError = state.logoutError;
      const capturedGeneration = generation;
      const ticket = ++refreshTicket;
      publish({ ...state, loading: true, error: null });
      try {
        const actor = await dependencies.readCurrentActor(origin);
        if (
          disposed ||
          generation !== capturedGeneration ||
          refreshTicket !== ticket ||
          state.origin !== origin
        )
          return;
        if (previousActor && actor && actor.ap_id !== previousActor.ap_id) {
          // Ordinary profile refresh must not transplant a new principal into
          // a mounted chat/editor. A manual recheck starts from hidden state.
          pendingLogout = null;
          generation += 1;
          publish({
            ...state,
            actor: null,
            loading: false,
            error: strings.observationErrorText,
            navigationAllowed: false,
          });
          return;
        }
        const samePendingPrincipal =
          pendingLogout?.origin === origin &&
          pendingLogout.principal === actor?.ap_id;
        if (!samePendingPrincipal) pendingLogout = null;
        publish({
          ...state,
          actor,
          loading: false,
          error: null,
          logoutError: samePendingPrincipal
            ? strings.logoutErrorText
            : actor && actor.ap_id === previousActor?.ap_id
              ? previousLogoutError
              : null,
          navigationAllowed: actor === null,
        });
      } catch {
        if (
          disposed ||
          generation !== capturedGeneration ||
          refreshTicket !== ticket ||
          state.origin !== origin
        )
          return;
        // An unavailable read cannot prove either identity or sign-out.
        publish({
          ...state,
          actor: null,
          loading: false,
          error: strings.observationErrorText,
          navigationAllowed: false,
        });
      }
    },
    async logout() {
      if (disposed || state.logoutBusy || !state.origin || !state.actor) {
        return false;
      }
      const origin = state.origin;
      const principal = state.actor.ap_id;
      generation += 1;
      refreshTicket += 1;
      const capturedGeneration = generation;
      pendingLogout = { origin, principal };
      publish({
        ...state,
        loading: true,
        error: null,
        logoutBusy: true,
        logoutError: null,
        navigationAllowed: false,
      });

      try {
        try {
          dependencies.suppressOidc();
        } catch {
          // Suppression failure must not skip the server-side logout attempt.
        }
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = new AbortController();
        pushCleanup = cleanup;
        try {
          await Promise.race([
            dependencies.clearPush(cleanup.signal),
            new Promise<void>((resolve) => {
              cleanupTimer = setTimeout(() => {
                cleanup.abort();
                resolve();
              }, 5_000);
            }),
          ]);
        } catch {
          // Push cleanup is best effort; it must not prevent session logout.
        } finally {
          clearTimeout(cleanupTimer);
          cleanup.abort();
          if (pushCleanup === cleanup) pushCleanup = null;
        }

        // These side effects can yield. A changed root scope must never receive
        // a logout POST initiated for the previous principal.
        if (!scopeMatches(capturedGeneration, origin, principal)) return false;

        try {
          const response = await dependencies.postLogout(origin);
          if (!response.ok) throw new Error("Logout acknowledgement refused");
        } catch {
          // Status and transport errors remain inconclusive until observation.
        }

        if (!scopeMatches(capturedGeneration, origin, principal)) return false;

        // Status and transport outcome are both inconclusive. Observe exactly
        // once, and only let this generation publish the result.
        let observed: Actor | null;
        try {
          observed = await dependencies.readCurrentActor(origin);
        } catch {
          if (scopeMatches(capturedGeneration, origin, principal)) {
            publish({
              ...state,
              actor: null,
              loading: false,
              error: strings.observationErrorText,
              logoutBusy: false,
              logoutError: strings.logoutErrorText,
              navigationAllowed: false,
            });
          }
          return false;
        }

        if (!scopeMatches(capturedGeneration, origin, principal)) return false;
        if (observed === null) {
          pendingLogout = null;
          publish({
            ...state,
            actor: null,
            loading: false,
            error: null,
            logoutBusy: false,
            logoutError: null,
            navigationAllowed: true,
          });
          return true;
        }
        if (observed.ap_id === principal) {
          publish({
            ...state,
            actor: observed,
            loading: false,
            error: null,
            logoutBusy: false,
            logoutError: strings.logoutErrorText,
            navigationAllowed: false,
          });
          return false;
        }

        // A different principal means the captured actor is stale. Hide it and
        // require an explicit refresh before exposing the newly observed one.
        pendingLogout = null;
        publish({
          ...state,
          actor: null,
          loading: false,
          error: strings.observationErrorText,
          logoutBusy: false,
          logoutError: strings.logoutErrorText,
          navigationAllowed: false,
        });
        return false;
      } finally {
        // A superseding configure() owns its state, including the busy flag.
        if (
          state.logoutBusy &&
          scopeMatches(capturedGeneration, origin, principal)
        ) {
          publish({ ...state, loading: false, logoutBusy: false });
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pushCleanup?.abort();
      pendingLogout = null;
      generation += 1;
      refreshTicket += 1;
      listeners.clear();
    },
  };
}
