import { afterEach, describe, expect, test } from "bun:test";
import { CoreDatabase, CorruptPersistentDataError, DurableCommandDispatcher, SecretDataError } from "./database";

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
    db.createPendingAction({ id: "action-1", payload: {}, expiresAt: "2030-01-01T00:00:00.000Z" });
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
    expect(() => db.createPendingAction({ id: "action-1", payload: secretAfterSerialization, expiresAt: "2030-01-01T00:00:00.000Z" })).toThrow(SecretDataError);
    db.createPendingAction({ id: "action-2", payload: {}, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(() => db.updatePendingAction({ id: "action-2", expectedVersion: 1, state: "answered", answer: secretAfterSerialization, updatedAt: "2025-01-01T00:00:00.000Z" })).toThrow(SecretDataError);
    expect(() => db.writeAudit({ action: "request", payload: secretAfterSerialization })).toThrow(SecretDataError);
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
test("applies the phase-0 migration idempotently across repeated opens", async () => {
  const filename = `/tmp/core-phase0-migration-${crypto.randomUUID()}.sqlite`;
  try {
    let db = new CoreDatabase(filename);
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "gjc", remoteId: "remote-1" });
    expect(db.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.sqlite.query("SELECT version, name FROM schema_migrations").all()).toEqual([
      { version: 1, name: "phase-0-runtime-foundation" },
    ]);
    db.close();

    db = new CoreDatabase(filename);
    expect(db.sqlite.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    expect(db.sqlite.query("SELECT id, control_mode, origin, transcript_status FROM sessions").all()).toEqual([
      { id: "session-1", control_mode: "view-only", origin: "ondisk-discovery", transcript_status: "available" },
    ]);
    db.close();
  } finally {
    await Bun.file(filename).delete();
    await Bun.file(`${filename}-wal`).delete();
    await Bun.file(`${filename}-shm`).delete();
  }
});
