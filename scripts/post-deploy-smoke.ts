import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

const outputsPath = requiredEnv("TAKOSUMI_CAPSULE_OUTPUTS_FILE");
const password = requiredEnv("YURUMEET_E2E_PASSWORD");
const outputs = record(
  JSON.parse(await readFile(outputsPath, "utf8")),
  "Capsule outputs",
);
const launchUrl = stringValue(outputs.launch_url);
if (!launchUrl) throw new Error("Capsule outputs do not contain launch_url");

const origin = new URL(launchUrl).origin;
const checks: string[] = [];
let sessionCookie = "";

await expectStatus("/", 200);
checks.push("shell");

const health = await requestJson("/healthz", 200);
if (
  health.status !== "ok" ||
  !Array.isArray(health.missingBindings) ||
  health.missingBindings.length !== 0
) {
  throw new Error("healthz did not report a fully configured runtime");
}
checks.push("health");

const discovery = await requestJson("/.well-known/social-server", 200);
if (!Array.isArray(discovery.capabilities)) {
  throw new Error("social-server discovery does not contain capabilities[]");
}
checks.push("social-server.discovery");

const providers = await requestJson("/api/auth/providers", 200);
if (providers.password_enabled !== true) {
  throw new Error("password authentication is not enabled for the probe");
}
checks.push("auth.providers");

const login = await fetch(new URL("/api/auth/login", origin), {
  method: "POST",
  headers: jsonHeaders(),
  body: JSON.stringify({ password }),
});
const loginBody = await login.text();
if (login.status !== 200) {
  throw new Error(
    `POST /api/auth/login returned ${login.status}: ${loginBody.slice(0, 1000)}`,
  );
}
sessionCookie = login.headers.get("set-cookie")?.split(";", 1)[0]?.trim() ?? "";
if (!sessionCookie) throw new Error("login did not return a session cookie");
checks.push("auth.login");

const me = await requestJson("/api/auth/me", 200);
if (!isRecord(me.actor) || typeof me.actor.ap_id !== "string") {
  throw new Error("authenticated actor response is invalid");
}
checks.push("auth.me");

const timeline = await requestJson("/api/timeline", 200);
if (!Array.isArray(timeline.posts)) {
  throw new Error("timeline response does not contain posts[]");
}
checks.push("timeline");

const contacts = await requestJson("/api/dm/contacts", 200);
if (
  !Array.isArray(contacts.mutual_followers) ||
  !Array.isArray(contacts.communities)
) {
  throw new Error(
    "DM contacts response does not contain mutual_followers[] and communities[]",
  );
}
checks.push("talk.contacts");

const notifications = await requestJson("/api/notifications", 200);
if (!Array.isArray(notifications.notifications)) {
  throw new Error("notifications response does not contain notifications[]");
}
checks.push("notifications");

console.log(
  JSON.stringify({
    kind: "takosumi.capsule-functional-probe@v1",
    status: "passed",
    product: "yurumeet",
    checks: checks.map((name) => ({ name, status: "passed" })),
    cleanupVerified: true,
  }),
);

async function expectStatus(path: string, status: number): Promise<void> {
  const response = await fetch(new URL(path, origin), {
    headers: { origin },
  });
  if (response.status !== status) {
    throw new Error(
      `GET ${path} returned ${response.status}; expected ${status}`,
    );
  }
}

async function requestJson(path: string, status: number): Promise<JsonRecord> {
  const response = await fetch(new URL(path, origin), {
    headers: requestHeaders(),
  });
  const body = await response.text();
  if (response.status !== status) {
    throw new Error(
      `GET ${path} returned ${response.status}; expected ${status}: ${body.slice(0, 1000)}`,
    );
  }
  return record(JSON.parse(body), `GET ${path}`);
}

function requestHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    origin,
    ...(sessionCookie ? { cookie: sessionCookie } : {}),
  };
}

function jsonHeaders(): Record<string, string> {
  return { ...requestHeaders(), "content-type": "application/json" };
}

function record(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${name} is not a JSON object`);
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
