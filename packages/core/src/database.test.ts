import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { CoreDatabase, CorruptPersistentDataError, DurableCommandDispatcher, SecretDataError } from "./database";
import { findUnsafeAuthoritativeSinkWrites, MAX_SCAN_INPUT_BYTES, REDACTED, redact, redactForSink, SINK_KINDS } from "./redact";

const databases: CoreDatabase[] = [];
const database = (): CoreDatabase => { const value = new CoreDatabase(); databases.push(value); return value; };
afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("CoreDatabase", () => {
  test("migrations enforce session, event, and command constraints", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    expect(() => db.createSession({ id: "session-2", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" })).toThrow();
    expect(() => db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES ('missing', 1, 'x', '{}', 'now')").run()).toThrow();
    expect(() => db.sqlite.query("INSERT INTO commands (id, session_id, idempotency_key, state, payload_json, created_at, updated_at) VALUES ('bad', 'session-1', 'key', 'bad', '{}', 'now', 'now')").run()).toThrow();
  });
  test("runs named historical jobs in bounded, resumable batches", () => {
    const db = database();
    db.createSession({ id: "historical", ownerId: "owner-1", adapter: "adapter", remoteId: "historical" });
    const insert = db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, 'event', '{}', ?)");
    for (let seq = 1; seq <= 501; seq++) insert.run("historical", seq, "2020-01-01T00:00:00.000Z");
    expect(() => db.runHistoricalArchiveBackfill()).toThrow("requires completed");
    const folded: number[] = [];
    expect(db.runHistoricalProjectionBackfill({ fold: (event) => folded.push(event.seq) })).toMatchObject({ state: "running", cursor: { sessionId: "historical", seq: 500 } });
    expect(folded).toHaveLength(500);
    expect(db.runHistoricalProjectionBackfill({ fold: (event) => folded.push(event.seq) })).toMatchObject({ state: "complete", cursor: { sessionId: "historical", seq: 501 } });
    expect(folded).toHaveLength(501);
    expect(db.runHistoricalProjectionBackfill({ fold: (event) => folded.push(event.seq) })).toMatchObject({ state: "complete" });
    expect(folded).toHaveLength(501);
    expect(db.getProjectionCheckpoint("historical").nextExpectedSeq).toBe(502);
  });
  test("migrates projection gap reasons to the canonical checked vocabulary", async () => {
    const filename = `/tmp/core-projection-gaps-${crypto.randomUUID()}.sqlite`;
    try {
      const legacy = new Database(filename);
      legacy.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, owner_id TEXT, adapter TEXT NOT NULL, remote_id TEXT NOT NULL, status TEXT NOT NULL, reconciliation_epoch INTEGER NOT NULL DEFAULT 0, reconciled INTEGER NOT NULL DEFAULT 0, remote_revision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO sessions VALUES ('session-1', 'owner-1', 'adapter', 'remote-1', 'active', 0, 0, NULL, 'now', 'now');
        CREATE TABLE session_projection_gaps (session_id TEXT NOT NULL, projector_version TEXT NOT NULL, seq INTEGER NOT NULL, reason TEXT NOT NULL, resolved_at TEXT, detected_at TEXT NOT NULL, PRIMARY KEY (session_id, projector_version, seq));
        INSERT INTO session_projection_gaps VALUES ('session-1', 'legacy', 1, 'projection-failure', NULL, 'now'), ('session-1', 'legacy', 2, 'missing', NULL, 'now'), ('session-1', 'legacy', 3, 'invalid', NULL, 'now');
      `);
      legacy.close();
      const db = new CoreDatabase(filename);
      expect(db.sqlite.query("SELECT seq, reason FROM session_projection_gaps ORDER BY seq").all()).toEqual([{ seq: 1, reason: "failed" }, { seq: 2, reason: "missing" }]);
      expect(db.sqlite.query("SELECT record_type, record_id, payload_column FROM corrupt_payloads").all()).toContainEqual({ record_type: "session_projection_gap", record_id: "session-1:legacy:3", payload_column: "reason" });
      expect(() => db.sqlite.query("INSERT INTO session_projection_gaps VALUES ('session-1', 'legacy', 4, 'invalid', NULL, 'now')").run()).toThrow();
      db.close();
    } finally {
      await Bun.file(filename).delete();
    }
  });
  test("quarantines ownerless sessions until an explicit claim", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.sqlite.query("UPDATE sessions SET owner_id = NULL, status = 'unknown', reconciled = 0 WHERE id = ?").run("session-1");
    expect(db.getSession("session-1")).toBeNull();
    expect(db.getSessionForOwner("session-1", "owner-1")).toBeNull();
    expect(() => db.setReconciliation("session-1", "active", 1, true, "revision-1")).toThrow();
    expect(db.claimSession("session-1", "owner-2")).toMatchObject({ ownerId: "owner-2", status: "unknown", reconciled: false });
    expect(db.claimSession("session-1", "owner-3")).toBeNull();
  });
  test("quarantines corrupt event payloads with controlled errors", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.appendEvent("session-1", "created", {});
    db.sqlite.query("UPDATE events SET payload_json = '{' WHERE session_id = ?").run("session-1");
    expect(() => db.listEvents("session-1")).toThrow(CorruptPersistentDataError);
    expect(db.getSession("session-1")).toMatchObject({ status: "unknown", reconciled: false });
    expect(db.sqlite.query("SELECT record_type, record_id, payload_column FROM corrupt_payloads").all()).toEqual([{ record_type: "event", record_id: "session-1:1", payload_column: "payload_json" }]);
  });
  test("quarantines malformed command, pending action, and audit payloads", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.setReconciliation("session-1", "active", 1, true, "revision-1");
    db.acceptCommand({ id: "command-1", sessionId: "session-1", idempotencyKey: "request-1", payload: {} });
    db.createPendingAction({ id: "action-1", ownerId: "owner-1", payload: {}, expiresAt: "2030-01-01T00:00:00.000Z" });
    const audit = db.writeAudit({ action: "test", payload: {} });
    db.sqlite.query("UPDATE commands SET payload_json = '{' WHERE id = ?").run("command-1");
    db.sqlite.query("UPDATE pending_actions SET payload_json = '{' WHERE id = ?").run("action-1");
    db.sqlite.query("UPDATE audit_log SET payload_json = '{' WHERE id = ?").run(audit.id);
    expect(() => db.acceptCommandWithEvent({ id: "command-2", sessionId: "session-1", idempotencyKey: "request-1", payload: {}, eventType: "duplicate", eventPayload: {} })).toThrow(CorruptPersistentDataError);
    expect(() => db.getPendingAction("action-1")).toThrow(CorruptPersistentDataError);
    expect(() => db.getAudit(audit.id)).toThrow(CorruptPersistentDataError);
    expect(db.sqlite.query("SELECT record_type, record_id, payload_column FROM corrupt_payloads ORDER BY record_type").all()).toEqual([
      { record_type: "audit", record_id: String(audit.id), payload_column: "payload_json" },
      { record_type: "command", record_id: "command-1", payload_column: "payload_json" },
      { record_type: "pending_action", record_id: "action-1", payload_column: "payload_json" },
    ]);
  });

  test("appends strictly monotonic events per session", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    expect(db.appendEvent("session-1", "created", {}).seq).toBe(1);
    expect(db.appendEvent("session-1", "updated", { version: 2 }).seq).toBe(2);
  });

  test("returns existing command for duplicate idempotency keys", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.setReconciliation("session-1", "active", 1, true, "revision-1");
    const first = db.acceptCommand({ id: "command-1", sessionId: "session-1", idempotencyKey: "request-1", payload: { operation: "send" } });
    const duplicate = db.acceptCommand({ id: "command-2", sessionId: "session-1", idempotencyKey: "request-1", payload: { operation: "send" } });
    expect(first.duplicate).toBeFalse();
    expect(duplicate).toEqual({ command: first.command, duplicate: true });
  });
  test("rejects commands until an active session has been reconciled", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    expect(() => db.acceptCommand({ id: "command-1", sessionId: "session-1", idempotencyKey: "request-1", payload: { operation: "send" } })).toThrow("Mutation rejected while session requires reconciliation");
    db.setReconciliation("session-1", "active", 1, true, "revision-1");
    expect(db.acceptCommand({ id: "command-1", sessionId: "session-1", idempotencyKey: "request-1", payload: { operation: "send" } }).duplicate).toBeFalse();
    db.setReconciliation("session-1", "unknown", 2, false, null);
    expect(() => db.acceptCommand({ id: "command-2", sessionId: "session-1", idempotencyKey: "request-2", payload: { operation: "send" } })).toThrow("Mutation rejected while session requires reconciliation");
    const duplicate = db.acceptCommand({ id: "command-3", sessionId: "session-1", idempotencyKey: "request-1", payload: { operation: "send" } });
    expect(duplicate.duplicate).toBeTrue();
    expect(duplicate.command.id).toBe("command-1");
  });

  test("rolls back an interrupted transaction", () => {
    const db = database();
    expect(() => db.transaction(() => {
      db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
      db.appendEvent("session-1", "created", {});
      throw new Error("simulated crash before commit");
    })).toThrow("simulated crash before commit");
    expect(db.getSession("session-1")).toBeNull();
  });

  test("serializes before rejecting secret-bearing values on every persistence path", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.setReconciliation("session-1", "active", 1, true, "revision-1");
    const secretAfterSerialization = { toJSON: () => ({ accessToken: "abc" }) };
    expect(() => db.appendEvent("session-1", "created", secretAfterSerialization)).toThrow(SecretDataError);
    expect(() => db.acceptCommand({ id: "command-1", sessionId: "session-1", idempotencyKey: "request-1", payload: secretAfterSerialization })).toThrow(SecretDataError);
    expect(() => db.createPendingAction({ id: "action-1", ownerId: "owner-1", payload: secretAfterSerialization, expiresAt: "2030-01-01T00:00:00.000Z" })).toThrow(SecretDataError);
    db.createPendingAction({ id: "action-2", ownerId: "owner-1", payload: {}, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(() => db.updatePendingAction({ id: "action-2", expectedVersion: 1, state: "answered", answer: secretAfterSerialization, updatedAt: "2025-01-01T00:00:00.000Z" })).toThrow(SecretDataError);
    expect(() => db.writeAudit({ action: "request", payload: secretAfterSerialization })).toThrow(SecretDataError);
  });
  test("defines exactly the eight authoritative sink kinds and scans deeply before truncation", () => {
    expect(SINK_KINDS).toEqual(["events", "work-items", "pending-actions", "projection-diagnostics", "audit", "sse-outbox", "push", "snapshots"]);
    expect(SINK_KINDS).toHaveLength(8);
    for (const sink of SINK_KINDS) expect(() => redactForSink(sink, { nested: { deeply: { authorization: "Bearer secret-at-end" } } })).toThrow(SecretDataError);
    expect(() => redactForSink("events", { payload: "é".repeat(Math.ceil(MAX_SCAN_INPUT_BYTES / 2)) })).toThrow(SecretDataError);
    expect(() => redactForSink("events", { payload: "x".repeat(MAX_SCAN_INPUT_BYTES) })).toThrow(`Sink payload exceeds ${MAX_SCAN_INPUT_BYTES}`);
  });
  test("checks every authoritative sink write callsite routes through its full-scan sink", async () => {
    const source = await Bun.file(new URL("./database.ts", import.meta.url)).text();
    expect(findUnsafeAuthoritativeSinkWrites(source)).toEqual([]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      class Unsafe {
        write() { json("events", { safe: true }); this.sqlite.query("INSERT INTO events VALUES (?, ?)").run(); }
      }
    `)).toEqual(["events write bypasses events"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      class Unsafe {
        write() { this.sqlite.exec("UPDATE audit_log SET payload_json = 'raw'"); }
      }
    `)).toEqual(["audit_log write bypasses audit"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      class Unsafe {
        write() { const statement = database.query("INSERT INTO snapshot_rows VALUES (?, ?, ?)"); statement.run(token, key, raw); }
      }
    `)).toEqual(["snapshot_rows write bypasses snapshots"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      class Unsafe {
        write() { this.sqlite.query("INSERT INTO push_subscriptions VALUES (?, ?)").run(redactForSink("events", input)); }
      }
    `)).toEqual(["push_subscriptions write bypasses push"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      const sanitized = json("events", raw);
      function write() { let payload = sanitized; payload = raw; database.query("INSERT INTO events VALUES (?, ?)").run(id, payload); }
    `)).toEqual(["events write bypasses events"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      function sibling() { const payload = json("events", raw); }
      function write() { database.query("INSERT INTO events VALUES (?, ?)").run(id, payload); }
    `)).toEqual(["events write bypasses events"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      const payload = json("events", raw);
      function write(payload: unknown) { database.query("INSERT INTO events VALUES (?, ?)").run(id, payload); }
    `)).toEqual(["events write bypasses events"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      function write() { json("events", unrelated); database.query("INSERT INTO events VALUES (?, ?)").run(id, raw); }
    `)).toEqual(["events write bypasses events"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      database.exec("INSERT INTO events VALUES ('id', 'raw')");
    `)).toEqual(["events write bypasses events"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      const insert = database.query("INSERT INTO events VALUES (?, ?)");
      insert.run(id, json("events", payload));
    `)).toEqual(["events write bypasses events"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      database.query("INSERT INTO events (session_id, seq, type, payload_json) VALUES (?, ?, ?, ?)").run(id, 1, "created", raw, json("events", harmless));
    `)).toEqual(["events write bypasses events"]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      database.query("INSERT INTO events (session_id, seq, type, payload_json) VALUES (?, ?, ?, ?)").run(id, 1, "created", json("events", harmless), raw);
    `)).toEqual([]);
    expect(findUnsafeAuthoritativeSinkWrites(`
      database.query("INSERT INTO events (session_id, seq, type, payload_json) VALUES (?, ?, ?, ?)").run(json("events", harmless), id, 1, "created");
    `)).toEqual(["events write bypasses events"]);
  });

  test("rejects commands and events for terminal sessions", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.setReconciliation("session-1", "terminal", 1, true, "revision-1");
    expect(() => db.acceptCommand({ id: "command-1", sessionId: "session-1", idempotencyKey: "request-1", payload: {} })).toThrow("Terminal sessions are immutable");
    expect(() => db.appendEvent("session-1", "created", {})).toThrow("Terminal sessions are immutable");
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM commands").get()).toEqual({ count: 0 });
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });
  test("returns a durable duplicate after the session becomes terminal", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.setReconciliation("session-1", "active", 1, true, "revision-1");
    const accepted = db.acceptCommand({ id: "command-1", sessionId: "session-1", idempotencyKey: "request-1", payload: {} });
    db.setReconciliation("session-1", "terminal", 2, true, "revision-2");
    const duplicate = db.acceptCommand({ id: "command-2", sessionId: "session-1", idempotencyKey: "request-1", payload: {} });
    expect(duplicate).toEqual({ command: accepted.command, duplicate: true });
  });
  test("quarantines a corrupt duplicate once across independent database connections", async () => {
    const filename = `/tmp/core-corrupt-race-${crypto.randomUUID()}.sqlite`;
    const first = new CoreDatabase(filename);
    const second = new CoreDatabase(filename);
    try {
      first.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
      first.setReconciliation("session-1", "active", 1, true, "revision-1");
      first.acceptCommandWithEvent({ id: "command-1", sessionId: "session-1", idempotencyKey: "request-1", payload: {}, eventType: "accepted", eventPayload: {} });
      first.sqlite.query("UPDATE commands SET payload_json = '{' WHERE id = ?").run("command-1");
      const attempts = await Promise.allSettled([
        Promise.resolve().then(() => first.acceptCommandWithEvent({ id: "command-a", sessionId: "session-1", idempotencyKey: "request-1", payload: {}, eventType: "duplicate", eventPayload: {} })),
        Promise.resolve().then(() => second.acceptCommandWithEvent({ id: "command-b", sessionId: "session-1", idempotencyKey: "request-1", payload: {}, eventType: "duplicate", eventPayload: {} })),
      ]);
      expect(attempts.every((attempt) => attempt.status === "rejected" && attempt.reason instanceof CorruptPersistentDataError)).toBeTrue();
      expect(first.sqlite.query("SELECT COUNT(*) AS count FROM corrupt_payloads WHERE record_type = 'command' AND record_id = 'command-1'").get()).toEqual({ count: 1 });
    } finally {
      first.close();
      second.close();
      await Bun.file(filename).delete();
    }
  });
});
  test("archives once, scopes owner reads, and retains archive metadata", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.setReconciliation("session-1", "terminal", 1, true, "revision-1");
    db.sqlite.query("UPDATE sessions SET updated_at = '2025-12-31T23:00:00.000Z' WHERE id = 'session-1'").run();
    const archived = db.archiveSessionForOwner({ id: "session-1", ownerId: "owner-1", archivedAt: "2026-01-01T00:00:00.000Z" });
    expect(archived).toMatchObject({ archivedAt: "2026-01-01T00:00:00.000Z" });
    db.createPendingActionForOwner({ id: "after-archive", ownerId: "owner-1", sessionId: "session-1", payload: {}, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(db.archiveSessionForOwner({ id: "session-1", ownerId: "owner-1", archivedAt: "2027-01-01T00:00:00.000Z" })).toEqual(archived);
    expect(db.archiveSessionForOwner({ id: "session-1", ownerId: "owner-2" })).toBeNull();
    expect(db.listArchivedSessionsForOwner("owner-2")).toEqual([]);
  });
  test("allows manual archives of active work but keeps retention eligibility strict", () => {
    const db = database();
    db.createSession({ id: "manual-active", ownerId: "owner-1", adapter: "adapter", remoteId: "manual-active" });
    db.setReconciliation("manual-active", "active", 1, true, "revision-1");
    db.upsertWorkItem({ id: "manual-work", ownerId: "owner-1", sessionId: "manual-active", remoteId: "manual-work", state: "open", payload: {} });
    expect(db.canArchiveSessionForOwner("manual-active", "owner-1").blockers).toEqual(expect.arrayContaining(["terminal", "grace-period", "work-items"]));
    expect(db.canManuallyArchiveSessionForOwner("manual-active", "owner-1")).toEqual({ eligible: true, blockers: [] });
    expect(db.archiveSessionForOwner({ id: "manual-active", ownerId: "owner-1" })).toMatchObject({ archivedAt: expect.any(String) });

    db.createSession({ id: "retention-active", ownerId: "owner-1", adapter: "adapter", remoteId: "retention-active" });
    db.setReconciliation("retention-active", "active", 1, true, "revision-1");
    db.upsertWorkItem({ id: "retention-work", ownerId: "owner-1", sessionId: "retention-active", remoteId: "retention-work", state: "open", payload: {} });
    db.sqlite.query("UPDATE sessions SET source_created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", "retention-active");
    expect(db.archiveSessionsBeforeForOwner({ ownerId: "owner-1", sourceCreatedAtBefore: "2021-01-01T00:00:00.000Z" })).toEqual([]);
    expect(db.getSession("retention-active")?.archivedAt).toBeNull();
  });
  test("writes owner transition audits atomically without auditing no-ops", () => {
    const db = database();
    db.createSession({ id: "audited", ownerId: "owner-1", adapter: "adapter", remoteId: "audited" });
    db.setReconciliation("audited", "terminal", 1, true, "revision-1");
    db.sqlite.query("UPDATE sessions SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 'audited'").run();
    const archiveCorrelation = "archive-correlation";
    db.archiveSessionForOwner({ id: "audited", ownerId: "owner-1", actorId: "owner", deviceId: "device-1", correlationId: archiveCorrelation });
    db.archiveSessionForOwner({ id: "audited", ownerId: "owner-1", actorId: "owner", deviceId: "device-1", correlationId: "duplicate" });
    const unarchiveCorrelation = "unarchive-correlation";
    db.unarchiveSessionForOwner({ id: "audited", ownerId: "owner-1", actorId: "owner", deviceId: "device-1", correlationId: unarchiveCorrelation });
    db.unarchiveSessionForOwner({ id: "audited", ownerId: "owner-1", actorId: "owner", deviceId: "device-1", correlationId: "duplicate" });
    expect(db.sqlite.query("SELECT action, actor_id, device_id, correlation_id FROM audit_log WHERE session_id = ? ORDER BY id").all("audited")).toEqual([
      { action: "session.archived", actor_id: "owner", device_id: "device-1", correlation_id: archiveCorrelation },
      { action: "session.unarchived", actor_id: "owner", device_id: "device-1", correlation_id: unarchiveCorrelation },
    ]);
  });
  test("archives against only the active projector version", () => {
    const db = database();
    db.createSession({ id: "session-versions", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-versions" });
    db.appendEvent("session-versions", "created", {});
    db.setReconciliation("session-versions", "terminal", 1, true, "revision-1");
    expect(db.cutoverProjectorVersion({ sessionId: "session-versions", ownerId: "owner-1", projectorVersion: "v2", expectedCurrentVersion: null, expectedReconciliationEpoch: 1, workItems: [] })).toBeTrue();
    expect(db.applyProjection({ sessionId: "session-versions", ownerId: "owner-1", projectorVersion: "v2", effectKey: "archive", apply: () => {} })).toBe(1);
    db.upsertWorkItem({ id: "stale-work", ownerId: "owner-1", sessionId: "session-versions", remoteId: "stale", state: "open", payload: {}, projectorVersion: "legacy" });
    db.sqlite.query("INSERT INTO session_projection_gaps VALUES ('session-versions', 'legacy', 1, 'failed', NULL, 'now')").run();
    db.sqlite.query("INSERT INTO projection_failures VALUES ('session-versions', 'legacy', 1, 'failed', 'now')").run();
    expect(db.canArchiveSessionForOwner("session-versions", "owner-1", "2099-01-01T00:00:00.000Z")).toEqual({ eligible: true, blockers: [] });
    db.upsertWorkItem({ id: "active-work", ownerId: "owner-1", sessionId: "session-versions", remoteId: "active", state: "open", payload: {}, projectorVersion: "v2" });
    expect(db.canArchiveSessionForOwner("session-versions", "owner-1").blockers).toContain("work-items");
    db.sqlite.query("UPDATE work_items SET state = 'closed' WHERE id = 'active-work'").run();
    db.sqlite.query("INSERT INTO session_projection_gaps VALUES ('session-versions', 'v2', 1, 'failed', NULL, 'now')").run();
    expect(db.canArchiveSessionForOwner("session-versions", "owner-1").blockers).toContain("projection-gaps");
    db.sqlite.query("UPDATE session_projection_gaps SET resolved_at = 'now' WHERE projector_version = 'v2'").run();
    db.sqlite.query("INSERT INTO projection_failures VALUES ('session-versions', 'v2', 1, 'failed', 'now')").run();
    expect(db.canArchiveSessionForOwner("session-versions", "owner-1").blockers).toContain("projection-failures");
  });
  test("migrates and updates discovered display metadata without changing archive state", () => {
    const db = database();
    expect(db.sqlite.query("PRAGMA table_info(sessions)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "title" }),
      expect.objectContaining({ name: "workdir" }),
      expect.objectContaining({ name: "source_created_at" }),
    ]));
    db.upsertDiscoveredSession({
      id: "discovered-1", ownerId: "owner-1", adapter: "gjc", remoteId: "remote-1",
      controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "available",
      title: "First title", workdir: "/repo/first", sourceCreatedAt: "2026-07-15T10:00:00.000Z", updatedAt: "2026-07-15T10:01:00.000Z",
    });
    db.setReconciliation("discovered-1", "terminal", 1, true, "revision-1");
    db.sqlite.query("UPDATE sessions SET updated_at = '2026-07-15T10:00:00.000Z' WHERE id = 'discovered-1'").run();
    db.archiveSessionForOwner({ id: "discovered-1", ownerId: "owner-1", archivedAt: "2026-07-15T11:00:00.000Z" });
    const updated = db.upsertDiscoveredSession({
      id: "ignored-on-conflict", ownerId: "owner-1", adapter: "gjc", remoteId: "remote-1",
      controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "available",
      title: "Updated title", workdir: "/repo/updated", sourceCreatedAt: "2026-07-15T09:00:00.000Z", updatedAt: "2026-07-15T12:00:00.000Z",
    });
    expect(updated).toMatchObject({
      id: "discovered-1", title: "Updated title", workdir: "/repo/updated",
      sourceCreatedAt: "2026-07-15T09:00:00.000Z", archivedAt: "2026-07-15T11:00:00.000Z",
    });
    db.upsertDiscoveredSession({
      id: "ignored-again", ownerId: "owner-1", adapter: "gjc", remoteId: "remote-1",
      controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "unreadable", updatedAt: "2026-07-15T13:00:00.000Z",
    });
    expect(db.getSession("discovered-1")).toMatchObject({ title: "Updated title", workdir: "/repo/updated", sourceCreatedAt: "2026-07-15T09:00:00.000Z" });
  });
  test("archives only an owner's sessions created before the source cutoff", () => {
    const db = database();
    for (const [id, ownerId, sourceCreatedAt] of [
      ["old", "owner-1", "2026-07-15T23:59:59.000Z"],
      ["today", "owner-1", "2026-07-16T00:00:00.000Z"],
      ["other-owner", "owner-2", "2026-07-15T00:00:00.000Z"],
    ] as const) {
      db.upsertDiscoveredSession({ id, ownerId, adapter: "gjc", remoteId: id, controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "available", sourceCreatedAt, updatedAt: sourceCreatedAt });
    }
    for (const id of ["old", "today", "other-owner"]) {
      db.setReconciliation(id, "terminal", 1, true, "revision-1");
      db.sqlite.query("UPDATE sessions SET updated_at = '2026-07-15T00:00:00.000Z' WHERE id = ?").run(id);
    }
    expect(db.archiveSessionsBeforeForOwner({
      ownerId: "owner-1", sourceCreatedAtBefore: "2026-07-16T00:00:00.000Z", archivedAt: "2026-07-16T12:00:00.000Z",
    })).toMatchObject([{ id: "old", archivedAt: "2026-07-16T12:00:00.000Z" }]);
    expect(db.getSession("today")?.archivedAt).toBeNull();
    expect(db.getSessionForOwner("other-owner", "owner-2")?.archivedAt).toBeNull();
    expect(db.sqlite.query("SELECT actor_id, device_id, correlation_id FROM audit_log WHERE session_id = ?").all("old")).toEqual([
      { actor_id: "system", device_id: null, correlation_id: expect.any(String) },
    ]);
  });
  test("uses stable work identities and contiguous projection checkpoints", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    const first = db.upsertWorkItem({ id: "work-1", ownerId: "owner-1", sessionId: "session-1", remoteId: "remote-work-1", state: "open", payload: {} });
    expect(db.upsertWorkItem({ id: "work-2", ownerId: "owner-1", sessionId: "session-1", remoteId: "remote-work-1", state: "done", payload: {} }).id).toBe(first.id);
    db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES ('session-1', 2, 'two', '{}', '2026-01-01T00:00:02.000Z')").run();
    expect(db.applyProjection({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "legacy", effectKey: "contiguous", apply: () => {} })).toBe(0);
    db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES ('session-1', 1, 'one', '{}', '2026-01-01T00:00:01.000Z')").run();
    expect(db.applyProjection({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "legacy", effectKey: "contiguous", apply: () => {} })).toBe(2);
    expect(db.getProjectionCheckpoint("session-1").nextExpectedSeq).toBe(3);
    expect(db.listProjectionGaps("session-1")).toHaveLength(1);
  });
  test("activates projector versions atomically for their owner", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });

    expect(db.activateProjectorVersion({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v1" })).toBeTrue();
    const versionedWorkItems = [
      db.upsertWorkItem({ id: "v1-work", ownerId: "owner-1", sessionId: "session-1", remoteId: "same-work", state: "open", payload: { version: "v1" }, projectorVersion: "v1" }),
      db.upsertWorkItem({ id: "v2-work", ownerId: "owner-1", sessionId: "session-1", remoteId: "same-work", state: "done", payload: { version: "v2" }, projectorVersion: "v2" }),
    ];
    expect(versionedWorkItems.map(({ id, projectorVersion, state, payload }) => ({ id, projectorVersion, state, payload }))).toEqual([
      { id: "v1-work", projectorVersion: "v1", state: "open", payload: { version: "v1" } },
      { id: "v2-work", projectorVersion: "v2", state: "done", payload: { version: "v2" } },
    ]);
    expect(db.getSessionForOwner("session-1", "owner-1")?.activeProjectorVersion).toBe("v1");
    expect(db.listSseAfter<{ type: string; payload: { activeProjectorVersion: string } }>("owner-1", 0)
      .filter(({ event }) => event.type === "session.projector-version-activated")).toEqual([
        expect.objectContaining({ event: expect.objectContaining({ payload: expect.objectContaining({ activeProjectorVersion: "v1" }) }) }),
      ]);

    expect(db.activateProjectorVersion({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v1" })).toBeFalse();
    expect(db.activateProjectorVersion({ sessionId: "session-1", ownerId: "owner-2", projectorVersion: "v2", expectedCurrentVersion: "v1" })).toBeFalse();
    expect(db.activateProjectorVersion({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v2", expectedCurrentVersion: "v0" })).toBeFalse();
    expect(db.activateProjectorVersion({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v2", expectedCurrentVersion: "v1" })).toBeTrue();
    expect(db.activateProjectorVersion({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v1" })).toBeFalse();
    expect(db.getSessionForOwner("session-1", "owner-1")?.activeProjectorVersion).toBe("v2");
    expect(db.activateProjectorVersion({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v1", expectedCurrentVersion: "v2" })).toBeTrue();
    expect(db.getSessionForOwner("session-1", "owner-1")?.activeProjectorVersion).toBe("v1");
    expect(db.sqlite.query("SELECT projector_version, state, payload_json FROM work_items WHERE session_id = ? ORDER BY projector_version").all("session-1")).toEqual([
      { projector_version: "v1", state: "open", payload_json: '{"version":"v1"}' },
      { projector_version: "v2", state: "done", payload_json: '{"version":"v2"}' },
    ]);
    expect(db.listSseAfter("owner-1", 0).filter(({ event }) => (event as { type: string }).type === "session.projector-version-activated")).toHaveLength(3);
  });
  test("omits work items from archived sessions", () => {
    const db = database();
    db.createSession({ id: "active-session", ownerId: "owner-1", adapter: "adapter", remoteId: "active-remote" });
    db.createSession({ id: "archived-session", ownerId: "owner-1", adapter: "adapter", remoteId: "archived-remote" });
    db.upsertWorkItem({ id: "inactive-work", ownerId: "owner-1", sessionId: "active-session", remoteId: "inactive-work", state: "open", payload: {}, projectorVersion: "1" });
    db.upsertWorkItem({ id: "active-work", ownerId: "owner-1", sessionId: "active-session", remoteId: "active-work", state: "open", payload: {}, projectorVersion: "2" });
    db.sqlite.query("UPDATE sessions SET active_projector_version = ? WHERE id = ?").run("2", "active-session");
    db.upsertWorkItem({ id: "archived-work", ownerId: "owner-1", sessionId: "archived-session", remoteId: "archived-work", state: "done", payload: {} });
    db.setReconciliation("archived-session", "terminal", 1, true, "revision-1");
    db.sqlite.query("UPDATE sessions SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 'archived-session'").run();
    db.archiveSessionForOwner({ id: "archived-session", ownerId: "owner-1" });
    expect(db.listWorkItemsForOwner("owner-1").map(({ id, projectorVersion }) => ({ id, projectorVersion }))).toEqual([
      { id: "active-work", projectorVersion: "2" },
    ]);
  });
  test("fails closed when a session is archived before projection", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    db.appendEvent("session-1", "created", { value: 1 });
    db.setReconciliation("session-1", "terminal", 1, true, "revision-1");
    expect(db.applyProjection({ sessionId: "session-1", ownerId: "owner-1", projectorVersion: "legacy", effectKey: "archive", apply: () => {} })).toBe(1);
    db.sqlite.query("UPDATE sessions SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 'session-1'").run();
    db.archiveSessionForOwner({ id: "session-1", ownerId: "owner-1" });

    let folds = 0;
    expect(db.applyProjection({
      sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v1",
      effectKey: "test", apply: () => { folds++; },
    })).toBe(0);
    expect(folds).toBe(0);
    expect(db.getProjectionCheckpoint("session-1", "v1").nextExpectedSeq).toBe(1);
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM projection_effects WHERE session_id = ? AND projector_version = ?").get("session-1", "v1")).toEqual({ count: 0 });
  });
  test("cuts over complete projector shadows atomically and preserves rollback rows", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    const initial = db.getSessionForOwner("session-1", "owner-1")!;
    expect(db.cutoverProjectorVersion({
      sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v1",
      expectedCurrentVersion: null, expectedReconciliationEpoch: initial.reconciliationEpoch,
      workItems: [{ id: "v1-a", remoteId: "a", state: "open", payload: { version: "v1" } }],
    })).toBeTrue();
    expect(db.listWorkItemsForOwner("owner-1").map(({ id }) => id)).toEqual(["v1-a"]);

    const v1 = db.getSessionForOwner("session-1", "owner-1")!;
    expect(db.cutoverProjectorVersion({
      sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v2",
      expectedCurrentVersion: "v1", expectedReconciliationEpoch: v1.reconciliationEpoch + 1,
      workItems: [{ id: "failed-v2", remoteId: "b", state: "done", payload: { version: "failed" } }],
    })).toBeFalse();
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM work_items WHERE projector_version = 'v2'").get()).toEqual({ count: 0 });
    expect(db.listWorkItemsForOwner("owner-1").map(({ id }) => id)).toEqual(["v1-a"]);
    expect(db.getSessionForOwner("session-1", "owner-1")?.activeProjectorVersion).toBe("v1");

    expect(db.cutoverProjectorVersion({
      sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v2",
      expectedCurrentVersion: "v1", expectedReconciliationEpoch: v1.reconciliationEpoch,
      workItems: [
        { id: "v2-a", remoteId: "a", state: "done", payload: { version: "v2" } },
        { id: "v2-b", remoteId: "b", state: "open", payload: { version: "v2" } },
      ],
    })).toBeTrue();
    expect(db.listWorkItemsForOwner("owner-1").map(({ id }) => id).sort()).toEqual(["v2-a", "v2-b"]);

    const v2 = db.getSessionForOwner("session-1", "owner-1")!;
    expect(db.cutoverProjectorVersion({
      sessionId: "session-1", ownerId: "owner-1", projectorVersion: "v1",
      expectedCurrentVersion: "v2", expectedReconciliationEpoch: v2.reconciliationEpoch, workItems: [],
    })).toBeTrue();
    expect(db.listWorkItemsForOwner("owner-1").map(({ id }) => id)).toEqual(["v1-a"]);
  });
  test("rejects projector cutover for the wrong owner or archived session without shadow writes", () => {
    const db = database();
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    const session = db.getSessionForOwner("session-1", "owner-1")!;
    const input = { sessionId: "session-1", projectorVersion: "v1", expectedCurrentVersion: null, expectedReconciliationEpoch: session.reconciliationEpoch, workItems: [{ id: "shadow", remoteId: "shadow", state: "done", payload: {} }] };
    expect(db.cutoverProjectorVersion({ ...input, ownerId: "owner-2" })).toBeFalse();
    db.setReconciliation("session-1", "terminal", 1, true, "revision-1");
    db.sqlite.query("UPDATE sessions SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 'session-1'").run();
    db.archiveSessionForOwner({ id: "session-1", ownerId: "owner-1" });
    expect(db.cutoverProjectorVersion({ ...input, ownerId: "owner-1" })).toBeFalse();
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM work_items WHERE id = 'shadow'").get()).toEqual({ count: 0 });
  });
  test("aggregates continuation identity from the origin and lifecycle state from the head", () => {
    const db = database();
    const origin = db.createSession({ id: "origin", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-origin" });
    const head = db.createSession({ id: "head", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-head", continuationParentId: origin.id });
    db.sqlite.query("UPDATE sessions SET title = 'Origin title' WHERE id = ?").run(origin.id);
    db.setReconciliation(head.id, "terminal", 1, true, "head-revision");

    expect(db.getSessionForOwner(head.id, "owner-1")).toMatchObject({
      continuationParentId: origin.id,
      origin: "coordinator-continuation",
    });
    expect(db.getContinuationAggregateForOwner(head.id, "owner-1")).toMatchObject({
      id: origin.id,
      remoteId: "remote-origin",
      title: "Origin title",
      status: "terminal",
      reconciliationEpoch: 1,
      remoteRevision: "head-revision",
    });
  });

  test("keeps single-segment event cursors compatible with local sequence numbers", () => {
    const db = database();
    db.createSession({ id: "origin", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-origin" });
    db.appendEvent("origin", "first", { value: 1 });
    db.appendEvent("origin", "second", { value: 2 });

    expect(db.listEvents("origin").map(({ seq }) => seq)).toEqual([1, 2]);
    expect(db.listEvents("origin", 1).map(({ seq }) => seq)).toEqual([2]);
  });

  test("maps multi-segment local sequences to strictly increasing safe global cursors", () => {
    const db = database();
    db.createSession({ id: "origin", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-origin" });
    db.createSession({ id: "middle", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-middle", continuationParentId: "origin" });
    db.createSession({ id: "head", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-head", continuationParentId: "middle" });
    db.appendEvent("origin", "origin", {});
    db.appendEvent("middle", "middle", {});
    db.appendEvent("head", "head", {});

    const events = db.listEvents("middle");
    expect(events.map(({ seq }) => seq)).toEqual([1, 10_000_001, 20_000_001]);
    expect(events.every(({ seq }) => Number.isSafeInteger(seq))).toBeTrue();
    expect(events.every((event, index) => index === 0 || events[index - 1]!.seq < event.seq)).toBeTrue();
    expect(db.listEvents("origin", 10_000_001).map(({ type }) => type)).toEqual(["head"]);
  });

  test("rejects continuation local sequences outside the global cursor domain", () => {
    const db = database();
    db.createSession({ id: "origin", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-origin" });
    db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, '{}', ?)").run("origin", 10_000_000, "invalid", "2026-01-01T00:00:00.000Z");

    expect(() => db.listEvents("origin")).toThrow("Invalid continuation event sequence");
    expect(() => db.listEvents("origin", Number.MAX_SAFE_INTEGER + 1)).toThrow("Invalid continuation event sequence");
  });

  test("rejects missing, cross-owner, ambiguous, and cyclic continuation lineages", () => {
    const db = database();
    db.createSession({ id: "origin", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-origin" });
    db.createSession({ id: "foreign", ownerId: "owner-2", adapter: "adapter", remoteId: "remote-foreign" });
    expect(() => db.createSession({ id: "missing-child", ownerId: "owner-1", adapter: "adapter", remoteId: "missing-child", continuationParentId: "missing" })).toThrow("Continuation parent must belong");
    expect(() => db.createSession({ id: "foreign-child", ownerId: "owner-1", adapter: "adapter", remoteId: "foreign-child", continuationParentId: "foreign" })).toThrow("Continuation parent must belong");

    db.createSession({ id: "child-a", ownerId: "owner-1", adapter: "adapter", remoteId: "child-a", continuationParentId: "origin" });
    db.createSession({ id: "child-b", ownerId: "owner-1", adapter: "adapter", remoteId: "child-b", continuationParentId: "origin" });
    expect(() => db.listEvents("origin")).toThrow("Ambiguous continuation lineage");

    db.sqlite.query("UPDATE sessions SET continuation_parent_id = ? WHERE id = ?").run("child-a", "origin");
    expect(() => db.listEvents("child-a")).toThrow("Invalid continuation lineage");
  });
  test("enforces owned non-null outbox sessions and bounded redaction", () => {
    const db = database();
    db.createSession({ id: "outbox-session", ownerId: "owner-1", adapter: "adapter", remoteId: "outbox-session" });
    expect(() => db.sqlite.query("INSERT INTO sse_outbox (owner_id, event_json, created_at) VALUES ('owner-1', '{}', 'now')").run()).toThrow();
    expect(() => db.sqlite.query("INSERT INTO sse_outbox (owner_id, session_id, event_json, created_at) VALUES ('owner-1', NULL, '{}', 'now')").run()).toThrow();
    expect(db.enqueueSse("owner-1", { ok: true }, "outbox-session")).toBeGreaterThan(0);
    expect(() => db.enqueueSse("owner-1", { ok: true })).toThrow("SSE requires an owned session");
    expect(redact({ token: "secret", nested: { authorization: "Bearer abc" } }, 1)).toEqual({ token: REDACTED, nested: "[TRUNCATED]" });
  });
  test("recovers persisted command crash points without duplicate remote mutations", async () => {
    const filename = `/tmp/core-dispatcher-${crypto.randomUUID()}.sqlite`;
    const open = (): CoreDatabase => new CoreDatabase(filename);
    const prepare = (db: CoreDatabase, id: string): void => {
      db.createSession({ id: `session-${id}`, ownerId: "owner-1", adapter: "adapter", remoteId: `remote-${id}` });
      db.setReconciliation(`session-${id}`, "active", 1, true, "revision-1");
      db.acceptCommand({ id: `command-${id}`, sessionId: `session-${id}`, idempotencyKey: `request-${id}`, payload: { operation: "send" } });
    };
    const calls: string[] = [];
    const remote = {
      supportsCorrelation: true,
      dispatch: async ({ command }: { command: { id: string } }) => { calls.push(command.id); },
      lookup: async (correlationId: string) => correlationId === "sent" ? "confirmed" as const : "not-found" as const,
    };

    let db = open();
    prepare(db, "before");
    db.close();
    db = open();
    await new DurableCommandDispatcher({ database: db, remote, correlationId: () => "before" }).recover();
    expect(db.getCommand("command-before")?.state).toBe("remote-confirmed");
    expect(calls).toEqual(["command-before"]);
    db.close();

    db = open();
    prepare(db, "after-remote");
    db.claimCommand({ id: "command-after-remote", correlationId: "sent", leaseExpiresAt: "2030-01-01T00:00:00.000Z" });
    db.close();
    db = open();
    await new DurableCommandDispatcher({ database: db, remote }).recover();
    expect(db.getCommand("command-after-remote")?.state).toBe("remote-confirmed");
    expect(calls).toEqual(["command-before"]);
    db.close();

    db = open();
    prepare(db, "after-commit");
    await new DurableCommandDispatcher({ database: db, remote, correlationId: () => "after-commit" }).dispatch("command-after-commit");
    db.close();
    db = open();
    await new DurableCommandDispatcher({ database: db, remote }).recover();
    expect(db.getCommand("command-after-commit")?.state).toBe("remote-confirmed");
    expect(calls).toEqual(["command-before", "command-after-commit"]);
    db.close();

    db = open();
    prepare(db, "unsupported");
    db.claimCommand({ id: "command-unsupported", correlationId: "ambiguous", leaseExpiresAt: "2030-01-01T00:00:00.000Z" });
    db.close();
    db = open();
    await new DurableCommandDispatcher({ database: db, remote: { supportsCorrelation: false, dispatch: async () => { calls.push("unexpected"); } } }).recover();
    expect(db.getCommand("command-unsupported")?.state).toBe("unknown");
    expect(db.sqlite.query("SELECT type FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get("session-unsupported")).toEqual({ type: "command.unknown" });
    expect(calls).toEqual(["command-before", "command-after-commit"]);
    db.close();
    await Bun.file(filename).delete();
  });
  test("atomically publishes owner-scoped mobile state and replays contiguous projections", () => {
    const db = database();
    db.createSession({ id: "session-mobile", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-mobile" });
    db.upsertWorkItem({ id: "work-mobile", ownerId: "owner-1", sessionId: "session-mobile", remoteId: "remote-work", state: "done", payload: { label: "complete" } });
    expect(db.listSseAfter<{ type: string; sessionId: string; payload: { id: string; ownerId: string; sessionId: string; remoteId: string; state: string; projectorVersion: string; payload: { label: string } } }>("owner-1", 0).find(({ event }) => event.type === "work-item.upserted")?.event).toMatchObject({
      type: "work-item.upserted",
      sessionId: "session-mobile",
      payload: {
        id: "work-mobile",
        ownerId: "owner-1",
        sessionId: "session-mobile",
        remoteId: "remote-work",
        state: "done",
        projectorVersion: "legacy",
        payload: { label: "complete" },
      },
    });
    db.appendEvent("session-mobile", "one", {});
    db.appendEvent("session-mobile", "two", {});
    const applied: number[] = [];
    expect(() => db.applyProjection({ sessionId: "session-mobile", ownerId: "owner-2", projectorVersion: "v1", apply: (event) => applied.push(event.seq) })).toThrow();
    expect(applied).toEqual([]);
    expect(db.applyProjection({ sessionId: "session-mobile", ownerId: "owner-1", projectorVersion: "v1", apply: (event) => applied.push(event.seq), effectKey: "fold" })).toBe(2);
    expect(applied).toEqual([1, 2]);
  });
  test("records every out-of-order gap and archives only eligible candidates", () => {
    const db = database();
    db.createSession({ id: "eligible", ownerId: "owner-1", adapter: "adapter", remoteId: "eligible" });
    db.createSession({ id: "blocked", ownerId: "owner-1", adapter: "adapter", remoteId: "blocked" });
    db.createSession({ id: "gap-blocked", ownerId: "owner-1", adapter: "adapter", remoteId: "gap-blocked" });
    for (const id of ["eligible", "blocked", "gap-blocked"]) {
      db.sqlite.query("UPDATE sessions SET source_created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", id);
      db.setReconciliation(id, "terminal", 1, true, "r");
      db.sqlite.query("UPDATE sessions SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    }
    db.createPendingActionForOwner({ id: "blocker", ownerId: "owner-1", sessionId: "blocked", payload: {}, expiresAt: "2030-01-01T00:00:00.000Z" });
    db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES ('gap-blocked', 4, 'four', '{}', '2026-01-01T00:00:04.000Z')").run();
    expect(db.applyProjection({ sessionId: "gap-blocked", ownerId: "owner-1", projectorVersion: "legacy", effectKey: "archive-gap", apply: () => {} })).toBe(0);
    expect(db.listProjectionGaps("gap-blocked").map(({ seq }) => seq)).toEqual([4]);
    expect(db.archiveSessionsBeforeForOwner({ ownerId: "owner-1", sourceCreatedAtBefore: "2027-01-01T00:00:00.000Z" }).map(({ id }) => id)).toEqual(["eligible"]);
    expect(db.getSession("blocked")?.archivedAt).toBeNull();
    expect(db.getSession("gap-blocked")?.archivedAt).toBeNull();
  });
  test("materializes bounded owner-scoped snapshots and cleans expired tokens", () => {
    const db = database();
    db.createSession({ id: "snapshot-session", ownerId: "owner-1", adapter: "adapter", remoteId: "snapshot-remote" });
    db.upsertWorkItem({ id: "snapshot-work", ownerId: "owner-1", sessionId: "snapshot-session", remoteId: "snapshot-work", state: "open", payload: {} });
    db.createPendingActionForOwner({ id: "snapshot-action", ownerId: "owner-1", sessionId: "snapshot-session", payload: {}, expiresAt: "2030-01-01T00:00:00.000Z" });
    db.sqlite.query("INSERT INTO snapshot_tokens VALUES (?, ?, 0, ?, ?)").run("expired", "owner-1", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    const snapshot = db.createMobileSnapshot({ token: "current", ownerId: "owner-1", expiresAt: "2030-01-01T00:00:00.000Z", authorizeSession: ({ id }) => id === "snapshot-session", at: "2026-01-01T00:00:00.000Z", maxRows: 3, maxTokens: 1 });
    expect(snapshot.watermark).toBeDefined();
    expect(db.readSnapshot("current", "owner-1", "2026-01-01T00:00:00.000Z")?.map(({ key }) => key)).toEqual(["action:snapshot-action", "session:snapshot-session", "work:snapshot-work"]);
    expect(db.sqlite.query("SELECT token FROM snapshot_tokens WHERE token = 'expired'").get()).toBeNull();
    db.createMobileSnapshot({ token: "over-quota", ownerId: "owner-1", expiresAt: "2030-01-01T00:00:00.000Z", authorizeSession: () => true, at: "2026-01-01T00:00:00.000Z", maxTokens: 1 });
    expect(db.readSnapshot("current", "owner-1", "2026-01-01T00:00:00.000Z")).toBeNull();
    expect(db.readSnapshot("over-quota", "owner-1", "2026-01-01T00:00:00.000Z")).not.toBeNull();
  });
  test("evicts the deterministic oldest token at the default owner quota without affecting other owners", () => {
    const db = database();
    db.createSession({ id: "snapshot-session", ownerId: "owner-1", adapter: "adapter", remoteId: "snapshot-remote" });
    const create = (token: string, ownerId = "owner-1") => db.createMobileSnapshot({ token, ownerId, expiresAt: "2030-01-01T00:00:00.000Z", authorizeSession: () => true, at: "2026-01-01T00:00:00.000Z" });
    create("owner-2-token", "owner-2");
    create("token-1");
    create("token-2");
    create("token-3");
    create("token-4");
    expect(db.sqlite.query("SELECT token FROM snapshot_tokens WHERE owner_id = ? ORDER BY token").all("owner-1")).toEqual([{ token: "token-2" }, { token: "token-3" }, { token: "token-4" }]);
    expect(db.readSnapshot("token-1", "owner-1", "2026-01-01T00:00:00.000Z")).toBeNull();
    expect(db.sqlite.query("SELECT * FROM snapshot_rows WHERE token = ?").all("token-1")).toEqual([]);
    expect(db.readSnapshot("owner-2-token", "owner-2", "2026-01-01T00:00:00.000Z")).not.toBeNull();
  });
  test("evaluates snapshot authorization in its transaction and excludes denied rows", () => {
    const db = database();
    for (const id of ["allowed", "denied"]) {
      db.createSession({ id, ownerId: "owner-1", adapter: "adapter", remoteId: id });
      db.upsertWorkItem({ id: `work-${id}`, ownerId: "owner-1", sessionId: id, remoteId: id, state: "open", payload: {} });
      db.createPendingActionForOwner({ id: `action-${id}`, ownerId: "owner-1", sessionId: id, payload: {}, expiresAt: "2030-01-01T00:00:00.000Z" });
    }
    let allow = new Set(["allowed"]);
    const authorizeSession = ({ id }: { id: string }) => allow.has(id);
    db.createMobileSnapshot({ token: "allowed-only", ownerId: "owner-1", expiresAt: "2030-01-01T00:00:00.000Z", authorizeSession, at: "2026-01-01T00:00:00.000Z" });
    expect(db.readSnapshot("allowed-only", "owner-1", "2026-01-01T00:00:00.000Z")?.map(({ key }) => key)).toEqual(["action:action-allowed", "session:allowed", "work:work-allowed"]);
    allow = new Set(["denied"]);
    db.createMobileSnapshot({ token: "denied-only", ownerId: "owner-1", expiresAt: "2030-01-01T00:00:00.000Z", authorizeSession, at: "2026-01-01T00:00:00.000Z" });
    expect(db.readSnapshot("denied-only", "owner-1", "2026-01-01T00:00:00.000Z")?.map(({ key }) => key)).toEqual(["action:action-denied", "session:denied", "work:work-denied"]);
    db.sqlite.exec("CREATE TRIGGER reject_snapshot_row BEFORE INSERT ON snapshot_rows WHEN NEW.row_key = 'work:work-allowed' BEGIN SELECT RAISE(ABORT, 'insertion failed'); END");
    expect(() => db.createMobileSnapshot({ token: "rollback", ownerId: "owner-1", expiresAt: "2030-01-01T00:00:00.000Z", authorizeSession: ({ id }) => id === "allowed", at: "2026-01-01T00:00:00.000Z" })).toThrow("insertion failed");
    expect(db.sqlite.query("SELECT * FROM snapshot_tokens WHERE token = 'rollback'").get()).toBeNull();
    expect(db.sqlite.query("SELECT * FROM snapshot_rows WHERE token = 'rollback'").get()).toBeNull();
  });
  test("uses the 5,000-row default mobile snapshot quota", () => {
    const db = database();
    const insert = db.sqlite.query("INSERT INTO sessions (id, owner_id, adapter, remote_id, status, created_at, updated_at) VALUES (?, 'owner-1', 'adapter', ?, 'active', 'now', 'now')");
    for (let index = 0; index < 5_000; index++) insert.run(`snapshot-default-${index}`, `remote-${index}`);
    expect(() => db.createMobileSnapshot({ token: "exact-default", ownerId: "owner-1", expiresAt: "2030-01-01T00:00:00.000Z", authorizeSession: () => true, at: "2026-01-01T00:00:00.000Z" })).not.toThrow();
    insert.run("snapshot-default-over", "remote-over");
    expect(() => db.createMobileSnapshot({ token: "over-default", ownerId: "owner-1", expiresAt: "2030-01-01T00:00:00.000Z", authorizeSession: () => true, at: "2026-01-01T00:00:00.000Z" })).toThrow("Snapshot row quota exceeded");
  });
  test("retains bounded owner-scoped SSE cursors and returns session ids", () => {
    const db = database();
    db.createSession({ id: "sse-session", ownerId: "owner-1", adapter: "adapter", remoteId: "sse-session" });
    for (let i = 0; i <= 10_000; i++) db.enqueueSse("owner-1", { i }, "sse-session");
    const rows = db.listSseAfter<{ i: number }>("owner-1", 0, 1_000);
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM sse_outbox WHERE owner_id = ?").get("owner-1")).toEqual({ count: 10_000 });
    expect(rows[0]).toMatchObject({ sessionId: "sse-session", event: { i: 1 } });
    expect(db.minimumRetainedSseCursor("owner-1")).toBe(rows[0]!.id - 1);
  });
  test("filters denied SSE session rows before applying the page limit", () => {
    const db = database();
    db.createSession({ id: "denied", ownerId: "owner-1", adapter: "adapter", remoteId: "denied" });
    db.createSession({ id: "allowed", ownerId: "owner-1", adapter: "adapter", remoteId: "allowed" });
    db.sqlite.query("DELETE FROM sse_outbox").run();
    for (let i = 0; i < 100; i++) db.enqueueSse("owner-1", { i }, "denied");
    db.enqueueSse("owner-1", { allowed: true }, "allowed");
    expect(db.listSseAfter<{ allowed?: boolean }>("owner-1", 0, ["allowed"], 1)).toEqual([
      expect.objectContaining({ sessionId: "allowed", event: { allowed: true } }),
    ]);
  });
  test("replays persisted seq4 before seq1 through seq5 without redelivery", () => {
    const db = database();
    db.createSession({ id: "replay", ownerId: "owner-1", adapter: "adapter", remoteId: "replay" });
    const insert = db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, '{}', ?)");
    insert.run("replay", 4, "four", "2026-01-01T00:00:04.000Z");
    const applied: number[] = [];
    const project = () => db.applyProjection({ sessionId: "replay", ownerId: "owner-1", projectorVersion: "v1", effectKey: "fold", apply: (event) => applied.push(event.seq) });
    expect(project()).toBe(0);
    for (const seq of [1, 2, 3]) insert.run("replay", seq, String(seq), `2026-01-01T00:00:0${seq}.000Z`);
    expect(project()).toBe(4);
    insert.run("replay", 5, "five", "2026-01-01T00:00:05.000Z");
    expect(project()).toBe(1);
    expect(project()).toBe(0);
    expect(applied).toEqual([1, 2, 3, 4, 5]);
    expect(db.getProjectionCheckpoint("replay", "v1").nextExpectedSeq).toBe(6);
  });
  test("cannot advance a projection without an event, fold, and committed effect", () => {
    const db = database();
    db.createSession({ id: "projection-contract", ownerId: "owner-1", adapter: "adapter", remoteId: "projection-contract" });
    expect("advanceProjectionCheckpoint" in (db as unknown as Record<string, unknown>)).toBeFalse();

    let folds = 0;
    expect(db.applyProjection({ sessionId: "projection-contract", ownerId: "owner-1", projectorVersion: "v1", effectKey: "contract", apply: () => { folds++; } })).toBe(0);
    expect(folds).toBe(0);
    expect(db.getProjectionCheckpoint("projection-contract", "v1").nextExpectedSeq).toBe(1);
    expect(db.listProjectionGaps("projection-contract", "v1")).toEqual([]);
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM projection_effects WHERE session_id = ? AND projector_version = ?").get("projection-contract", "v1")).toEqual({ count: 0 });

    db.appendEvent("projection-contract", "created", {});
    expect(db.applyProjection({ sessionId: "projection-contract", ownerId: "owner-1", projectorVersion: "v1", effectKey: "contract", apply: () => { throw new Error("fold failed"); } })).toBe(0);
    expect(db.getProjectionCheckpoint("projection-contract", "v1").nextExpectedSeq).toBe(1);
    expect(db.listProjectionGaps("projection-contract", "v1")).toEqual([]);
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM projection_effects WHERE session_id = ? AND projector_version = ?").get("projection-contract", "v1")).toEqual({ count: 0 });
  });
  test("rolls back nested work folds when a projection effect fails", () => {
    const db = database();
    db.createSession({ id: "nested-fold", ownerId: "owner-1", adapter: "adapter", remoteId: "nested-fold" });
    db.appendEvent("nested-fold", "created", { title: "Fold" });

    expect(db.applyProjection({
      sessionId: "nested-fold",
      ownerId: "owner-1",
      projectorVersion: "v1",
      effectKey: "nested-fold",
      apply: () => {
        db.upsertWorkItem({ id: "nested-work", ownerId: "owner-1", sessionId: "nested-fold", remoteId: "nested", state: "open", payload: {}, projectorVersion: "v1" });
        throw new Error("fold failed after work write");
      },
    })).toBe(0);

    expect(db.getProjectionCheckpoint("nested-fold", "v1").nextExpectedSeq).toBe(1);
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM projection_effects WHERE session_id = ? AND projector_version = ?").get("nested-fold", "v1")).toEqual({ count: 0 });
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM work_items WHERE session_id = ? AND projector_version = ?").get("nested-fold", "v1")).toEqual({ count: 0 });
    expect(db.getSession("nested-fold")?.activeProjectorVersion).toBeNull();
  });
  test("rejects secrets nested beyond the display cap and in sink payloads", () => {
    const db = database();
    db.createSession({ id: "secret-session", ownerId: "owner-1", adapter: "adapter", remoteId: "secret-session" });
    expect(() => db.enqueueSse("owner-1", { nested: { authorization: "Bearer secret-token" } }, "secret-session")).toThrow("Secret-like key");
    expect(() => db.enqueueSse("owner-1", Array.from({ length: 101 }, (_, index) => index === 100 ? { token: "secret" } : index), "secret-session")).toThrow("Secret-like key");
  });
test("repairs legacy backfill jobs into the resumable constrained shape", async () => {
  const filename = `/tmp/core-backfill-migration-${crypto.randomUUID()}.sqlite`;
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE backfill_jobs (
      name TEXT PRIMARY KEY, cursor_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','running','complete')),
      attempts INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT,
      error TEXT, updated_at TEXT NOT NULL
    );
  `);
  legacy.query("INSERT INTO backfill_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "legacy", '{"offset":3}', "running", 2, "2026-01-01T00:00:00.000Z", null, null, "2026-01-01T01:00:00.000Z",
  );
  legacy.close();

  try {
    let db = new CoreDatabase(filename);
    expect(db.sqlite.query("SELECT cursor_json, state, attempts, started_at, paused_at, failed_at FROM backfill_jobs WHERE name = ?").get("legacy")).toEqual({
      cursor_json: '{"offset":3}', state: "running", attempts: 2, started_at: "2026-01-01T00:00:00.000Z", paused_at: null, failed_at: null,
    });
    db.sqlite.query("UPDATE backfill_jobs SET state = 'paused', paused_at = ? WHERE name = ?").run("2026-01-01T02:00:00.000Z", "legacy");
    db.close();

    db = new CoreDatabase(filename);
    expect(db.sqlite.query("SELECT state, paused_at FROM backfill_jobs WHERE name = ?").get("legacy")).toEqual({
      state: "paused", paused_at: "2026-01-01T02:00:00.000Z",
    });
    db.sqlite.query("UPDATE backfill_jobs SET state = 'running', paused_at = NULL WHERE name = ?").run("legacy");
    expect(db.sqlite.query("SELECT state FROM backfill_jobs WHERE name = ?").get("legacy")).toEqual({ state: "running" });
    db.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
test("preserves the pending-actions-owner lifecycle across reopening", async () => {
  const filename = `/tmp/core-backfill-lifecycle-${crypto.randomUUID()}.sqlite`;
  try {
    let db = new CoreDatabase(filename);
    const cases = [
      ["running", "2026-01-01T00:00:00.000Z", null, null, null],
      ["paused", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z", null, null],
      ["failed", "2026-01-01T00:00:00.000Z", null, null, "2026-01-01T02:00:00.000Z"],
      ["complete", "2026-01-01T00:00:00.000Z", null, "2026-01-01T03:00:00.000Z", null],
    ] as const;
    for (const [state, startedAt, pausedAt, completedAt, failedAt] of cases) {
      const seed = db.sqlite.query("UPDATE backfill_jobs SET cursor_json = ?, state = ?, attempts = ?, started_at = ?, paused_at = ?, completed_at = ?, failed_at = ?, error = ?, updated_at = ? WHERE name = 'pending-actions-owner'");
      seed.run('{"cursor":7}', state, 3, startedAt, pausedAt, completedAt, failedAt, failedAt ? "failed safely" : null, "2026-01-01T04:00:00.000Z");
      db.close();
      db = new CoreDatabase(filename);
      expect(db.sqlite.query("SELECT cursor_json, state, attempts, started_at, paused_at, completed_at, failed_at, error, updated_at FROM backfill_jobs WHERE name = 'pending-actions-owner'").get()).toEqual({
        cursor_json: '{"cursor":7}', state, attempts: 3, started_at: startedAt, paused_at: pausedAt, completed_at: completedAt, failed_at: failedAt, error: failedAt ? "failed safely" : null, updated_at: "2026-01-01T04:00:00.000Z",
      });
    }
    db.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
test("redacts diagnostic secrets before persistence", () => {
  const db = database();
  db.createSession({ id: "diagnostic", ownerId: "owner-1", adapter: "adapter", remoteId: "diagnostic" });
  db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, 1, 'x', '{}', ?)").run("diagnostic", new Date().toISOString());
  expect(db.applyProjection({ sessionId: "diagnostic", ownerId: "owner-1", projectorVersion: "v1", apply: () => { throw new Error("Bearer secret-value"); } })).toBe(0);
  expect(db.listProjectionFailures("diagnostic", "v1")[0]!.reason).toBe("[REDACTED DIAGNOSTIC]");
  db.startBackfillJob("diagnostic");
  db.failBackfillJob("diagnostic", "token=secret-value");
  expect(db.getBackfillJob("diagnostic")!.error).toBe("[REDACTED DIAGNOSTIC]");
  const audit = db.writeAudit({ action: "diagnostic", payload: "api_key=secret-value" });
  expect(audit.payload).toBe("[REDACTED DIAGNOSTIC]");
});
test("redacts persisted diagnostics by primary key when reopening", async () => {
  const filename = `/tmp/core-diagnostic-redaction-${crypto.randomUUID()}.sqlite`;
  try {
    let db = new CoreDatabase(filename);
    const timestamp = "2026-01-01T00:00:00.000Z";
    db.createSession({ id: "diagnostic", ownerId: "owner-1", adapter: "adapter", remoteId: "diagnostic" });
    db.sqlite.query("INSERT INTO projection_failures (session_id, projector_version, seq, reason, failed_at) VALUES (?, ?, ?, ?, ?)").run("diagnostic", "v1", 1, "token=secret-value", timestamp);
    db.sqlite.query("INSERT INTO backfill_jobs (name, cursor_json, state, error, updated_at) VALUES (?, '{}', 'failed', ?, ?)").run("diagnostic", "Bearer secret-value", timestamp);
    db.sqlite.query("INSERT INTO backfill_jobs (name, cursor_json, state, error, updated_at) VALUES (?, '{}', 'complete', NULL, ?)").run("no-error", timestamp);
    db.sqlite.query("INSERT INTO corrupt_payloads (record_type, record_id, payload_column, payload_json, detected_at) VALUES (?, ?, ?, ?, ?)").run("event", "diagnostic:1", "payload_json", "api_key=secret-value", timestamp);
    db.close();

    db = new CoreDatabase(filename);
    const diagnostics = db.sqlite.query(`
      SELECT reason AS value FROM projection_failures
      UNION ALL SELECT error FROM backfill_jobs WHERE name = 'diagnostic'
      UNION ALL SELECT payload_json FROM corrupt_payloads
    `).all() as Array<{ value: string }>;
    expect(diagnostics).toEqual([
      { value: "[REDACTED DIAGNOSTIC]" },
      { value: "[REDACTED DIAGNOSTIC]" },
      { value: "[REDACTED DIAGNOSTIC]" },
    ]);
    expect(db.sqlite.query("SELECT error FROM backfill_jobs WHERE name = 'no-error'").get()).toEqual({ error: null });
    expect(JSON.stringify(diagnostics)).not.toContain("secret-value");
    db.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
test("applies the phase-0 migration idempotently across repeated opens", async () => {
  const filename = `/tmp/core-phase0-migration-${crypto.randomUUID()}.sqlite`;
  try {
    let db = new CoreDatabase(filename);
    db.sqlite.query("INSERT INTO sessions (id, owner_id, adapter, remote_id, status, created_at, updated_at) VALUES ('session-1', 'owner-1', 'gjc', 'remote-1', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    expect(db.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.sqlite.query("SELECT version, name FROM schema_migrations").all()).toEqual([
      { version: 1, name: "phase-0-runtime-foundation" },
    ]);
    expect(db.sqlite.query("SELECT name, min_version, active FROM schema_fence ORDER BY name").all()).toEqual([
      { name: "min_binary_version", min_version: 1, active: 1 },
      { name: "phase-0-runtime-foundation", min_version: 1, active: 1 },
    ]);
    db.close();

    db = new CoreDatabase(filename);
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    expect(db.sqlite.query("SELECT id, control_mode, origin, transcript_status FROM sessions").all()).toEqual([
      { id: "session-1", control_mode: "view-only", origin: "ondisk-discovery", transcript_status: "available" },
    ]);
    expect(db.sqlite.query("SELECT min_version, active FROM schema_fence WHERE name = 'min_binary_version'").get()).toEqual({ min_version: 1, active: 1 });
    db.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
test("guard self-test reads the Core minimum binary version fence", async () => {
  const filename = `/tmp/core-schema-fence-${crypto.randomUUID()}.sqlite`;
  try {
    const db = new CoreDatabase(filename);
    db.close();

    const guard = new URL("../../../deploy/hub-guarded-launch.sh", import.meta.url).pathname;
    expect(Bun.spawnSync({ cmd: ["sh", guard, "--self-test", filename, "1"] }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["sh", guard, "--self-test", filename, "0"] }).exitCode).toBe(1);
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
test("rebuilds legacy sse outbox rows with owners and preserves their ids", async () => {
  const filename = `/tmp/core-sse-outbox-migration-${crypto.randomUUID()}.sqlite`;
  try {
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, owner_id TEXT, adapter TEXT NOT NULL, remote_id TEXT NOT NULL,
        status TEXT NOT NULL, reconciliation_epoch INTEGER NOT NULL DEFAULT 0,
        reconciled INTEGER NOT NULL DEFAULT 0, remote_revision TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(adapter, remote_id)
      );
      CREATE TABLE sse_outbox (
        id INTEGER PRIMARY KEY, session_id TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    legacy.query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "owner-1", "adapter", "remote-1", "active", 0, 0, null, "now", "now");
    legacy.query("INSERT INTO sse_outbox VALUES (?, ?, ?, ?)").run(7, "session-1", '{"type":"first"}', "2026-01-01T00:00:00.000Z");
    legacy.query("INSERT INTO sse_outbox VALUES (?, ?, ?, ?)").run(9, "session-1", '{"type":"second"}', "2026-01-01T00:00:01.000Z");
    legacy.close();

    const db = new CoreDatabase(filename);
    expect(db.sqlite.query("SELECT id, owner_id, session_id, event_json FROM sse_outbox ORDER BY id").all()).toEqual([
      { id: 7, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"first"}' },
      { id: 9, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"second"}' },
    ]);
    expect(db.sqlite.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sse_outbox'").get()).toMatchObject({ sql: expect.stringContaining("owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0)") });
    expect(db.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sse_outbox_owner_id_idx'").get()).toEqual({ name: "sse_outbox_owner_id_idx" });
    db.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
test("requires manual repair for unresolved legacy sse outbox ownership before rebuilding", async () => {
  const filename = `/tmp/core-sse-outbox-owner-rebuild-${crypto.randomUUID()}.sqlite`;
  try {
    const seeded = new CoreDatabase(filename);
    seeded.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    seeded.close();
    const legacy = new Database(filename);
    legacy.exec(`
      INSERT INTO sessions (id, owner_id, adapter, remote_id, status, created_at, updated_at)
      VALUES ('session-unowned', NULL, 'adapter', 'remote-unowned', 'active', 'now', 'now');
      ALTER TABLE sse_outbox RENAME TO sse_outbox_old;
      CREATE TABLE sse_outbox (id INTEGER PRIMARY KEY, owner_id TEXT, session_id TEXT, event_json TEXT, created_at TEXT);
      INSERT INTO sse_outbox VALUES
        (7, 'owner-1', 'session-1', '{"type":"valid"}', '2026-01-01T00:00:00.000Z'),
        (9, 'owner-2', 'session-1', '{"type":"cross-owner"}', '2026-01-01T00:00:01.000Z'),
        (11, 'owner-1', NULL, '{"type":"no-session"}', '2026-01-01T00:00:02.000Z'),
        (13, 'owner-1', 'missing-session', '{"type":"missing-session"}', '2026-01-01T00:00:03.000Z'),
        (15, '', 'session-unowned', '{"type":"unowned-session"}', '2026-01-01T00:00:04.000Z');
      DROP TABLE sse_outbox_old;
    `);
    const originalSql = (legacy.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sse_outbox'").get() as { sql: string }).sql;
    legacy.close();

    expect(() => new CoreDatabase(filename)).toThrow("manual repair required");

    const unrepaired = new Database(filename);
    expect((unrepaired.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sse_outbox'").get() as { sql: string }).sql).toBe(originalSql);
    expect(unrepaired.query("SELECT id, owner_id, session_id, event_json, created_at FROM sse_outbox ORDER BY id").all()).toEqual([
      { id: 7, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"valid"}', created_at: "2026-01-01T00:00:00.000Z" },
      { id: 9, owner_id: "owner-2", session_id: "session-1", event_json: '{"type":"cross-owner"}', created_at: "2026-01-01T00:00:01.000Z" },
      { id: 11, owner_id: "owner-1", session_id: null, event_json: '{"type":"no-session"}', created_at: "2026-01-01T00:00:02.000Z" },
      { id: 13, owner_id: "owner-1", session_id: "missing-session", event_json: '{"type":"missing-session"}', created_at: "2026-01-01T00:00:03.000Z" },
      { id: 15, owner_id: "", session_id: "session-unowned", event_json: '{"type":"unowned-session"}', created_at: "2026-01-01T00:00:04.000Z" },
    ]);
    expect(unrepaired.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sse_outbox_legacy'").get()).toBeNull();
    unrepaired.exec(`
      UPDATE sessions SET owner_id = 'owner-1' WHERE id = 'session-unowned';
      UPDATE sse_outbox SET owner_id = 'owner-1', session_id = 'session-1' WHERE id IN (9, 11, 13, 15);
    `);
    unrepaired.close();

    const repaired = new CoreDatabase(filename);
    expect(repaired.sqlite.query("SELECT id, owner_id, session_id, event_json FROM sse_outbox ORDER BY id").all()).toEqual([
      { id: 7, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"valid"}' },
      { id: 9, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"cross-owner"}' },
      { id: 11, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"no-session"}' },
      { id: 13, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"missing-session"}' },
      { id: 15, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"unowned-session"}' },
    ]);
    expect(repaired.sqlite.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sse_outbox'").get()).toMatchObject({ sql: expect.stringContaining("owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0)") });
    repaired.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
test("rolls back ownerless legacy sse outbox migration before manual repair", async () => {
  const filename = `/tmp/core-sse-outbox-ownerless-${crypto.randomUUID()}.sqlite`;
  try {
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, owner_id TEXT, adapter TEXT NOT NULL, remote_id TEXT NOT NULL,
        status TEXT NOT NULL, reconciliation_epoch INTEGER NOT NULL DEFAULT 0,
        reconciled INTEGER NOT NULL DEFAULT 0, remote_revision TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(adapter, remote_id)
      );
      CREATE TABLE sse_outbox (
        id INTEGER PRIMARY KEY, session_id TEXT, event_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    legacy.query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "owner-1", "adapter", "remote-1", "active", 0, 0, null, "now", "now");
    legacy.query("INSERT INTO sse_outbox VALUES (?, ?, ?, ?)").run(7, "session-1", '{"type":"valid"}', "2026-01-01T00:00:00.000Z");
    legacy.query("INSERT INTO sse_outbox VALUES (?, ?, ?, ?)").run(9, null, '{"type":"unresolved"}', "2026-01-01T00:00:01.000Z");
    const originalSql = (legacy.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sse_outbox'").get() as { sql: string }).sql;
    legacy.close();

    expect(() => new CoreDatabase(filename)).toThrow("manual repair required");

    const unrepaired = new Database(filename);
    expect((unrepaired.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sse_outbox'").get() as { sql: string }).sql).toBe(originalSql);
    expect(originalSql).not.toContain("owner_id");
    expect(unrepaired.query("SELECT id, session_id, event_json, created_at FROM sse_outbox ORDER BY id").all()).toEqual([
      { id: 7, session_id: "session-1", event_json: '{"type":"valid"}', created_at: "2026-01-01T00:00:00.000Z" },
      { id: 9, session_id: null, event_json: '{"type":"unresolved"}', created_at: "2026-01-01T00:00:01.000Z" },
    ]);
    expect(unrepaired.query("SELECT name FROM sqlite_master WHERE name GLOB 'sse_outbox_*'").all()).toEqual([]);
    unrepaired.exec(`
      ALTER TABLE sse_outbox ADD COLUMN owner_id TEXT;
      UPDATE sse_outbox SET owner_id = 'owner-1', session_id = 'session-1' WHERE id = 9;
    `);
    unrepaired.close();

    const repaired = new CoreDatabase(filename);
    expect(repaired.sqlite.query("SELECT id, owner_id, session_id, event_json FROM sse_outbox ORDER BY id").all()).toEqual([
      { id: 7, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"valid"}' },
      { id: 9, owner_id: "owner-1", session_id: "session-1", event_json: '{"type":"unresolved"}' },
    ]);
    repaired.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
test("preflight rebuilds malformed work items, quarantines bad ownership, and preserves stable rows", async () => {
  const filename = `/tmp/core-preflight-${crypto.randomUUID()}.sqlite`;
  try {
    const seeded = new CoreDatabase(filename);
    seeded.createSession({ id: "session-1", ownerId: "owner-1", adapter: "adapter", remoteId: "remote-1" });
    seeded.close();
    const legacy = new Database(filename);
    legacy.exec(`
      ALTER TABLE work_items RENAME TO work_items_old;
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_id TEXT NOT NULL,
        remote_id TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
        projector_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO work_items VALUES
        ('valid', 'owner-1', 'session-1', 'remote', 'open', '{}', 'legacy', 'now', 'now'),
        ('bad-owner', '', 'session-1', 'other', 'open', '{}', 'legacy', 'now', 'now'),
        ('bad-fk', 'owner-1', 'missing', 'third', 'open', '{}', 'legacy', 'now', 'now');
      DROP TABLE work_items_old;
    `);
    legacy.close();

    const repaired = new CoreDatabase(filename);
    expect(repaired.sqlite.query("SELECT id FROM work_items ORDER BY id").all()).toEqual([{ id: "valid" }]);
    expect(repaired.sqlite.query("SELECT record_id FROM corrupt_payloads WHERE record_type = 'work_items' ORDER BY record_id").all()).toEqual([{ record_id: "bad-fk" }, { record_id: "bad-owner" }]);
    repaired.close();
    const reopened = new CoreDatabase(filename);
    expect(reopened.sqlite.query("SELECT id FROM work_items").all()).toEqual([{ id: "valid" }]);
    reopened.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
  test("archives with grace, cursor metadata, and quarantines late events until reopened", () => {
    const db = database();
    db.createSession({ id: "archive-contract", ownerId: "owner-1", adapter: "adapter", remoteId: "archive-contract" });
    db.appendEvent("archive-contract", "created", {});
    db.setReconciliation("archive-contract", "terminal", 1, true, "revision-1");
    expect(db.canArchiveSessionForOwner("archive-contract", "owner-1").blockers).toContain("grace-period");
    expect(db.applyProjection({ sessionId: "archive-contract", ownerId: "owner-1", projectorVersion: "legacy", effectKey: "archive", apply: () => {} })).toBe(1);
    db.sqlite.query("UPDATE sessions SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run("archive-contract");
    db.archiveSessionForOwner({ id: "archive-contract", ownerId: "owner-1", archivedAt: "2026-01-02T00:00:00.000Z" });
    expect(db.sqlite.query("SELECT archive_reason, archive_cursor_seq FROM sessions WHERE id = ?").get("archive-contract")).toEqual({ archive_reason: "manual", archive_cursor_seq: 2 });
    db.appendEvent("archive-contract", "late", {});
    expect(db.sqlite.query("SELECT seq, reason, state FROM late_event_quarantine WHERE session_id = ?").all("archive-contract")).toEqual([{ seq: 2, reason: "late-event", state: "quarantined" }]);
    expect(db.applyProjection({ sessionId: "archive-contract", ownerId: "owner-1", projectorVersion: "legacy", apply: () => { throw new Error("must not fold"); } })).toBe(0);
    db.unarchiveSessionForOwner({ id: "archive-contract", ownerId: "owner-1" });
    expect(db.sqlite.query("SELECT archive_reason, archive_cursor_seq FROM sessions WHERE id = ?").get("archive-contract")).toEqual({ archive_reason: null, archive_cursor_seq: null });
    expect(db.sqlite.query("SELECT state FROM late_event_quarantine WHERE session_id = ?").get("archive-contract")).toEqual({ state: "reopened" });
  });
  test("records the observed out-of-order sequence and resolves it on replay", () => {
    const db = database();
    db.createSession({ id: "high-seq", ownerId: "owner-1", adapter: "adapter", remoteId: "high-seq" });
    const insert = db.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES ('high-seq', ?, 'event', '{}', ?)");
    const applied: number[] = [];
    const project = () => db.applyProjection({ sessionId: "high-seq", ownerId: "owner-1", projectorVersion: "legacy", effectKey: "high-seq", apply: (event) => applied.push(event.seq) });
    insert.run(3, "2026-01-01T00:00:03.000Z");
    expect(project()).toBe(0);
    expect(db.listProjectionGaps("high-seq")).toMatchObject([{ seq: 3, reason: "out-of-order", resolvedAt: null }]);
    insert.run(1, "2026-01-01T00:00:01.000Z");
    insert.run(2, "2026-01-01T00:00:02.000Z");
    expect(project()).toBe(3);
    expect(applied).toEqual([1, 2, 3]);
    expect(db.listProjectionGaps("high-seq")[0]?.resolvedAt).toEqual(expect.any(String));
  });
  test("fails closed for required adapters without a run and accepts terminal evidence", () => {
    const db = database();
    db.createHierarchyBackfillSnapshot("owner-h", 1, 1, ["gjc"]);
    expect(db.hierarchyCoverageGapCount("owner-h", 1, 1)).toBe(1);
    db.upsertHierarchyBackfillRun({ ownerId: "owner-h", adapter: "gjc", epoch: 1, cycle: 1, state: "enumerating", expectedSourceKeys: 1, observedSourceKeys: 0, frozenAt: null });
    db.addHierarchyBackfillManifestEntry("owner-h", "gjc", 1, 1, "broken");
    db.upsertHierarchyBackfillRun({ ownerId: "owner-h", adapter: "gjc", epoch: 1, cycle: 1, state: "complete", expectedSourceKeys: 1, observedSourceKeys: 1, frozenAt: "2026-01-01T00:00:00.000Z" });
    db.upsertSessionHierarchyEvidence({ ownerId: "owner-h", adapter: "gjc", sourceKey: "broken", sessionId: "hidden", identityNamespace: "gjc", observedParentSessionId: null, observedParentOwnerId: null, directHumanEvidence: false, structuralKind: "subagent", observationState: "unreadable", capturedEpoch: 1, deletedAt: null });
    db.freezeHierarchyBackfillSnapshot("owner-h", 1, 1);
    expect(db.hierarchyCoverageGapCount("owner-h", 1, 1)).toBe(0);
  });
  test("keeps frozen cycles and runs immutable", () => {
    const db = database();
    db.createHierarchyBackfillSnapshot("owner-frozen", 1, 1, ["gjc"]);
    db.upsertHierarchyBackfillRun({ ownerId: "owner-frozen", adapter: "gjc", epoch: 1, cycle: 1, state: "complete", expectedSourceKeys: 0, observedSourceKeys: 0, frozenAt: "2026-01-01T00:00:00.000Z" });
    expect(() => db.upsertHierarchyBackfillRun({ ownerId: "owner-frozen", adapter: "gjc", epoch: 1, cycle: 1, state: "complete", expectedSourceKeys: 1, observedSourceKeys: 1, frozenAt: "2026-01-01T00:00:00.000Z" })).toThrow("immutable");
    db.freezeHierarchyBackfillSnapshot("owner-frozen", 1, 1);
    expect(() => db.upsertHierarchyBackfillRun({ ownerId: "owner-frozen", adapter: "late", epoch: 1, cycle: 1, state: "enumerating", expectedSourceKeys: 0, observedSourceKeys: 0, frozenAt: null })).toThrow("immutable");
    expect(() => db.upsertHierarchyBackfillRun({ ownerId: "owner-frozen", adapter: "gjc", epoch: 1, cycle: 1, state: "complete", expectedSourceKeys: 1, observedSourceKeys: 1, frozenAt: "2026-01-01T00:00:00.000Z" })).toThrow("immutable");
  });
  test("refuses to freeze a snapshot missing a required run", () => {
    const db = database();
    db.createHierarchyBackfillSnapshot("owner-missing", 1, 1, ["gjc"]);
    expect(() => db.freezeHierarchyBackfillSnapshot("owner-missing", 1, 1)).toThrow("required backfill run");
  });
  test("counts only non-continuation internal failure statuses in hierarchy rollups", () => {
    const db = database();
    db.createSession({ id: "rollup-root", ownerId: "owner-rollup", adapter: "adapter", remoteId: "root" });
    db.createSession({ id: "rollup-internal", ownerId: "owner-rollup", adapter: "adapter", remoteId: "internal" });
    db.createSession({ id: "rollup-continuation", ownerId: "owner-rollup", adapter: "adapter", remoteId: "continuation", continuationParentId: "rollup-root" });
    db.sqlite.query("UPDATE sessions SET status='stale' WHERE id='rollup-root'").run();
    db.sqlite.query("UPDATE sessions SET status='unknown' WHERE id='rollup-internal'").run();
    db.sqlite.query("UPDATE sessions SET status='stale' WHERE id='rollup-continuation'").run();
    db.projectSessionHierarchy("owner-rollup", 1, [
      { ownerId: "owner-rollup", generation: 1, sessionId: "rollup-root", kind: "root", rootSessionId: "rollup-root", parentSessionId: null, unknownReason: null, lineageKind: "direct", internalKind: null, subagentIdentity: null },
      { ownerId: "owner-rollup", generation: 1, sessionId: "rollup-internal", kind: "internal", rootSessionId: "rollup-root", parentSessionId: "rollup-root", unknownReason: null, lineageKind: "direct", internalKind: null, subagentIdentity: null },
      { ownerId: "owner-rollup", generation: 1, sessionId: "rollup-continuation", kind: "internal", rootSessionId: "rollup-root", parentSessionId: "rollup-root", unknownReason: null, lineageKind: "continuation", internalKind: null, subagentIdentity: null },
    ]);
    expect(db.hierarchyRollups("owner-rollup", 1)).toMatchObject([{ rootSessionId: "rollup-root", failureCount: 1 }]);
  });
  test("retains generations held by an in-process lease", () => {
    const db = database();
    db.projectSessionHierarchy("owner-h", 1, [{ ownerId: "owner-h", generation: 1, sessionId: "root", kind: "root", rootSessionId: "root", parentSessionId: null, unknownReason: null, lineageKind: "direct", internalKind: null, subagentIdentity: null }]);
    const lease = db.acquireGenerationLease("owner-h");
    db.projectSessionHierarchy("owner-h", 2, [{ ownerId: "owner-h", generation: 2, sessionId: "root-2", kind: "root", rootSessionId: "root-2", parentSessionId: null, unknownReason: null, lineageKind: "direct", internalKind: null, subagentIdentity: null }]);
    expect(db.pruneOldGenerations("owner-h")).toBe(0);
    db.releaseGenerationLease("owner-h", lease);
    expect(db.pruneOldGenerations("owner-h")).toBe(1);
  });
  test("coordinates frozen cycles, readiness, and boot lease reset without Hub SQL", () => {
    const db = database();
    const empty = db.beginHierarchyBackfillCycle("owner-cycle", { epoch: 1, requiredAdapters: [] });
    expect(db.getHierarchyReadiness("owner-cycle", 1, empty.cycle)).toMatchObject({ ready: false, coverageGapCount: 1 });
    db.freezeHierarchyBackfillSnapshot("owner-cycle", 1, empty.cycle);
    expect(db.hierarchyCoverageGapCount("owner-cycle", 1, empty.cycle)).toBe(0);
    const next = db.beginHierarchyBackfillCycle("owner-cycle", { epoch: 1, requiredAdapters: ["gjc"] });
    expect(next.cycle).toBe(empty.cycle + 1);
    db.upsertHierarchyBackfillRun({ ownerId: "owner-cycle", adapter: "gjc", epoch: 1, cycle: next.cycle, state: "enumerating", expectedSourceKeys: 0, observedSourceKeys: 0, frozenAt: null });
    db.addHierarchyBackfillManifestEntry("owner-cycle", "gjc", 1, next.cycle, "late-source");
    db.upsertHierarchyBackfillRun({ ownerId: "owner-cycle", adapter: "gjc", epoch: 1, cycle: next.cycle, state: "complete", expectedSourceKeys: 0, observedSourceKeys: 0, frozenAt: "2026-01-01T00:00:00.000Z" });
    expect(() => db.addHierarchyBackfillManifestEntry("owner-cycle", "gjc", 1, next.cycle, "after-freeze")).toThrow("immutable");
    const following = db.beginHierarchyBackfillCycle("owner-cycle", { epoch: 1, requiredAdapters: ["gjc"] });
    expect(following.cycle).toBe(next.cycle + 1);
    const lease = db.acquireGenerationLease("owner-cycle");
    db.resetHierarchyGenerationLeases();
    expect(() => db.releaseGenerationLease("owner-cycle", lease)).toThrow("not acquired");
  });
