import { expect, test } from "bun:test";
import type { Actor } from "@takosjp/yurucommu-api";
import {
  createAuthSessionController,
  type AuthSessionDependencies,
} from "./auth-session.ts";

const ORIGIN = "https://meet.example.test";
const LOGOUT_ERROR = "Sign out was not confirmed. Retry sign out.";
const OBSERVATION_ERROR = "Could not check the current session. Refresh.";

function actor(apId = `${ORIGIN}/ap/users/alice`): Actor {
  return {
    ap_id: apId,
    username: "alice",
    preferred_username: "alice",
    name: "Alice",
    summary: null,
    icon_url: null,
    header_url: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controller(
  dependencies: Partial<AuthSessionDependencies> = {},
  initialActor: Actor | null = actor(),
) {
  let reads = 0;
  let posts = 0;
  let suppressions = 0;
  let pushClears = 0;
  const overrides = dependencies;
  const deps: AuthSessionDependencies = {
    async readCurrentActor(origin) {
      reads += 1;
      return overrides.readCurrentActor
        ? overrides.readCurrentActor(origin)
        : null;
    },
    async postLogout(origin) {
      posts += 1;
      return overrides.postLogout
        ? overrides.postLogout(origin)
        : new Response(null, { status: 204 });
    },
    async clearPush(signal) {
      pushClears += 1;
      await overrides.clearPush?.(signal);
    },
    suppressOidc() {
      suppressions += 1;
      overrides.suppressOidc?.();
    },
  };
  const session = createAuthSessionController(deps, {
    origin: ORIGIN,
    actor: initialActor,
    logoutErrorText: LOGOUT_ERROR,
    observationErrorText: OBSERVATION_ERROR,
  });
  return {
    session,
    counts: () => ({ reads, posts, suppressions, pushClears }),
  };
}

test("media auth epoch survives profile refresh but retires on failed same-user logout", async () => {
  const original = actor();
  const h = controller({
    readCurrentActor: async () => ({ ...original, name: "updated metadata" }),
    postLogout: async () => new Response(null, { status: 503 }),
  });
  const epoch = h.session.epoch();
  await h.session.refresh();
  expect(h.session.epoch()).toBe(epoch);
  const logout = h.session.logout();
  expect(h.session.epoch()).toBeGreaterThan(epoch);
  const logoutEpoch = h.session.epoch();
  expect(await logout).toBe(false);
  expect(h.session.read().actor?.ap_id).toBe(original.ap_id);
  expect(h.session.epoch()).toBe(logoutEpoch);
  h.session.configure(ORIGIN, original);
  expect(h.session.epoch()).toBeGreaterThan(logoutEpoch);
  h.session.dispose();
});

test("non-success acknowledgement keeps the observed actor and explicit retry error", async () => {
  const observed = actor();
  let currentActor: Actor | null = observed;
  let acknowledgements = 0;
  const h = controller({
    async postLogout() {
      acknowledgements += 1;
      return new Response(null, { status: acknowledgements === 1 ? 503 : 200 });
    },
    async readCurrentActor() {
      return currentActor;
    },
  });

  expect(await h.session.logout()).toBe(false);
  expect(h.session.read()).toMatchObject({
    actor: observed,
    loading: false,
    logoutBusy: false,
    logoutError: LOGOUT_ERROR,
    navigationAllowed: false,
  });
  expect(h.counts()).toEqual({
    reads: 1,
    posts: 1,
    suppressions: 1,
    pushClears: 1,
  });

  currentActor = null;
  expect(await h.session.logout()).toBe(true);
  expect(h.counts()).toEqual({
    reads: 2,
    posts: 2,
    suppressions: 2,
    pushClears: 2,
  });
  expect(h.session.read()).toMatchObject({
    actor: null,
    logoutError: null,
    navigationAllowed: true,
  });
});

test("lost acknowledgement followed by anonymous observation confirms logout", async () => {
  const h = controller({
    async postLogout() {
      throw new TypeError("connection lost after server invalidated session");
    },
  });

  expect(await h.session.logout()).toBe(true);
  expect(h.counts()).toEqual({
    reads: 1,
    posts: 1,
    suppressions: 1,
    pushClears: 1,
  });
  expect(h.session.read()).toMatchObject({
    actor: null,
    loading: false,
    logoutBusy: false,
    logoutError: null,
    error: null,
    navigationAllowed: true,
  });
});

test("successful acknowledgement does not override a still-authenticated observation", async () => {
  const observed = actor();
  const h = controller({
    async postLogout() {
      return new Response(null, { status: 200 });
    },
    async readCurrentActor() {
      return observed;
    },
  });

  expect(await h.session.logout()).toBe(false);
  expect(h.counts().reads).toBe(1);
  expect(h.session.read().actor).toBe(observed);
  expect(h.session.read().logoutError).toBe(LOGOUT_ERROR);
  expect(h.session.read().navigationAllowed).toBe(false);
});

test("failed post-logout observation hides stale actor and requires refresh", async () => {
  const h = controller({
    async readCurrentActor() {
      throw new Error("auth endpoint unavailable");
    },
  });

  expect(await h.session.logout()).toBe(false);
  expect(h.session.read()).toMatchObject({
    actor: null,
    error: OBSERVATION_ERROR,
    logoutError: LOGOUT_ERROR,
    navigationAllowed: false,
    logoutBusy: false,
  });
});

test("manual recheck after unavailable logout observation restores same-principal retry", async () => {
  let reads = 0;
  const h = controller({
    async postLogout() {
      throw new TypeError("ACK lost");
    },
    async readCurrentActor() {
      if (++reads === 1) throw new Error("auth endpoint unavailable");
      return { ...actor(), name: "Refreshed profile" };
    },
  });
  expect(await h.session.logout()).toBe(false);
  expect(h.session.read().actor).toBeNull();
  await h.session.refresh();
  expect(h.session.read()).toMatchObject({
    actor: { ap_id: actor().ap_id },
    error: null,
    logoutError: LOGOUT_ERROR,
    navigationAllowed: false,
  });
  expect(h.counts().posts).toBe(1);
});

test("manual recheck clears a pending logout only for anonymous or a new principal", async () => {
  for (const observed of [null, actor(`${ORIGIN}/ap/users/bob`)]) {
    let reads = 0;
    const h = controller({
      async readCurrentActor() {
        if (++reads === 1) throw new Error("auth endpoint unavailable");
        return observed;
      },
    });
    expect(await h.session.logout()).toBe(false);
    await h.session.refresh();
    expect(h.session.read()).toMatchObject({
      actor: observed,
      error: null,
      logoutError: null,
      navigationAllowed: observed === null,
    });
    expect(h.counts().posts).toBe(1);
  }
});

test("an intervening different principal invalidates the old logout retry marker", async () => {
  for (const firstObservationFails of [false, true]) {
    const observations = firstObservationFails
      ? [
          new Error("unavailable"),
          actor(),
          actor(`${ORIGIN}/ap/users/bob`),
          actor(),
        ]
      : [actor(`${ORIGIN}/ap/users/bob`), actor()];
    const h = controller({
      async readCurrentActor() {
        const value = observations.shift();
        if (value instanceof Error) throw value;
        return value ?? null;
      },
    });
    expect(await h.session.logout()).toBe(false);
    if (firstObservationFails) {
      await h.session.refresh();
      expect(h.session.read().logoutError).toBe(LOGOUT_ERROR);
      await h.session.refresh();
    }
    expect(h.session.read().actor).toBeNull();
    await h.session.refresh();
    expect(h.session.read().actor?.ap_id).toBe(actor().ap_id);
    expect(h.session.read().logoutError).toBeNull();
    expect(h.counts().posts).toBe(1);
  }
});

test("a different observed principal is hidden until a manual refresh", async () => {
  const other = actor(`${ORIGIN}/ap/users/bob`);
  const h = controller({
    async readCurrentActor() {
      return other;
    },
  });

  expect(await h.session.logout()).toBe(false);
  expect(h.session.read()).toMatchObject({
    actor: null,
    error: OBSERVATION_ERROR,
    logoutError: LOGOUT_ERROR,
    navigationAllowed: false,
  });
  await h.session.refresh();
  expect(h.session.read().actor).toBe(other);
  expect(h.session.read().error).toBeNull();
});

test("duplicate logout is fenced while push cleanup is pending", async () => {
  const cleanup = deferred<void>();
  const h = controller({
    clearPush: () => cleanup.promise,
  });
  const first = h.session.logout();

  expect(h.session.read().logoutBusy).toBe(true);
  expect(await h.session.logout()).toBe(false);
  expect(h.counts().posts).toBe(0);
  cleanup.resolve();
  expect(await first).toBe(true);
  expect(h.counts().posts).toBe(1);
});

test("logout start fences a delayed earlier refresh", async () => {
  const oldRefresh = deferred<Actor | null>();
  let read = 0;
  const h = controller({
    async readCurrentActor() {
      read += 1;
      if (read === 1) return oldRefresh.promise;
      return null;
    },
  });

  const refreshing = h.session.refresh();
  const loggingOut = h.session.logout();
  expect(await loggingOut).toBe(true);
  oldRefresh.resolve(actor());
  await refreshing;
  expect(h.session.read()).toMatchObject({
    actor: null,
    navigationAllowed: true,
  });
});

test("configure during cleanup prevents the old principal logout POST", async () => {
  const cleanup = deferred<void>();
  let signal: AbortSignal | undefined;
  const h = controller({
    clearPush: (value) => {
      signal = value;
      return cleanup.promise;
    },
  });
  const oldLogout = h.session.logout();
  const replacement = actor(`${ORIGIN}/ap/users/bob`);
  h.session.configure(ORIGIN, replacement, false);
  expect(signal?.aborted).toBe(true);
  cleanup.resolve();

  expect(await oldLogout).toBe(false);
  expect(h.counts().posts).toBe(0);
  expect(h.session.read()).toMatchObject({
    actor: replacement,
    logoutBusy: false,
    logoutError: null,
  });
});

test("configure during POST fences its later observation from new root state", async () => {
  const post = deferred<Response>();
  const started = deferred<void>();
  const replacement = actor(`${ORIGIN}/ap/users/bob`);
  const h = controller({
    postLogout() {
      started.resolve();
      return post.promise;
    },
  });
  const oldLogout = h.session.logout();
  await started.promise;
  h.session.configure("https://other.example.test", replacement, true);
  post.resolve(new Response(null, { status: 200 }));

  expect(await oldLogout).toBe(false);
  expect(h.counts().reads).toBe(0);
  expect(h.session.read()).toMatchObject({
    origin: "https://other.example.test",
    actor: replacement,
    loading: true,
    logoutBusy: false,
    logoutError: null,
  });
});

test("push cleanup and OIDC suppression failures do not prevent logout observation", async () => {
  const order: string[] = [];
  const h = controller({
    suppressOidc() {
      order.push("suppress");
      throw new Error("storage unavailable");
    },
    async clearPush() {
      order.push("push");
      throw new Error("push cleanup failed");
    },
    async postLogout() {
      order.push("post");
      throw new Error("ACK lost");
    },
    async readCurrentActor() {
      order.push("observe");
      return null;
    },
  });

  expect(await h.session.logout()).toBe(true);
  expect(order).toEqual(["suppress", "push", "post", "observe"]);
});

test("controller instances have isolated state and disposal removes observers", async () => {
  const first = controller();
  const second = controller({}, actor(`${ORIGIN}/ap/users/bob`));
  let notifications = 0;
  const unsubscribe = first.session.subscribe(() => {
    notifications += 1;
  });
  expect(await first.session.logout()).toBe(true);
  expect(first.session.read().actor).toBeNull();
  expect(second.session.read().actor?.ap_id).toBe(`${ORIGIN}/ap/users/bob`);

  unsubscribe();
  first.session.dispose();
  const before = notifications;
  first.session.configure(ORIGIN, actor());
  expect(notifications).toBe(before);
  expect(await first.session.logout()).toBe(false);
});

test("ordinary refresh retains the failed logout and same-principal provider identity", async () => {
  const firstActor = actor();
  const refresh = deferred<Actor | null>();
  let reads = 0;
  const h = controller({
    async postLogout() {
      return new Response(null, { status: 503 });
    },
    async readCurrentActor() {
      reads += 1;
      return reads === 1 ? firstActor : refresh.promise;
    },
  });
  expect(await h.session.logout()).toBe(false);
  const refreshing = h.session.refresh();
  expect(h.session.read().actor).toBe(firstActor);
  expect(h.session.read().logoutError).toBe(LOGOUT_ERROR);
  refresh.resolve({ ...firstActor, name: "Refreshed profile" });
  await refreshing;
  expect(h.session.read().actor?.ap_id).toBe(firstActor.ap_id);
  expect(h.session.read().actor?.name).toBe("Refreshed profile");
  expect(h.session.read().logoutError).toBe(LOGOUT_ERROR);
});

test("ordinary refresh hides a changed principal until explicit recheck", async () => {
  const other = actor(`${ORIGIN}/ap/users/bob`);
  const h = controller({ readCurrentActor: async () => other });
  await h.session.refresh();
  expect(h.session.read()).toMatchObject({
    actor: null,
    error: OBSERVATION_ERROR,
    navigationAllowed: false,
  });
  await h.session.refresh();
  expect(h.session.read()).toMatchObject({
    actor: other,
    error: null,
    navigationAllowed: false,
  });
});

test("a fresh server is not anonymous before the authentication read finishes", async () => {
  const pending = deferred<Actor | null>();
  const h = controller({ readCurrentActor: () => pending.promise });
  h.session.configure("https://new.example.test", null, true);
  expect(h.session.read().navigationAllowed).toBe(false);
  const refreshing = h.session.refresh();
  expect(h.session.read().loading).toBe(true);
  pending.resolve(null);
  await refreshing;
  expect(h.session.read().navigationAllowed).toBe(true);
});

test("a stuck best-effort push cleanup cannot block the one logout attempt", async () => {
  const cleanup = deferred<void>();
  let signal: AbortSignal | undefined;
  const h = controller({
    clearPush: (value) => {
      signal = value;
      return cleanup.promise;
    },
  });
  try {
    expect(await h.session.logout()).toBe(true);
    expect(h.counts()).toEqual({
      reads: 1,
      posts: 1,
      suppressions: 1,
      pushClears: 1,
    });
    expect(h.session.read().logoutBusy).toBe(false);
    expect(signal?.aborted).toBe(true);
  } finally {
    cleanup.resolve();
  }
}, 10_000);
