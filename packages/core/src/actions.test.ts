import { afterEach, describe, expect, test } from "bun:test";
import { CoreDatabase } from "./database";
import { PendingActionError, PendingActionService } from "./actions";

const databases: CoreDatabase[] = [];
const database = (): CoreDatabase => { const value = new CoreDatabase(); databases.push(value); return value; };
afterEach(() => { while (databases.length) databases.pop()!.close(); });

const serviceAt = (instant: string, db = database()) => new PendingActionService(db, { now: () => new Date(instant), createId: () => "action-1" });
const expiry = "2030-01-01T00:00:01.000Z";

describe("PendingActionService", () => {
  test("requires a non-empty owner and persists it with the action", () => {
    const service = serviceAt("2030-01-01T00:00:00.000Z");
    expect(() => service.create({ ownerId: " ", payload: {}, expiresAt: expiry })).toThrow("owner must not be empty");
    expect(service.create({ ownerId: "owner-1", payload: {}, expiresAt: expiry })).toMatchObject({ ownerId: "owner-1" });
  });
  test("rejects stale optimistic versions without changing the pending action", () => {
    const service = serviceAt("2030-01-01T00:00:00.000Z");
    service.create({ ownerId: "owner-1", payload: { prompt: "Continue?" }, expiresAt: expiry });
    expect(() => service.respond({ id: "action-1", version: 2, answer: "yes" })).toThrow(PendingActionError);
    expect(service.get("action-1")).toMatchObject({ state: "pending", version: 1 });
  });

  test("makes an identical duplicate response idempotent but rejects a conflict", () => {
    const service = serviceAt("2030-01-01T00:00:00.000Z");
    service.create({ ownerId: "owner-1", payload: {}, expiresAt: expiry });
    const first = service.respond({ id: "action-1", version: 1, answer: { approved: true } });
    expect(service.respond({ id: "action-1", version: 1, answer: { approved: true } })).toEqual(first);
    expect(() => service.respond({ id: "action-1", version: 1, answer: { approved: false } })).toThrow("different terminal response");
  });

  test("accepts before expiry and expires at and after the boundary", () => {
    const beforeDb = database();
    serviceAt("2030-01-01T00:00:00.999Z", beforeDb).create({ ownerId: "owner-1", payload: {}, expiresAt: expiry });
    expect(serviceAt("2030-01-01T00:00:00.999Z", beforeDb).respond({ id: "action-1", version: 1, answer: "yes" })).toMatchObject({ state: "answered", version: 2 });

    const atDb = database();
    serviceAt("2030-01-01T00:00:00.000Z", atDb).create({ ownerId: "owner-1", payload: {}, expiresAt: expiry });
    const atExpiry = serviceAt(expiry, atDb);
    expect(() => atExpiry.respond({ id: "action-1", version: 1, answer: "yes" })).toThrow("has expired");
    expect(atExpiry.get("action-1")).toMatchObject({ state: "expired", version: 2 });

    const afterDb = database();
    serviceAt("2030-01-01T00:00:00.000Z", afterDb).create({ ownerId: "owner-1", payload: {}, expiresAt: expiry });
    const afterExpiry = serviceAt("2030-01-01T00:00:01.001Z", afterDb);
    expect(() => afterExpiry.respond({ id: "action-1", version: 1, answer: "yes" })).toThrow("has expired");
    expect(afterExpiry.get("action-1")).toMatchObject({ state: "expired", version: 2 });
  });

  test("refuses cancelled, expired, unknown, and missing actions", () => {
    const service = serviceAt("2030-01-01T00:00:00.000Z");
    service.create({ ownerId: "owner-1", payload: {}, expiresAt: expiry });
    service.cancel("action-1", 1);
    expect(() => service.respond({ id: "action-1", version: 1, answer: "yes" })).toThrow("cancelled");
    expect(() => service.respond({ id: "missing", version: 1, answer: "yes" })).toThrow("does not exist");

    const unknown = new PendingActionService(databases[0]!, { now: () => new Date("2030-01-01T00:00:00.000Z"), createId: () => "action-2" });
    unknown.create({ ownerId: "owner-1", payload: {}, expiresAt: expiry });
    unknown.markUnknown("action-2", 1);
    expect(() => unknown.respond({ id: "action-2", version: 1, answer: "yes" })).toThrow("outcome is unknown");
  });

  test("rolls back action creation and audit write together on a simulated crash", () => {
    const db = database();
    expect(() => db.transaction(() => {
      db.createPendingAction({ id: "action-1", ownerId: "owner-1", payload: {}, expiresAt: expiry });
      db.writeAudit({ action: "pending-action.created", payload: { token: "must-not-persist" } });
    })).toThrow();
    expect(db.getPendingAction("action-1")).toBeNull();
  });
  test("rolls back an answered action when its event append fails so retry cannot miss it", () => {
    const db = database();
    const service = serviceAt("2030-01-01T00:00:00.000Z", db);
    service.create({ ownerId: "owner-1", payload: {}, expiresAt: expiry });
    expect(() => service.respondWithEvent({ id: "action-1", version: 1, answer: "yes", sessionId: "missing" })).toThrow();
    expect(service.get("action-1")).toMatchObject({ state: "pending", version: 1 });
    db.createSession({ id: "session-1", ownerId: "owner-1", adapter: "test", remoteId: "remote-1" });
    expect(service.respondWithEvent({ id: "action-1", version: 1, answer: "yes", sessionId: "session-1" })).toMatchObject({ state: "answered", version: 2 });
    expect(db.sqlite.query("SELECT type FROM events WHERE session_id = ?").all("session-1")).toEqual([{ type: "action.responded" }]);
    db.sqlite.query("DELETE FROM events WHERE session_id = ?").run("session-1");
    expect(service.respondWithEvent({ id: "action-1", version: 1, answer: "yes", sessionId: "session-1" })).toMatchObject({ state: "answered", version: 2 });
    expect(db.sqlite.query("SELECT type FROM events WHERE session_id = ?").all("session-1")).toEqual([{ type: "action.responded" }]);
  });
});
