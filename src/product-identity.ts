/**
 * Structural mirror of the engine's `YurucommuBackendDiscoveryOptionsV1`, with
 * every field required. Declared here rather than imported because importing
 * the core type pulls the Worker-typed backend module graph (D1Database,
 * R2Bucket, Queue…) into this SPA's `tsc` program, which has DOM libs only. The
 * generated Worker entry hands this exact object to `createYurucommuBackend`,
 * so the authoritative check still happens where the engine is compiled — this
 * local shape only keeps a field from being dropped silently here.
 */
interface ProductWireIdentity {
  readonly product: string;
  readonly name: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly clients: readonly {
    readonly id: string;
    readonly name: string;
    readonly defaultEntry: string;
  }[];
  readonly capabilities: readonly string[];
}

/**
 * Single source of truth for every wire-visible identity token this product
 * publishes at `/.well-known/yurucommu` (and its `/.well-known/social-server`
 * alias).
 *
 * WHY this file exists: the token used to be a literal inside
 * `scripts/build-takos-worker.ts` and a *different* literal inside
 * `scripts/dev-mock-server.ts`. The mock agreed with the mobile shells and the
 * real Worker did not, so every mobile connection to a deployed Yurumeet failed
 * (`Host is yurumeet, not yurucommu.`) while local development looked healthy.
 * A wire value that exists in two places is a value that will disagree; the
 * contract test next to this file fails if any producer re-declares one.
 *
 * WHY `product` is `"yurucommu"` and not `"yurumeet"`: `product` names the
 * *family engine* a client is talking to — @takosjp/yurucommu-core, whose
 * discovery document lives at `/.well-known/yurucommu` and whose own default is
 * `"yurucommu"`. The per-app identity is carried by `clients[].id` (`yurume`
 * here), by `serverId`/`name`, and by the Takosumi catalog key `yurumeet` in
 * `main.tf` — three separate namespaces that must not be collapsed into this
 * one. Yurumeet serves both the talk client and the feed client off the same
 * engine, so a client that requires the yurucommu family is correct to connect.
 */
export const PRODUCT_WIRE_IDENTITY = {
  product: "yurucommu",
  name: "Yurumeet",
  serverId: "yurumeet-server",
  serverName: "Yurumeet Server",
  clients: [
    { id: "yurume", name: "Yurumeet", defaultEntry: "messages" },
    { id: "yurucommu", name: "Yurucommu", defaultEntry: "feed" },
  ],
  capabilities: [
    "api.social.v1",
    "activitypub.server.v1",
    "client.yurume.messages.v1",
    "client.yurucommu.feed.v1",
    "notification.pushers.v1",
  ],
} satisfies ProductWireIdentity;

/** The client key this SPA and the Yurumeet mobile shell identify as. */
export const PRODUCT_CLIENT_KEY = "yurume";

/** Takosumi catalog / Capsule key. Deliberately distinct from `product`. */
export const PRODUCT_CATALOG_KEY = "yurumeet";
