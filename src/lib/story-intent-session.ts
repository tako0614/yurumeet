import {
  createStoryIntentCoordinator,
  type StoryIntentScope,
  type StoryIntentSnapshot,
  type StoryIntentStorage,
} from "./story-intent.ts";

export type StoryIntentCoordinator = ReturnType<
  typeof createStoryIntentCoordinator
>;

export type StoryIntentSessionSnapshot = StoryIntentSnapshot & {
  busy: boolean;
};

export interface StoryIntentSessionEntry {
  readonly scope: Readonly<Required<StoryIntentScope>>;
  readonly coordinator: StoryIntentCoordinator;
  read(): StoryIntentSessionSnapshot;
  subscribe(
    listener: (snapshot: StoryIntentSessionSnapshot) => void,
  ): () => void;
  run<T>(
    operation: (coordinator: StoryIntentCoordinator) => Promise<T>,
  ): Promise<T | undefined>;
}

export interface StoryIntentSession {
  get(scope: StoryIntentScope): StoryIntentSessionEntry;
}

function resolveScope(scope: StoryIntentScope): Required<StoryIntentScope> {
  const originUrl = new URL(scope.origin);
  if (
    (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") ||
    originUrl.origin !== scope.origin ||
    originUrl.username ||
    originUrl.password ||
    originUrl.search ||
    originUrl.hash
  )
    throw new Error("Story session requires a canonical origin");

  const principalUrl = new URL(scope.principal);
  if (
    principalUrl.origin !== scope.origin ||
    principalUrl.username ||
    principalUrl.password ||
    principalUrl.search ||
    principalUrl.hash ||
    principalUrl.href !== scope.principal ||
    !/^\/ap\/users\/[A-Za-z0-9._~-]+$/.test(principalUrl.pathname)
  )
    throw new Error("Story session requires a canonical local principal");

  const endpoint = scope.endpoint ?? `${scope.origin}/api/stories`;
  const endpointUrl = new URL(endpoint);
  if (
    endpointUrl.origin !== scope.origin ||
    (endpointUrl.protocol !== "https:" && endpointUrl.protocol !== "http:") ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash ||
    endpointUrl.href !== endpoint ||
    endpointUrl.pathname !== "/api/stories"
  )
    throw new Error("Story session requires the exact local Story endpoint");

  return Object.freeze({
    origin: scope.origin,
    principal: scope.principal,
    endpoint,
  });
}

function sessionKey(scope: Required<StoryIntentScope>): string {
  return `${scope.origin}\u0000${scope.principal}\u0000${scope.endpoint}`;
}

function notifySafely(
  listeners: Set<(snapshot: StoryIntentSessionSnapshot) => void>,
  snapshot: StoryIntentSessionSnapshot,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      // A rendering subscriber cannot change or reject the remote operation.
    }
  }
}

export function createStoryIntentSession(
  storage?: StoryIntentStorage,
): StoryIntentSession {
  const entries = new Map<string, StoryIntentSessionEntry>();

  return {
    get(input) {
      const scope = resolveScope(input);
      const key = sessionKey(scope);
      const existing = entries.get(key);
      if (existing) return existing;

      const coordinator = createStoryIntentCoordinator(scope, storage);
      const listeners = new Set<
        (snapshot: StoryIntentSessionSnapshot) => void
      >();
      let busy = false;
      const read = (): StoryIntentSessionSnapshot => ({
        ...coordinator.read(),
        busy,
      });
      const notify = () => notifySafely(listeners, read());

      const entry: StoryIntentSessionEntry = {
        scope,
        coordinator,
        read,
        subscribe(listener) {
          listeners.add(listener);
          try {
            listener(read());
          } catch {
            // Handle a synchronous first-render failure the same way as updates.
          }
          return () => listeners.delete(listener);
        },
        async run<T>(operation: (value: StoryIntentCoordinator) => Promise<T>) {
          if (busy) return undefined;
          busy = true;
          notify();
          try {
            return await operation(coordinator);
          } finally {
            busy = false;
            notify();
          }
        },
      };
      entries.set(key, entry);
      return entry;
    },
  };
}

/**
 * Page-module lifetime session. No browser storage is touched until `get()`
 * constructs the exact scoped coordinator.
 */
export const storyIntentSession = createStoryIntentSession();
