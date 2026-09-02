import {
  resolveRuntimeLane,
  wrapRuntimeBindings,
  type DeliveryDlqMessageV1,
  type DeliveryQueueMessageV1,
  type EdgeKvBinding,
  type EdgeObjectsBinding,
  type EdgeQueueBinding,
  type EdgeSqlBinding,
  type Env,
  type EnvVars,
  type RuntimeLane,
} from "@takosjp/yurucommu-core/server";
import type {
  D1Database,
  Fetcher,
  KVNamespace,
  Queue,
  R2Bucket,
} from "@cloudflare/workers-types";

/**
 * The one composition every Yurumeet Worker deployment runs through.
 *
 * The same bundle serves two binding shapes and `YURUCOMMU_RUNTIME_LANE` is
 * what tells them apart:
 *
 *   unset / "cloudflare"  raw Cloudflare bindings — `DB` a `D1Database`, `KV` a
 *                         KV namespace, `MEDIA` an `R2Bucket`, the queues
 *                         Cloudflare `Queue`s. This is a `wrangler deploy`, and
 *                         equally the production Takoserver backend, which is
 *                         ordinary Workers and projects those same raw bindings.
 *   "portable"            the facades a wrapper host projects — `edge.sql`,
 *                         `edge.kv`, `edge.objects`, `edge.queue`. A
 *                         self-hosted or managed Takoserver sets it.
 *
 * The variable is spelled `YURUCOMMU_` rather than `YURUMEET_` because the
 * engine owns it: `wrapRuntimeBindings` reads `RUNTIME_LANE_VAR` off the
 * bindings itself, so a product-local spelling would be a name no core release
 * ever reads. Yurumeet declares the lane, the engine resolves it.
 *
 * The lane is DECLARED rather than sniffed because two of the bindings cannot
 * be told apart by shape: `edge.kv` and `KVNamespace` expose the same five
 * methods, and both queue producers are `send`/`sendBatch`. The core cross-
 * checks the declaration against the bindings that ARE decisive (`DB` always,
 * `MEDIA` when bound) and refuses to start on a disagreement — including on the
 * retired `takoform-v1` value, which is simply not a lane this build knows.
 */

type YurumeetPlainVars = Omit<EnvVars, "APP_URL"> & {
  readonly APP_URL?: string;
};

/** What arrives on the `cloudflare` lane. */
export type YurumeetCloudflareBindings = YurumeetPlainVars & {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly MEDIA?: R2Bucket;
  readonly ASSETS?: Fetcher;
  readonly DELIVERY_QUEUE?: Queue<DeliveryQueueMessageV1>;
  readonly DELIVERY_DLQ?: Queue<DeliveryDlqMessageV1>;
};

/** What arrives on the `portable` lane. */
export type YurumeetPortableBindings = YurumeetPlainVars & {
  readonly DB: EdgeSqlBinding;
  readonly KV: EdgeKvBinding;
  readonly MEDIA?: EdgeObjectsBinding;
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
  readonly DELIVERY_QUEUE?: EdgeQueueBinding;
  readonly DELIVERY_DLQ?: EdgeQueueBinding;
};

export type YurumeetWorkerBindings =
  YurumeetCloudflareBindings | YurumeetPortableBindings;

export type YurumeetRuntimeEnv = Omit<Env, "APP_URL"> & {
  readonly APP_URL?: string;
};

/**
 * Read the declared lane off the deployment's plain variables.
 *
 * The queue handler needs it separately from the bindings, because the batch it
 * is handed is the other half of the lane's shape and has to be adapted with
 * the same answer the bindings were.
 */
export function resolveYurumeetRuntimeLane(
  bindings: Pick<YurumeetPlainVars, "YURUCOMMU_RUNTIME_LANE">,
): RuntimeLane {
  return resolveRuntimeLane(bindings.YURUCOMMU_RUNTIME_LANE);
}

/**
 * Project either binding shape onto the runtime ports the app speaks.
 *
 * `MEDIA` is an ordinary bucket binding on both lanes: a Host materializes it
 * as R2 on the cloudflare lane and as the `edge.objects` facade on the portable
 * one. Nothing here accepts an endpoint, region, bucket name, or credential.
 */
export function wrapYurumeetWorkerBindings(
  bindings: YurumeetWorkerBindings,
): YurumeetRuntimeEnv {
  return wrapRuntimeBindings(bindings) as unknown as YurumeetRuntimeEnv;
}
