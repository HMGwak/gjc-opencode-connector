import { describe, expect, test } from "bun:test";
import { openCoreDatabase, type AgentAdapter } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";
import { createHubServer, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_SNAPSHOT_MAX_ROWS, DEFAULT_SNAPSHOT_TTL_MS, type PushSubscriptionService } from "./server";
import { ActionApiError, HubPendingActionService, type ArtifactService } from "./actions";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const randomSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
const prepareArchiveCandidate = (database: ReturnType<typeof openCoreDatabase>, id: string, epoch: number) => {
  database.setReconciliation(id, "terminal", epoch, true, `revision-${epoch}`);
  database.sqlite.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", id);
};

async function fixture(adapters?: Readonly<Record<string, AgentAdapter>>, setup?: (database: ReturnType<typeof openCoreDatabase>) => void) {
  const now = 1_700_000_000_000;
  const database = openCoreDatabase(); database.createSession({ id: "s1", ownerId: "u1", adapter: "test", remoteId: "r1" }); database.setReconciliation("s1", "active", 1, true, "revision-1"); setup?.(database);
  database.projectSessionHierarchy("u1", 0, [{ ownerId: "u1", generation: 0, sessionId: "s1", kind: "root", rootSessionId: "s1", parentSessionId: null, unknownReason: null, lineageKind: "direct", internalKind: null, subagentIdentity: null }]);
  const auth = new DeviceCredentialVerifier({ database, ownerId: "u1", pairingSecret: randomSecret(), now: () => now });
  const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", commandId: () => "c1", adapters, authorizeSession: (_sessionId, ownerId) => ownerId === "u1" });
  const pairing = await auth.createPairing({ expiresInMs: 60_000 });
  const registration = await auth.redeemPairing({ code: pairing.code, deviceName: "Test device" });
  return { database, auth, server, now, token: registration.credential };
}
const request = (path: string, token?: string, init: RequestInit = {}) => new Request(`http://loopback${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });

describe("hub origin API", () => {
  test("health requires a credential and defaults are loopback", async () => {
    const { server, database, token } = await fixture();
    expect(DEFAULT_HOST).toBe("127.0.0.1"); expect(DEFAULT_PORT).toBe(8787);
    expect((await server.fetch(request("/api/v1/health"))).status).toBe(401);
    expect(await (await server.fetch(request("/api/v1/health", token))).json()).toEqual({ ok: true, readiness: { ok: true, database: "ready", adapters: {}, recovery: "ready" } }); database.close();
  });
  test("lists only human roots and exposes paginated internal summaries", async () => {
    const { database, server, token } = await fixture(undefined, (db) => {
      db.createSession({ id: "internal", ownerId: "u1", adapter: "test", remoteId: "internal" });
    });
    database.sqlite.query("INSERT INTO session_hierarchy_projection VALUES ('u1', 0, 'internal', 'internal', 's1', 's1', NULL, 'subagent', 'subagent', NULL)").run();
    expect((await (await server.fetch(request("/api/v1/sessions", token))).json() as { sessions: Array<{ id: string; internalCount: number }> }).sessions).toEqual([expect.objectContaining({ id: "s1", internalCount: 1 })]);
    expect(await (await server.fetch(request("/api/v1/sessions/s1/internal?limit=1", token))).json()).toEqual({ internal: [expect.objectContaining({ id: "internal", rootSessionId: "s1" })], nextCursor: null });
    expect((await server.fetch(request("/api/v1/sessions/internal/internal", token))).status).toBe(404);
    expect((await server.fetch(request("/api/v1/sessions/s1/internal?cursor=9007199254740991", token))).status).toBe(400);
    database.close();
  });
  test("renders continuation roots with origin identity and head lifecycle state", async () => {
    const { database, server, token } = await fixture(undefined, (db) => {
      db.sqlite.query("UPDATE sessions SET title = ? WHERE id = ?").run("Original conversation", "s1");
      db.createSession({ id: "s1-head", ownerId: "u1", adapter: "test", remoteId: "r1-head", continuationParentId: "s1" });
      db.setReconciliation("s1-head", "terminal", 1, true, "head-revision");
    });

    const body = await (await server.fetch(request("/api/v1/sessions", token))).json() as {
      sessions: Array<{ id: string; title: string | null; status: string; reconciliationEpoch: number }>;
    };
    expect(body.sessions).toEqual([
      expect.objectContaining({
        id: "s1",
        title: "Original conversation",
        status: "terminal",
        reconciliationEpoch: 1,
      }),
    ]);
    database.close();
  });

  test("exchanges one valid pairing code for a device credential", async () => {
    const { server, database, auth } = await fixture();
    const pairing = await auth.createPairing({ expiresInMs: 60_000 });
    const first = await server.fetch(request("/api/v1/pairings/redeem", undefined, { method: "POST", body: JSON.stringify({ code: pairing.code, deviceName: "Personal phone" }) }));
    expect(first.status).toBe(201);
    const registration = await first.json() as { credential: string };
    expect((await server.fetch(request("/api/v1/sessions", registration.credential))).status).toBe(200);
    expect((await server.fetch(request("/api/v1/pairings/redeem", undefined, { method: "POST", body: JSON.stringify({ code: pairing.code, deviceName: "Personal phone" }) }))).status).toBe(401);
    database.close();
  });

  test("waits for startup recovery before processing mutations", async () => {
    let releaseRecovery!: () => void;
    const recoveryBlocked = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    let prompts = 0;
    const adapter: AgentAdapter = { name: "test", reconciliationCapabilities: { stableRemoteId: true, revision: true, terminalState: true, tombstone: true, watermark: true, fencing: true }, reconcile: async () => null, prompt: async () => { prompts++; await recoveryBlocked; } };
    const { server, database, token } = await fixture({ test: adapter }, (db) => {
      db.acceptCommandWithEvent({ id: "recover", sessionId: "s1", idempotencyKey: "recover", payload: { prompt: "recover" }, eventType: "session.prompt.accepted", eventPayload: {} });
    });
    const mutation = server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "raced" }, body: JSON.stringify({ prompt: "raced" }) }));
    await tick();
    expect(prompts).toBe(1);
    expect(database.getCommand("c1")).toBeNull();
    releaseRecovery();
    expect((await mutation).status).toBe(202);
    expect(prompts).toBe(2);
    database.close();
  });

  test("contains startup recovery rejection and remains fail-closed", async () => {
    const { database, auth, token } = await fixture();
    (database as unknown as { listCommandsForRecovery(): never }).listCommandsForRecovery = () => { throw new Error("recovery failed"); };
    const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", authorizeSession: () => true });
    await tick();
    expect(await (await server.fetch(request("/api/v1/health", token))).json()).toEqual({ ok: false, readiness: { ok: false, database: "ready", adapters: {}, recovery: "failed" } });
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "blocked" }, body: JSON.stringify({ prompt: "blocked" }) }))).status).toBe(503);
    expect(database.getCommand("c1")).toBeNull();
    database.close();
  });
  test("rejects missing and invalid credentials but accepts a valid loopback request", async () => {
    const { server, database, token } = await fixture();
    expect((await server.fetch(request("/api/v1/sessions"))).status).toBe(401);
    expect((await server.fetch(request("/api/v1/sessions", "nope"))).status).toBe(401);
    expect((await server.fetch(request("/api/v1/sessions", token))).status).toBe(200); database.close();
  });

  test("rejects credentials that have been revoked", async () => {
    const { server, database, auth, token } = await fixture();
    const claims = await auth.verify(token);
    expect(auth.revokeDevice(claims.deviceId)).toBe(true);
    expect((await server.fetch(request("/api/v1/sessions", token))).status).toBe(401); database.close();
  });

  test("rejects mutation with a foreign origin", async () => {
    const { server, database, token } = await fixture();
    const response = await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://evil.example", "idempotency-key": "one" }, body: JSON.stringify({ prompt: "hi" }) }));
    expect(response.status).toBe(403); database.close();
  });
  test("invokes authorization after owner matching before session side effects", async () => {
    let prompts = 0;
    const adapter: AgentAdapter = { name: "test", reconciliationCapabilities: { stableRemoteId: true, revision: true, terminalState: true, tombstone: true, watermark: true, fencing: true }, reconcile: async () => null, prompt: async () => { prompts++; } };
    const { database, auth, token } = await fixture({ test: adapter });
    const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", adapters: { test: adapter }, authorizeSession: () => false });
    expect((await server.fetch(request("/api/v1/sessions", token))).status).toBe(200);
    expect((await server.fetch(request("/api/v1/sessions/s1/events", token))).status).toBe(403);
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "denied" }, body: JSON.stringify({ prompt: "blocked" }) }))).status).toBe(403);
    expect(prompts).toBe(0);
    expect(database.getCommand("c1")).toBeNull();
    database.close();
  });

  test("returns the prior command for an idempotency duplicate", async () => {
    const { server, database, token } = await fixture();
    const init = { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "same" }, body: JSON.stringify({ prompt: "hi" }) };
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", token, init))).status).toBe(202);
    const duplicate = await server.fetch(request("/api/v1/sessions/s1/prompt", token, init));
    expect(duplicate.status).toBe(200); expect((await duplicate.json() as { duplicate: boolean }).duplicate).toBe(true); database.close();
  });
  test("rejects prompts for unreconciled active and unknown persisted sessions", async () => {
    const { server, database, token } = await fixture();
    database.setReconciliation("s1", "active", 2, false, "revision-2");
    const active = await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "unreconciled-active" }, body: JSON.stringify({ prompt: "hi" }) }));
    expect(active.status).toBe(409);
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM commands").get()).toEqual({ count: 0 });
    database.setReconciliation("s1", "unknown", 3, false, null);
    const unknown = await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "unreconciled-unknown" }, body: JSON.stringify({ prompt: "hi" }) }));
    expect(unknown.status).toBe(409);
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM commands").get()).toEqual({ count: 0 });
    database.close();
  });
  test("rejects terminal prompts before persistence, events, or remote dispatch", async () => {
    let prompts = 0;
    const adapter: AgentAdapter = { name: "test", reconciliationCapabilities: { stableRemoteId: true, revision: true, terminalState: true, tombstone: true, watermark: true, fencing: true }, reconcile: async () => null, prompt: async () => { prompts++; } };
    const { server, database, token } = await fixture({ test: adapter });
    database.setReconciliation("s1", "terminal", 2, true, "revision-2");
    const response = await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "terminal" }, body: JSON.stringify({ prompt: "hi" }) }));
    expect(response.status).toBe(409);
    expect(prompts).toBe(0);
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM commands").get()).toEqual({ count: 0 });
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
    database.close();
  });
  test("dispatches a successful idempotent prompt remotely exactly once", async () => {
    let prompts = 0;
    const adapter: AgentAdapter = { name: "test", reconciliationCapabilities: { stableRemoteId: true, revision: true, terminalState: true, tombstone: true, watermark: true, fencing: true }, reconcile: async () => null, prompt: async (remoteId, prompt) => { prompts++; expect(remoteId).toBe("r1"); expect(prompt).toBe("hi"); } };
    const { server, database, token } = await fixture({ test: adapter });
    const init = { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "remote-once" }, body: JSON.stringify({ prompt: "hi" }) };
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", token, init))).status).toBe(202);
    const duplicate = await server.fetch(request("/api/v1/sessions/s1/prompt", token, init));
    expect(duplicate.status).toBe(200);
    expect(prompts).toBe(1);
    expect(database.getCommand("c1")?.state).toBe("remote-confirmed");
    expect(database.sqlite.query("SELECT type FROM events WHERE session_id = ? ORDER BY seq").all("s1")).toEqual([
      { type: "session.prompt.accepted" },
      { type: "session.prompt.remote-confirmed" },
    ]);
    database.close();
  });

  test("does not retry an ambiguous prompt failure on an idempotency duplicate", async () => {
    let prompts = 0;
    const adapter: AgentAdapter = { name: "test", reconciliationCapabilities: { stableRemoteId: true, revision: true, terminalState: true, tombstone: true, watermark: true, fencing: true }, reconcile: async () => null, prompt: async () => { prompts++; throw new Error("connection lost"); } };
    const { server, database, token } = await fixture({ test: adapter });
    const init = { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "ambiguous-once" }, body: JSON.stringify({ prompt: "hi" }) };
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", token, init))).status).toBe(202);
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", token, init))).status).toBe(200);
    expect(prompts).toBe(1);
    expect(database.getCommand("c1")?.state).toBe("unknown");
    expect(database.sqlite.query("SELECT type FROM events WHERE session_id = ? ORDER BY seq").all("s1")).toEqual([
      { type: "session.prompt.accepted" },
      { type: "session.prompt.unknown" },
    ]);
    database.close();
  });

  test("enforces body limit", async () => {
    const { server, database, token } = await fixture();
    const response = await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "big" }, body: JSON.stringify({ prompt: "x".repeat(70_000) }) }));
    expect(response.status).toBe(413); database.close();
  });
  test("protects owner-scoped push subscription mutations and never caches push API responses", async () => {
    const { database, auth, token } = await fixture();
    const calls: Array<{ ownerId: string; endpoint: string; key: string }> = [];
    const push: PushSubscriptionService = {
      publicKey: () => "BElong_public-key",
      subscribe: ({ ownerId, subscription, idempotencyKey }) => {
        calls.push({ ownerId, endpoint: subscription.endpoint, key: idempotencyKey });
        return { duplicate: idempotencyKey === "again" };
      },
      unsubscribe: ({ ownerId, endpoint, idempotencyKey }) => {
        calls.push({ ownerId, endpoint, key: idempotencyKey });
        return { duplicate: false };
      },
    };
    const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", push, authorizeSession: (_sessionId, ownerId) => ownerId === "u1" });
    expect((await server.fetch(request("/api/v1/push/public-key"))).status).toBe(401);
    const key = await server.fetch(request("/api/v1/push/public-key", token));
    expect(await key.json()).toEqual({ publicKey: "BElong_public-key" });
    expect(key.headers.get("cache-control")).toBe("no-store");
    const subscription = { endpoint: "https://push.example/subscription", keys: { p256dh: "key_value", auth: "auth_value" } };
    expect((await server.fetch(request("/api/v1/push/subscriptions", token, { method: "POST", headers: { "idempotency-key": "one" }, body: JSON.stringify({ subscription }) }))).status).toBe(403);
    expect((await server.fetch(request("/api/v1/push/subscriptions", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "one" }, body: JSON.stringify({ subscription: { ...subscription, endpoint: "http://unsafe.example" } }) }))).status).toBe(400);
    const invalidSubscription = { ...subscription, keys: { ...subscription.keys, auth: "not valid" } };
    expect((await server.fetch(request("/api/v1/push/subscriptions", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "one" }, body: JSON.stringify({ subscription: invalidSubscription }) }))).status).toBe(400);
    expect((await server.fetch(request("/api/v1/push/subscriptions", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "one" }, body: JSON.stringify({ subscription }) }))).status).toBe(202);
    expect((await server.fetch(request("/api/v1/push/subscriptions", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "again" }, body: JSON.stringify({ subscription }) }))).status).toBe(200);
    expect((await server.fetch(request("/api/v1/push/subscriptions", token, { method: "DELETE", headers: { origin: "https://hub.example", "idempotency-key": "delete" }, body: JSON.stringify({ endpoint: subscription.endpoint }) }))).status).toBe(202);
    expect(calls).toEqual([
      { ownerId: "u1", endpoint: subscription.endpoint, key: "one" },
      { ownerId: "u1", endpoint: subscription.endpoint, key: "again" },
      { ownerId: "u1", endpoint: subscription.endpoint, key: "delete" },
    ]);
    database.close();
  });
  test("uses the durable core pending-action adapter atomically", async () => {
    const { database, auth, token } = await fixture();
    const actions = new HubPendingActionService(database);
    const core = new (await import("@planee/core")).PendingActionService(database);
    database.createPendingAction({ id: "action-1", ownerId: "u1", sessionId: "s1", expiresAt: "2030-01-01T00:00:00.000Z", payload: { ownerId: "u1", sessionId: "s1", type: "approve", payload: { allowedResponses: ["approve", "reject"] }, artifactIds: [] } });
    const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", actions });
    const invalid = await server.fetch(request("/api/v1/actions/action-1/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "answer-invalid" }, body: JSON.stringify({ version: 1, response: true }) }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "action_invalid", message: "Invalid action request" } });
    expect(database.getPendingAction("action-1")).toMatchObject({ state: "pending", version: 1, answer: null });
    const arbitrary = await server.fetch(request("/api/v1/actions/action-1/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "answer-arbitrary" }, body: JSON.stringify({ version: 1, response: "arbitrary" }) }));
    expect(arbitrary.status).toBe(400);
    expect(database.getPendingAction("action-1")).toMatchObject({ state: "pending", version: 1, answer: null });
    const response = await server.fetch(request("/api/v1/actions/action-1/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "answer-1" }, body: JSON.stringify({ version: 1, response: "approve" }) }));
    expect(response.status).toBe(202);
    expect(database.getPendingAction("action-1")).toMatchObject({ state: "answered", version: 2, answer: "approve" });
    expect(database.sqlite.query("SELECT action, session_id FROM audit_log WHERE action = 'pending-action.answered'").all()).toEqual([{ action: "pending-action.answered", session_id: "s1" }]);
    expect(database.listEvents("s1")).toMatchObject([{ type: "action.responded", payload: { actionId: "action-1", version: 2, ownerId: "u1" } }]);
    const duplicateResponse = await server.fetch(request("/api/v1/actions/action-1/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "answer-1-retry" }, body: JSON.stringify({ version: 1, response: "approve" }) }));
    expect(duplicateResponse.status).toBe(200);
    expect(database.listEvents("s1").filter((event) => event.type === "action.responded")).toHaveLength(1);
    database.createPendingAction({ id: "action-no-responses", ownerId: "u1", sessionId: "s1", expiresAt: "2030-01-01T00:00:00.000Z", payload: { ownerId: "u1", sessionId: "s1", type: "approve", payload: {}, artifactIds: [] } });
    const nonAnswerable = await server.fetch(request("/api/v1/actions/action-no-responses/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "answer-none" }, body: JSON.stringify({ version: 1, response: "approve" }) }));
    expect(nonAnswerable.status).toBe(400);
    expect(database.getPendingAction("action-no-responses")).toMatchObject({ state: "pending", version: 1, answer: null });

    database.createPendingAction({ id: "action-2", ownerId: "u1", sessionId: "s1", expiresAt: "2030-01-01T00:00:00.000Z", payload: { ownerId: "u1", sessionId: "s1", type: "approve", payload: { allowedResponses: ["approve"] }, artifactIds: [] } });
    database.setReconciliation("s1", "terminal", 2, true, "revision-2");
    const failed = await server.fetch(request("/api/v1/actions/action-2/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "answer-2" }, body: JSON.stringify({ version: 1, response: "approve" }) }));
    expect(failed.status).toBe(500);
    expect(database.getPendingAction("action-2")).toMatchObject({ state: "pending", version: 1 });
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'pending-action.answered' AND payload_json LIKE '%action-2%'").get()).toEqual({ count: 0 });
    database.createSession({ id: "s2", ownerId: "u2", adapter: "test", remoteId: "r2" });
    database.createPendingAction({ id: "action-3", ownerId: "u2", sessionId: "s2", expiresAt: "2030-01-01T00:00:00.000Z", payload: { ownerId: "u2", sessionId: "s2", type: "approve", payload: {}, artifactIds: [] } });
    const foreignResponse = await server.fetch(request("/api/v1/actions/action-3/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "foreign" }, body: JSON.stringify({ version: 1, response: true }) }));
    expect(foreignResponse.status).toBe(403);
    expect(() => actions.respondWithEvent({ id: "action-3", ownerId: "u1", version: 1, response: true, idempotencyKey: "foreign-direct" })).toThrow(ActionApiError);
    expect(database.getPendingAction("action-3")).toMatchObject({ state: "pending", version: 1 });
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'pending-action.answered' AND payload_json LIKE '%action-3%'").get()).toEqual({ count: 0 });
    expect(database.listEvents("s1").filter((event) => event.type === "action.responded" && JSON.stringify(event.payload).includes("action-3"))).toHaveLength(0);
    database.close();
  });
  test("uses canonical actions, durable idempotency, and owner-scoped artifact reads", async () => {
    const { database, auth, token } = await fixture();
    let effects = 0;
    let raceMetadataCalls = 0;
    const keys = new Set<string>();
    let concurrentDuplicateResponders = 0;
    const action = { id: "act_opaque", ownerId: "u1", sessionId: "s1", version: 2, expiresAt: "2030-01-01T00:00:00.000Z", status: "answered" as const, type: "approve", payload: {}, allowedResponses: [], artifactIds: ["artifact_opaque"] };
    const listedActions = [action, ...["missing", "expired", "forbidden", "invalid"].map((id) => ({ ...action, id }))];
    const artifact = { id: "a", ownerId: "u1", name: "result.txt", contentType: "text/plain", size: 2, createdAt: "2025-01-01T00:00:00.000Z" };
    const respond = async ({ id, version, idempotencyKey }: { id: string; version: number; idempotencyKey: string }) => {
      if (id === "missing") throw new ActionApiError("unknown");
      if (id === "expired") throw new ActionApiError("expired");
      if (id === "forbidden") throw new ActionApiError("forbidden");
      if (id === "invalid") throw new ActionApiError("invalid");
      if (version !== 1) throw new ActionApiError("stale");
      if (idempotencyKey === "concurrent") { concurrentDuplicateResponders++; await tick(); }
      const duplicate = keys.has(idempotencyKey);
      if (!duplicate) { keys.add(idempotencyKey); effects++; }
      return { action, duplicate };
    };
    const actions = { list: (ownerId: string) => ownerId === "u1" ? listedActions : [], respond, respondWithEvent: respond };
    const artifacts: ArtifactService = {
      getMetadata: (id, ownerId) => {
        if (id === "../secret") throw new ActionApiError("traversal");
        if (id === "race") { raceMetadataCalls++; return { ...artifact, id }; }
        if (id === "other" || ownerId !== "u1") throw new ActionApiError("forbidden");
        return artifact;
      },
      getContent: (id, ownerId, range) => {
        if (id === "race" || ownerId !== "u1") throw new ActionApiError("forbidden");
        return { artifact, content: range ? "i" : "hi", range };
      },
    };
    const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", actions: actions as unknown as HubPendingActionService, artifacts, authorizeSession: (_sessionId, ownerId) => ownerId === "u1" });
    expect(await (await server.fetch(request("/api/v1/actions", token))).json()).toEqual({ actions: listedActions.map(({ ownerId, ...wire }) => wire) });
    expect((await server.fetch(request("/api/v1/sessions/s1/actions", token))).status).toBe(404);
    expect((await server.fetch(request("/api/v1/actions/act_opaque/response", token, { method: "POST", body: JSON.stringify({ version: 1, response: true }) }))).status).toBe(403);
    expect((await server.fetch(request("/api/v1/actions/act_opaque/response", token, { method: "POST", headers: { origin: "https://hub.example" }, body: JSON.stringify({ version: 1, response: true }) }))).status).toBe(400);
    const stale = await server.fetch(request("/api/v1/actions/act_opaque/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "stale" }, body: JSON.stringify({ version: 0, response: true }) }));
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: { code: "action_stale", message: "Stale action version" } });
    const missing = await server.fetch(request("/api/v1/actions/missing/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "missing" }, body: JSON.stringify({ version: 1, response: true }) }));
    expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: { code: "action_unknown", message: "Action not found" } });
    const expired = await server.fetch(request("/api/v1/actions/expired/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "expired" }, body: JSON.stringify({ version: 1, response: true }) }));
    expect(expired.status).toBe(409); expect(await expired.json()).toEqual({ error: { code: "action_expired", message: "Action expired" } });
    const forbidden = await server.fetch(request("/api/v1/actions/forbidden/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "forbidden" }, body: JSON.stringify({ version: 1, response: true }) }));
    expect(forbidden.status).toBe(403); expect(await forbidden.json()).toEqual({ error: { code: "action_forbidden", message: "Forbidden" } });
    const invalid = await server.fetch(request("/api/v1/actions/invalid/response", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "invalid" }, body: JSON.stringify({ version: 1, response: true }) }));
    expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: { code: "action_invalid", message: "Invalid action request" } });
    const responseInit = { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "concurrent" }, body: JSON.stringify({ version: 1, response: true }) };
    const duplicateResponses = await Promise.all([
      server.fetch(request("/api/v1/actions/act_opaque/response", token, responseInit)),
      server.fetch(request("/api/v1/actions/act_opaque/response", token, responseInit)),
    ]);
    expect(concurrentDuplicateResponders).toBe(2);
    expect(duplicateResponses.map(({ status }) => status).sort()).toEqual([200, 202]);
    expect(effects).toBe(1);
    expect((await server.fetch(request("/api/v1/artifacts/other", token))).status).toBe(403);
    expect((await server.fetch(request("/api/v1/artifacts/%2E%2E%2Fsecret", token))).status).toBe(400);
    expect((await server.fetch(request("/api/v1/artifacts/a/content", token, { headers: { range: "bytes=3-1" } }))).status).toBe(416);
    const content = await server.fetch(request("/api/v1/artifacts/a/content", token, { headers: { range: "bytes=0-0" } }));
    expect(content.status).toBe(206); expect(await content.text()).toBe("i");
    expect(content.headers.get("content-type")).toBe("text/plain");
    expect(content.headers.get("content-disposition")).toBe('attachment; filename="result.txt"');
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("cache-control")).toBe("private, no-store");
    expect(content.headers.get("accept-ranges")).toBe("bytes");
    expect(content.headers.get("content-range")).toBe("bytes 0-0/2");
    expect(content.headers.get("content-length")).toBe("1");
    expect((await server.fetch(request("/api/v1/artifacts/race/content", token))).status).toBe(403);
    expect(raceMetadataCalls).toBe(0);
    for (const malformed of [
      request("/api/v1/actions/%/response", token, { method: "POST" }),
      request("/api/v1/artifacts/%", token),
      request("/api/v1/sessions/%/events", token),
    ]) {
      const response = await server.fetch(malformed);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "bad_request", message: "Invalid request" } });
    }
    database.close();
  });
  test("enforces rate limits and rejects malformed Content-Length", async () => {
    const { database, auth, token } = await fixture();
    const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", rateLimit: { maxRequests: 1, windowMs: 60_000 }, authorizeSession: () => true });
    expect((await server.fetch(request("/api/v1/sessions", token))).status).toBe(200);
    expect((await server.fetch(request("/api/v1/sessions", token))).status).toBe(429);
    const fresh = createHubServer({ database, auth, publicOrigin: "https://hub.example", authorizeSession: () => true });
    const response = await fresh.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "bad-length", "content-length": "1e3" }, body: JSON.stringify({ prompt: "hi" }) }));
    expect(response.status).toBe(400); database.close();
  });
  test("returns a stable error for corrupt persisted SSE events", async () => {
    const { database, server, token } = await fixture();
    database.appendEvent("s1", "created", {});
    database.sqlite.query("UPDATE events SET payload_json = '{' WHERE session_id = ?").run("s1");
    const response = await server.fetch(request("/api/v1/sessions/s1/events", token));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "corrupt_data", message: "Session event data is corrupt" } });
    expect(database.getSession("s1")).toMatchObject({ status: "unknown", reconciled: false });
    database.close();
  });

  test("rejects authenticated users without session ownership", async () => {
    const { database, auth } = await fixture();
    const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", authorizeSession: (_sessionId, ownerId) => ownerId === "u1" });
    const foreignAuth = new DeviceCredentialVerifier({ database, ownerId: "u2", pairingSecret: randomSecret() });
    const pairing = await foreignAuth.createPairing({ expiresInMs: 60_000 });
    const other = (await foreignAuth.redeemPairing({ code: pairing.code, deviceName: "Foreign device" })).credential;
    expect((await server.fetch(request("/api/v1/sessions", other))).json()).resolves.toEqual({ sessions: [] });
    expect((await server.fetch(request("/api/v1/sessions/s1/events", other))).status).toBe(403);
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", other, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "foreign" }, body: JSON.stringify({ prompt: "hi" }) }))).status).toBe(403);
    database.close();
  });
  test("lists only actionable, owner-visible HITL actions", async () => {
    const { database, auth, token } = await fixture();
    const core = new (await import("@planee/core")).PendingActionService(database);
    const actions = new HubPendingActionService(database);
    const create = (id: string, sessionId: string, ownerId = "u1", payload: unknown = {}) => database.createPendingAction({
      id,
      ownerId,
      sessionId,
      expiresAt: "2030-01-01T00:00:00.000Z",
      payload: { ownerId, sessionId, type: "approve", payload, artifactIds: [] },
    });

    database.createSession({ id: "archived", ownerId: "u1", adapter: "test", remoteId: "archived" });
    database.createSession({ id: "blocked", ownerId: "u1", adapter: "test", remoteId: "blocked" });
    prepareArchiveCandidate(database, "archived", 1);
    database.archiveSessionForOwner({ id: "archived", ownerId: "u1" });
    create("pending", "s1");
    create("dispatching", "s1");
    database.sqlite.query("UPDATE pending_actions SET state = 'dispatching' WHERE id = ?").run("dispatching");
    create("unknown-intervention", "s1", "u1", { requiresOwnerIntervention: true, allowedResponses: ["retry", "cancel"] });
    core.markUnknown("unknown-intervention", 1);
    create("unknown-terminal", "s1");
    core.markUnknown("unknown-terminal", 1);
    create("answered", "s1");
    core.respond({ id: "answered", version: 1, answer: true });
    create("cancelled", "s1");
    core.cancel("cancelled", 1);
    create("expired", "s1");
    core.expire("expired", 1);
    create("archived-action", "archived");
    create("blocked-action", "blocked");
    database.createSession({ id: "foreign", ownerId: "u2", adapter: "test", remoteId: "foreign" });
    create("foreign-action", "foreign", "u2");

    const server = createHubServer({
      database,
      auth,
      publicOrigin: "https://hub.example",
      actions,
      authorizeSession: (sessionId, ownerId) => ownerId === "u1" && sessionId !== "blocked",
    });
    for (const path of ["/api/v1/hitl", "/api/v1/inbox"]) {
      const body = await (await server.fetch(request(path, token))).json() as { actions: Array<{ id: string }> };
      expect(body.actions.map(({ id }) => id).sort()).toEqual(["dispatching", "pending", "unknown-intervention"]);
    }
    database.close();
  });
  test("applies HITL session visibility before action responses", async () => {
    const { database, auth, token } = await fixture();
    const core = new (await import("@planee/core")).PendingActionService(database);
    const actions = new HubPendingActionService(database);
    const create = (id: string, sessionId: string) => database.createPendingAction({
      id,
      ownerId: "u1",
      sessionId,
      expiresAt: "2030-01-01T00:00:00.000Z",
      payload: { ownerId: "u1", sessionId, type: "approve", payload: id === "allowed-response" ? { allowedResponses: [{ value: "approve", label: "Approve request" }, "reject"] } : {}, artifactIds: [] },
    });
    database.createSession({ id: "archived-response", ownerId: "u1", adapter: "test", remoteId: "archived-response" });
    database.createSession({ id: "blocked-response", ownerId: "u1", adapter: "test", remoteId: "blocked-response" });
    prepareArchiveCandidate(database, "archived-response", 1);
    database.archiveSessionForOwner({ id: "archived-response", ownerId: "u1" });
    create("allowed-response", "s1");
    create("archived-response", "archived-response");
    create("blocked-response", "blocked-response");
    const responseCalls: string[] = [];
    const actionService = {
      list: actions.list.bind(actions),
      respondWithEvent: async (input: Parameters<typeof actions.respondWithEvent>[0]) => {
        responseCalls.push(input.id);
        return actions.respondWithEvent(input);
      },
    };
    const server = createHubServer({
      database,
      auth,
      publicOrigin: "https://hub.example",
      actions: actionService as unknown as HubPendingActionService,
      authorizeSession: (sessionId, ownerId) => ownerId === "u1" && sessionId !== "blocked-response",
    });
    const respond = (id: string) => server.fetch(request(`/api/v1/actions/${id}/response`, token, {
      method: "POST",
      headers: { origin: "https://hub.example", "idempotency-key": id },
      body: JSON.stringify({ version: 1, response: "approve" }),
    }));
    expect(await (await server.fetch(request("/api/v1/hitl", token))).json()).toEqual({ actions: [expect.objectContaining({ id: "allowed-response" })] });
    expect(await (await server.fetch(request("/api/v1/actions", token))).json()).toEqual({ actions: [expect.objectContaining({ id: "allowed-response", allowedResponses: [{ value: "approve", label: "Approve request" }, "reject"] })] });
    for (const id of ["blocked-response", "archived-response"]) {
      const response = await respond(id);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "action_forbidden", message: "Forbidden" } });
      expect(database.getPendingAction(id)).toMatchObject({ state: "pending", version: 1 });
      expect(database.listEvents(id === "blocked-response" ? "blocked-response" : "archived-response")).toEqual([]);
    }
    expect(responseCalls).toEqual([]);
    expect((await respond("allowed-response")).status).toBe(202);
    expect(responseCalls).toEqual(["allowed-response"]);
    expect(database.getPendingAction("allowed-response")).toMatchObject({ state: "answered", version: 2, answer: "approve" });
    database.close();
  });
  test("does not expose denied-session work", async () => {
    const { database, auth, token } = await fixture();
    database.createSession({ id: "denied-work", ownerId: "u1", adapter: "test", remoteId: "denied-work" });
    database.upsertWorkItem({ id: "visible-work", ownerId: "u1", sessionId: "s1", remoteId: "visible", state: "open", payload: {} });
    database.upsertWorkItem({ id: "denied-work", ownerId: "u1", sessionId: "denied-work", remoteId: "denied", state: "open", payload: {} });
    const server = createHubServer({
      database,
      auth,
      publicOrigin: "https://hub.example",
      authorizeSession: (sessionId, ownerId) => ownerId === "u1" && sessionId !== "denied-work",
    });
    const body = await (await server.fetch(request("/api/v1/work", token))).json() as { work: Array<{ id: string }> };
    expect(body.work.map(({ id }) => id)).toEqual(["visible-work"]);
    database.close();
  });
  test("materializes snapshots through Core's authorized allowlist", async () => {
    const { database, auth, token } = await fixture();
    database.createSession({ id: "denied-snapshot", ownerId: "u1", adapter: "test", remoteId: "denied-snapshot" });
    database.upsertWorkItem({ id: "visible-snapshot-work", ownerId: "u1", sessionId: "s1", remoteId: "visible-snapshot", state: "open", payload: {} });
    database.upsertWorkItem({ id: "denied-snapshot-work", ownerId: "u1", sessionId: "denied-snapshot", remoteId: "denied-snapshot", state: "open", payload: {} });
    const server = createHubServer({
      database,
      auth,
      publicOrigin: "https://hub.example",
      authorizeSession: (sessionId, ownerId) => ownerId === "u1" && sessionId !== "denied-snapshot",
    });
    const created = await server.fetch(request("/api/v1/snapshot", token));
    expect(created.status).toBe(200);
    const snapshot = await created.json() as { token: string };
    const page = await (await server.fetch(request(`/api/v1/snapshots/${snapshot.token}`, token))).json() as { rows: Array<{ key: string }> };
    expect(page.rows.map(({ key }) => key).sort()).toEqual(["session:s1", "work:visible-snapshot-work"]);
    database.close();
  });
  test("returns 410 for a snapshot token evicted by the owner quota", async () => {
    const { database, server, token } = await fixture();
    const snapshots: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const created = await server.fetch(request("/api/v1/snapshot", token));
      expect(created.status).toBe(200);
      snapshots.push((await created.json() as { token: string }).token);
    }
    const evicted = snapshots.find((snapshot) => !database.sqlite.query("SELECT 1 FROM snapshot_tokens WHERE token = ?").get(snapshot));
    expect(evicted).toBeDefined();
    const response = await server.fetch(request(`/api/v1/snapshots/${evicted}`, token));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: { code: "snapshot_expired", message: "Snapshot expired or unavailable" } });
    database.close();
  });
  test("accepts exactly the default snapshot row cap and returns 413 one row above it", async () => {
    const { database, server, token } = await fixture();
    for (let index = 0; index < DEFAULT_SNAPSHOT_MAX_ROWS - 1; index += 1) database.upsertWorkItem({ id: `at-quota-${index}`, ownerId: "u1", sessionId: "s1", remoteId: `at-quota-${index}`, state: "open", payload: {} });
    expect((await server.fetch(request("/api/v1/snapshot", token))).status).toBe(200);
    database.upsertWorkItem({ id: "over-quota", ownerId: "u1", sessionId: "s1", remoteId: "over-quota", state: "open", payload: {} });
    const response = await server.fetch(request("/api/v1/snapshot", token));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "snapshot_too_large", message: "Snapshot exceeds size limit" } });
    database.close();
  });
  test("returns snapshot_unavailable for unrelated snapshot failures", async () => {
    const { database, server, token } = await fixture();
    database.sqlite.exec("CREATE TRIGGER reject_snapshot_token BEFORE INSERT ON snapshot_tokens BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END");
    const response = await server.fetch(request("/api/v1/snapshot", token));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "snapshot_unavailable", message: "Snapshot unavailable" } });
    database.close();
  });
  test("keeps snapshot tokens valid until the 10-minute expiry boundary", async () => {
    const { database, auth, token, now: initialNow } = await fixture();
    let now = initialNow;
    const server = createHubServer({
      database,
      auth,
      publicOrigin: "https://hub.example",
      now: () => now,
      authorizeSession: (_sessionId, ownerId) => ownerId === "u1",
    });
    const created = await server.fetch(request("/api/v1/snapshot", token));
    expect(created.status).toBe(200);
    const { token: snapshotToken } = await created.json() as { token: string };
    now += DEFAULT_SNAPSHOT_TTL_MS - 1;
    expect((await server.fetch(request(`/api/v1/snapshots/${snapshotToken}`, token))).status).toBe(200);
    now += 1;
    const expired = await server.fetch(request(`/api/v1/snapshots/${snapshotToken}`, token));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: { code: "snapshot_expired", message: "Snapshot expired or unavailable" } });
    database.close();
  });
  test("filters denied session SSE rows in SQL before applying the page limit", async () => {
    const { database, auth, token } = await fixture();
    database.createSession({ id: "denied-sse", ownerId: "u1", adapter: "test", remoteId: "denied-sse" });
    for (let index = 0; index < 100; index += 1) database.enqueueSse("u1", { type: "denied", index }, "denied-sse");
    database.enqueueSse("u1", { type: "allowed" }, "s1");
    database.enqueueSse("u1", { type: "owner.refresh" }, "s1");
    database.enqueueSse("u1", { type: "owner.unsafe", payload: { detail: "denied" } }, "denied-sse");
    const server = createHubServer({ database, auth, publicOrigin: "https://hub.example", authorizeSession: (sessionId) => sessionId !== "denied-sse" });
    const response = await server.fetch(request("/api/v1/events", token));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("owner.refresh");
    expect(body).toContain("allowed");
    expect(body).not.toContain("denied-sse");
    expect(body).not.toContain("owner.unsafe");
    database.close();
  });
  test("requires a snapshot reset when the SSE cursor is older than Core retention", async () => {
    const { database, server, token } = await fixture();
    database.appendEvent("s1", "retained", {});
    database.sqlite.query("DELETE FROM sse_outbox WHERE id = (SELECT MIN(id) FROM sse_outbox WHERE owner_id = ?)").run("u1");
    expect(database.minimumRetainedSseCursor("u1")).toBeGreaterThan(0);
    const response = await server.fetch(request("/api/v1/events?after=0", token));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ reset: "snapshot-required" });
    database.close();
  });
  test("archives owned sessions idempotently, records device-attributed audits, and exposes owner-scoped workflow lists", async () => {
    const { database, auth, server, token } = await fixture();
    const deviceId = (await auth.verify(token)).deviceId;
    expect(await (await server.fetch(request("/api/v1/work", token))).json()).toEqual({ work: [] });
    expect(await (await server.fetch(request("/api/v1/hitl", token))).json()).toEqual({ actions: [] });
    const archive = { method: "POST", headers: { origin: "https://hub.example" } };
    const immediate = await server.fetch(request("/api/v1/sessions/s1/archive", token, archive));
    expect(immediate.status).toBe(409);
    prepareArchiveCandidate(database, "s1", 2);
    const first = await server.fetch(request("/api/v1/sessions/s1/archive", token, archive));
    expect(first.status).toBe(200);
    const archived = await first.json();
    expect(archived).toMatchObject({ session: { id: "s1", archivedAt: expect.any(String) } });
    const repeat = await server.fetch(request("/api/v1/sessions/s1/archive", token, archive));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(archived);
    expect(await (await server.fetch(request("/api/v1/history", token))).json()).toMatchObject({ sessions: [{ id: "s1", archivedAt: expect.any(String) }] });
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "archived" }, body: JSON.stringify({ prompt: "blocked" }) }))).status).toBe(409);
    expect((await server.fetch(request("/api/v1/sessions/s1/unarchive", token, archive))).status).toBe(200);
    expect(database.sqlite.query("SELECT action, actor_id, device_id, correlation_id FROM audit_log WHERE session_id = ? ORDER BY id").all("s1")).toEqual([
      { action: "session.archived", actor_id: "owner", device_id: deviceId, correlation_id: expect.any(String) },
      { action: "session.unarchived", actor_id: "owner", device_id: deviceId, correlation_id: expect.any(String) },
    ]);
    const audits = database.sqlite.query("SELECT correlation_id FROM audit_log WHERE session_id = ? ORDER BY id").all("s1") as Array<{ correlation_id: string }>;
    expect(audits.every(({ correlation_id }) => correlation_id.length > 0)).toBeTrue();
    database.close();
  });
  test("rejects prompts for view-only sessions", async () => {
    const { database, server, token } = await fixture();
    database.sqlite.query("UPDATE sessions SET control_mode = 'view-only' WHERE id = ?").run("s1");
    expect((await server.fetch(request("/api/v1/sessions/s1/prompt", token, { method: "POST", headers: { origin: "https://hub.example", "idempotency-key": "view-only" }, body: JSON.stringify({ prompt: "blocked" }) }))).status).toBe(409);
    database.close();
  });
  test("serves finite session catch-up, honors Last-Event-ID, and rejects unsafe cursors", async () => {
    const { database, server, token } = await fixture();
    database.appendEvent("s1", "message", { text: "one" });
    database.appendEvent("s1", "message", { text: "two" });

    const response = await server.fetch(request("/api/v1/sessions/s1/events", token, { headers: { "last-event-id": "1" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("x-stream-mode")).toBe("finite-catch-up");
    expect(response.headers.get("connection")).toBeNull();
    expect(await response.text()).toContain("id: 2");

    expect((await server.fetch(request("/api/v1/sessions/s1/events?after=9007199254740992", token))).status).toBe(400);
    database.close();
  });
});
