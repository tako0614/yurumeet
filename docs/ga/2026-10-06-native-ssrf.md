# Native Follow SSRF refusal — 2026-10-06

This separate two-peer gate drives Yurumeet's authenticated `POST /api/follow`
path through its freshly built `dist/takos-worker.js`. The existing Worker,
federation and foreign-wire-ID gates use the same artifact. Published Core/API
4.1.11 stays pinned; no network helper or engine code is replaced.

A and B have separate disposable native D1, KV, R2, delivery queues and DLQs.
Their owner and session are created through the application API. One owner per
fixture is a test setup condition and does not define Yurumeet account policy.
Actual discovery identifies Yurumeet, its server/client identity and canonical
origin while retaining the shared family protocol token. Exact virtual HTTPS
and DoH routes refuse and count unknown egress with no public fallback. Strict
raw Wrangler bindings, migrations, queue variables and normalized runtime
compatibility must match this product before its Worker runs.

The fixture warms `/ap/actor` before database baselines to exclude legitimate
lazy instance-actor creation. It then tests these uncached Follow targets:

- Loopback IPv4, IPv6 and URL-normalized hexadecimal IPv4 return 400
  `Invalid target_ap_id`, with zero DoH or private-target fetches.
- A public-shaped hostname with a public A answer and an IPv4-mapped private
  AAAA answer returns 400 `Failed to fetch remote actor`. Both answers are
  witnessed; actor GET and private-target fetch counts remain zero.
- Another public-shaped hostname resolves publicly and its actual actor GET
  returns 302 with a private `Location`. Follow returns the same fetch failure;
  the public actor GET count is one and private-target fetch count is zero.

Every refusal compares native follows, outbound activities, delivery jobs,
actor cache and remote objects while preserving original owner/session state.
The manifest binds responses to route counters and unchanged data projections.
Unique hostnames avoid cache ambiguity, with immediately empty CNAME replies.

The positive control follows B's actual private actor. Follow returns 200 with
success/pending, fetches B's real actor and creates A's cache, Follow edge,
outbound activity and actual Queue job. Native delivery reaches B's actual
inbox with 202, retaining processed activity, released claim, inbox projection
and pending edge. Sender-key DNS evidence waits until actual delivery and all
A/AAAA/CNAME route records exist, then verifies their exact values. Original
owner/session projections stay stable on both fixtures.

`--deny-positive-actor-fetch` first runs the refusal cases, then returns 502
from the exact B actor GET. Follow must fail and the fixture deliberately emits
FAILED stderr, nonzero exit and no passing stdout. This prevents indiscriminate
rejection from satisfying the gate. Passing output requires all assertions,
native disposal and disposable-state cleanup. Manifests contain safe IDs,
hashes, counters and booleans, without keys, cookies, bodies or signatures.

Yurumeet must qualify its own source and artifact. This finite local native
workerd/Queue fixture with virtual transport does not prove another product,
all SSRF or Activity types, DNS rebinding/IP pinning, public DNS/TLS, live
federation, real issuer, operator-data update/restore or family GA. Core's
known low-TTL DNS-rebinding window remains. No schema, dependency pin, account
policy, runtime binding or deployed state changes.
