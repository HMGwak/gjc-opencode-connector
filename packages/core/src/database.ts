import { Database } from "bun:sqlite";
import type {
  AuditEntry,
  Command,
  CommandState,
  PendingAction,
  PendingActionState,
  PushSubscription,
  Session,
  SessionEvent,
  SessionStatus,
  StoredPushSubscription,
} from "./types";

const SECRET_KEY = /(?:secret|password|token|api[_-]?key|authorization|credential|private[_-]?key|auth)/i;

export class SecretDataError extends Error {
  constructor(message = "Persistent journals must not contain secrets") {
    super(message);
    this.name = "SecretDataError";
  }
}
export class CorruptPersistentDataError extends Error {
  constructor(readonly record: string, cause?: unknown) {
    super(`Persisted ${record} JSON is corrupt`);
    this.name = "CorruptPersistentDataError";
    this.cause = cause;
  }
}


export function assertSecretFree(value: unknown): void {
  const visit = (item: unknown, path: string): void => {
    if (typeof item === "string") {
      if (/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i.test(item)) {
        throw new SecretDataError(`Secret-like value at ${path}`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (item !== null && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        if (SECRET_KEY.test(key)) throw new SecretDataError(`Secret-like key at ${path}.${key}`);
        visit(entry, `${path}.${key}`);
      }
    }
  };
  visit(value, "payload");
}

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  adapter TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stale', 'unknown', 'terminal')),
  reconciliation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_epoch >= 0),
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
  remote_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (adapter, remote_id)
);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
CREATE INDEX IF NOT EXISTS sessions_owner_updated_idx ON sessions(owner_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_session_created_idx ON events(session_id, created_at);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'dispatching', 'remote-confirmed', 'applied', 'failed', 'unknown')),
  correlation_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_expires_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commands_session_state_idx ON commands(session_id, state);
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'cancelled', 'expired', 'unknown')),
  payload_json TEXT NOT NULL,
  answer_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_actions_state_expires_idx ON pending_actions(state, expires_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  command_id TEXT REFERENCES commands(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_session_created_idx ON audit_log(session_id, created_at);
CREATE TABLE IF NOT EXISTS corrupt_payloads (
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload_column TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (record_type, record_id, payload_column)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash TEXT PRIMARY KEY CHECK (length(endpoint_hash) = 64),
  owner_id TEXT NOT NULL,
  encrypted_material TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_owner_expires_idx ON push_subscriptions(owner_id, expires_at);
`;

interface SessionRow {
  id: string; owner_id: string | null; adapter: string; remote_id: string; status: SessionStatus;
  reconciliation_epoch: number; reconciled: number; remote_revision: string | null;
  created_at: string; updated_at: string;
}
interface EventRow { session_id: string; seq: number; type: string; payload_json: string; created_at: string; }
interface CommandRow { id: string; session_id: string; idempotency_key: string; state: CommandState; correlation_id: string | null; attempt: number; lease_expires_at: string | null; payload_json: string; created_at: string; updated_at: string; }
interface AuditRow { id: number; action: string; session_id: string | null; command_id: string | null; payload_json: string; created_at: string; }
interface PendingActionRow { id: string; version: number; state: PendingActionState; payload_json: string; answer_json: string | null; expires_at: string; created_at: string; updated_at: string; }
interface PushSubscriptionRow { endpoint_hash: string; owner_id: string; encrypted_material: string; expires_at: string | null; created_at: string; updated_at: string; }

const now = (): string => new Date().toISOString();
const json = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new TypeError("Persistent payloads must serialize to JSON values");
  assertSecretFree(JSON.parse(serialized));
  return serialized;
};
const decodeJson = <T>(value: string, record: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new CorruptPersistentDataError(record, cause);
  }
};
const asSession = (row: SessionRow): Session => {
  if (row.owner_id === null) throw new Error("Session is quarantined pending owner claim");
  return { id: row.id, ownerId: row.owner_id, adapter: row.adapter, remoteId: row.remote_id, status: row.status, reconciliationEpoch: row.reconciliation_epoch, reconciled: row.reconciled === 1, remoteRevision: row.remote_revision, createdAt: row.created_at, updatedAt: row.updated_at };
};
const asEvent = <T>(row: EventRow): SessionEvent<T> => ({ sessionId: row.session_id, seq: row.seq, type: row.type, payload: decodeJson<T>(row.payload_json, `event ${row.session_id}:${row.seq}`), createdAt: row.created_at });
const asCommand = <T>(row: CommandRow): Command<T> => ({ id: row.id, sessionId: row.session_id, idempotencyKey: row.idempotency_key, state: row.state, correlationId: row.correlation_id, attempt: row.attempt, leaseExpiresAt: row.lease_expires_at, payload: decodeJson<T>(row.payload_json, `command ${row.id}`), createdAt: row.created_at, updatedAt: row.updated_at });
const asAudit = <T>(row: AuditRow): AuditEntry<T> => ({ id: row.id, action: row.action, sessionId: row.session_id, commandId: row.command_id, payload: decodeJson<T>(row.payload_json, `audit ${row.id}`), createdAt: row.created_at });
const asPushSubscription = (row: PushSubscriptionRow): StoredPushSubscription => ({ ownerId: row.owner_id, endpointHash: row.endpoint_hash, encryptedMaterial: row.encrypted_material, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at });

export class CoreDatabase {
  readonly sqlite: Database;
  readonly filename: string;
  private transactionDepth = 0;

  constructor(filename = ":memory:") {
    this.filename = filename;
    this.sqlite = new Database(filename, { create: true, strict: true });
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.sqlite.exec(schema);
    const columns = this.sqlite.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "owner_id")) this.sqlite.exec("ALTER TABLE sessions ADD COLUMN owner_id TEXT");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS sessions_owner_updated_idx ON sessions(owner_id, updated_at DESC)");
    // Legacy sessions had no owner. They are deliberately invisible until claimed.
    this.sqlite.query("UPDATE sessions SET status = 'unknown', reconciled = 0, updated_at = ? WHERE owner_id IS NULL").run(now());
  }

  close(): void { this.sqlite.close(); }
  private quarantine(recordType: string, recordId: string, payloadColumn: string, payload: string): void {
    this.sqlite.query("INSERT OR IGNORE INTO corrupt_payloads (record_type, record_id, payload_column, payload_json, detected_at) VALUES (?, ?, ?, ?, ?)").run(recordType, recordId, payloadColumn, payload, now());
  }
  private corrupt<T>(recordType: string, recordId: string, payloadColumn: string, payload: string, decode: () => T): T {
    try {
      return decode();
    } catch (cause) {
      if (!(cause instanceof CorruptPersistentDataError)) throw cause;
      this.quarantine(recordType, recordId, payloadColumn, payload);
      throw cause;
    }
  }
  private pendingAction<T, A>(row: PendingActionRow): PendingAction<T, A> {
    const payload = this.corrupt("pending_action", row.id, "payload_json", row.payload_json, () => decodeJson<T>(row.payload_json, `pending action ${row.id}`));
    const answer = row.answer_json === null ? null : this.corrupt("pending_action", row.id, "answer_json", row.answer_json, () => decodeJson<A>(row.answer_json!, `pending action answer ${row.id}`));
    return { id: row.id, version: row.version, state: row.state, payload, answer, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  transaction<T>(work: () => T): T {
    const savepoint = `core_transaction_${this.transactionDepth}`;
    const nested = this.transactionDepth > 0;
    this.sqlite.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = work();
      this.sqlite.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK");
      if (nested) this.sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  createSession(input: Pick<Session, "id" | "ownerId" | "adapter" | "remoteId">): Session {
    if (!input.ownerId) throw new TypeError("Session owner is required");
    const timestamp = now();
    this.sqlite.query("INSERT INTO sessions (id, owner_id, adapter, remote_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").run(input.id, input.ownerId, input.adapter, input.remoteId, timestamp, timestamp);
    return this.getSession(input.id)!;
  }

  getSession(id: string): Session | null {
    const row = this.sqlite.query("SELECT * FROM sessions WHERE id = ? AND owner_id IS NOT NULL").get(id) as SessionRow | null;
    return row ? asSession(row) : null;
  }
  getSessionForOwner(id: string, ownerId: string): Session | null {
    const row = this.sqlite.query("SELECT * FROM sessions WHERE id = ? AND owner_id = ?").get(id, ownerId) as SessionRow | null;
    return row ? asSession(row) : null;
  }
  claimSession(id: string, ownerId: string): Session | null {
    if (!ownerId) throw new TypeError("Session owner is required");
    return this.transaction(() => {
      const result = this.sqlite.query("UPDATE sessions SET owner_id = ?, updated_at = ? WHERE id = ? AND owner_id IS NULL").run(ownerId, now(), id);
      return result.changes === 1 ? this.getSessionForOwner(id, ownerId) : null;
    });
  }

  listSessionsForOwner(ownerId: string): Session[] {
    const rows = this.sqlite.query("SELECT * FROM sessions WHERE owner_id = ? ORDER BY updated_at DESC").all(ownerId) as SessionRow[];
    return rows.map(asSession);
  }

  setReconciliation(id: string, status: SessionStatus, epoch: number, reconciled: boolean, remoteRevision: string | null): Session {
    if ((status === "stale" || status === "unknown") && reconciled) throw new Error("Stale or unknown sessions cannot be reconciled");
    const result = this.sqlite.query("UPDATE sessions SET status = ?, reconciliation_epoch = ?, reconciled = ?, remote_revision = ?, updated_at = ? WHERE id = ? AND owner_id IS NOT NULL AND reconciliation_epoch <= ?").run(status, epoch, reconciled ? 1 : 0, remoteRevision, now(), id, epoch);
    if (result.changes !== 1) throw new Error("Session does not exist or reconciliation epoch is stale");
    return this.getSession(id)!;
  }

  appendEvent<T>(sessionId: string, type: string, payload: T): SessionEvent<T> {
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      if (!session) throw new Error("Session does not exist");
      if (session.status === "terminal") throw new Error("Terminal sessions are immutable");
      const row = this.sqlite.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?").get(sessionId) as { seq: number };
      const event: EventRow = { session_id: sessionId, seq: row.seq + 1, type, payload_json: json(payload), created_at: now() };
      this.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(event.session_id, event.seq, event.type, event.payload_json, event.created_at);
      return asEvent<T>(event);
    });
  }
  listEvents<T>(sessionId: string, after = 0): SessionEvent<T>[] {
    if (!this.getSession(sessionId)) throw new Error("Session does not exist");
    const rows = this.sqlite.query("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC").all(sessionId, after) as EventRow[];
    try {
      return rows.map((row) => this.corrupt("event", `${row.session_id}:${row.seq}`, "payload_json", row.payload_json, () => asEvent<T>(row)));
    } catch (cause) {
      if (cause instanceof CorruptPersistentDataError) {
        this.sqlite.query("UPDATE sessions SET status = 'unknown', reconciled = 0, updated_at = ? WHERE id = ?").run(now(), sessionId);
      }
      throw cause;
    }
  }

  acceptCommand<T>(input: { id: string; sessionId: string; idempotencyKey: string; payload: T }): { command: Command<T>; duplicate: boolean } {
    const result = this.transaction(() => this.acceptCommandInTransaction(input));
    if (result instanceof CorruptPersistentDataError) throw result;
    return result;
  }

  acceptCommandWithEvent<T>(input: { id: string; sessionId: string; idempotencyKey: string; payload: T; eventType: string; eventPayload: unknown }): { command: Command<T>; duplicate: boolean } {
    const result = this.transaction(() => {
      const accepted = this.acceptCommandInTransaction<T>(input);
      if (accepted instanceof CorruptPersistentDataError) return accepted;
      if (!accepted.duplicate) this.appendEvent(input.sessionId, input.eventType, input.eventPayload);
      return accepted;
    });
    if (result instanceof CorruptPersistentDataError) throw result;
    return result;
  }

  private acceptCommandInTransaction<T>(input: { id: string; sessionId: string; idempotencyKey: string; payload: T }): { command: Command<T>; duplicate: boolean } | CorruptPersistentDataError {
    const session = this.getSession(input.sessionId);
    if (!session) throw new Error("Session does not exist");
    const existing = this.sqlite.query("SELECT * FROM commands WHERE idempotency_key = ?").get(input.idempotencyKey) as CommandRow | null;
    if (existing) {
      try {
        return { command: asCommand<T>(existing), duplicate: true };
      } catch (cause) {
        if (!(cause instanceof CorruptPersistentDataError)) throw cause;
        this.quarantine("command", existing.id, "payload_json", existing.payload_json);
        return cause;
      }
    }
    if (session.status === "terminal") throw new Error("Terminal sessions are immutable");
    if (!session.reconciled) throw new Error("Mutation rejected while session requires reconciliation");
    const timestamp = now();
    const payload = json(input.payload);
    this.sqlite.query("INSERT INTO commands (id, session_id, idempotency_key, state, payload_json, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)").run(input.id, input.sessionId, input.idempotencyKey, payload, timestamp, timestamp);
    return { command: this.getCommand<T>(input.id)!, duplicate: false };
  }

  getCommand<T>(id: string): Command<T> | null {
    const row = this.sqlite.query("SELECT * FROM commands WHERE id = ?").get(id) as CommandRow | null;
    return row ? this.corrupt("command", row.id, "payload_json", row.payload_json, () => asCommand<T>(row)) : null;
  }
  claimCommand<T>(input: { id: string; correlationId: string; leaseExpiresAt: string }): Command<T> | null {
    return this.transaction(() => {
      const timestamp = now();
      const result = this.sqlite.query("UPDATE commands SET state = 'dispatching', correlation_id = ?, lease_expires_at = ?, attempt = attempt + 1, updated_at = ? WHERE id = ? AND state = 'accepted'").run(input.correlationId, input.leaseExpiresAt, timestamp, input.id);
      return result.changes === 1 ? this.getCommand<T>(input.id) : null;
    });
  }
  renewCommandLease<T>(input: { id: string; correlationId: string; leaseExpiresAt: string; now?: string }): Command<T> | null {
    const timestamp = input.now ?? now();
    const result = this.sqlite.query("UPDATE commands SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'dispatching' AND correlation_id = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").run(input.leaseExpiresAt, timestamp, input.id, input.correlationId, timestamp);
    return result.changes === 1 ? this.getCommand<T>(input.id) : null;
  }

  confirmCommand<T>(input: { id: string; eventType: string; eventPayload: unknown }): Command<T> {
    return this.transitionCommandWithEvent<T>(input.id, ["dispatching", "remote-confirmed"], "remote-confirmed", input.eventType, input.eventPayload);
  }

  applyCommand<T>(input: { id: string; eventType: string; eventPayload: unknown }): Command<T> {
    return this.transitionCommandWithEvent<T>(input.id, ["remote-confirmed"], "applied", input.eventType, input.eventPayload);
  }

  markCommandUnknown<T>(input: { id: string; eventType: string; eventPayload: unknown }): Command<T> {
    return this.transitionCommandWithEvent<T>(input.id, ["dispatching"], "unknown", input.eventType, input.eventPayload);
  }

  listCommandsForRecovery<T>(): Command<T>[] {
    const rows = this.sqlite.query("SELECT * FROM commands WHERE state IN ('accepted', 'dispatching', 'remote-confirmed') ORDER BY created_at ASC").all() as CommandRow[];
    return rows.map((row) => this.corrupt("command", row.id, "payload_json", row.payload_json, () => asCommand<T>(row)));
  }

  private transitionCommandWithEvent<T>(id: string, expected: readonly CommandState[], state: CommandState, eventType: string, eventPayload: unknown): Command<T> {
    return this.transaction(() => {
      const command = this.getCommand<T>(id);
      if (!command) throw new Error("Command does not exist");
      if (command.state === state) return command;
      if (!expected.includes(command.state)) throw new Error(`Invalid command transition from ${command.state} to ${state}`);
      const updated = this.sqlite.query(`UPDATE commands SET state = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state IN (${expected.map(() => "?").join(", ")})`).run(state, now(), id, ...expected);
      if (updated.changes !== 1) throw new Error("Command transition lost");
      this.appendEvent(command.sessionId, eventType, eventPayload);
      return this.getCommand<T>(id)!;
    });
  }

  createPendingAction<T>(input: { id: string; payload: T; expiresAt: string }): PendingAction<T> {
    const timestamp = now();
    this.sqlite.query("INSERT INTO pending_actions (id, version, state, payload_json, expires_at, created_at, updated_at) VALUES (?, 1, 'pending', ?, ?, ?, ?)").run(input.id, json(input.payload), input.expiresAt, timestamp, timestamp);
    return this.getPendingAction<T>(input.id)!;
  }

  getPendingAction<T, A = unknown>(id: string): PendingAction<T, A> | null {
    const row = this.sqlite.query("SELECT * FROM pending_actions WHERE id = ?").get(id) as PendingActionRow | null;
    return row ? this.pendingAction<T, A>(row) : null;
  }

  updatePendingAction<T, A>(input: { id: string; expectedVersion: number; state: Exclude<PendingActionState, "pending">; answer?: A; updatedAt: string }): PendingAction<T, A> | null {
    const result = this.sqlite.query("UPDATE pending_actions SET state = ?, answer_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = 'pending' AND version = ?").run(input.state, input.answer === undefined ? null : json(input.answer), input.updatedAt, input.id, input.expectedVersion);
    return result.changes === 1 ? this.getPendingAction<T, A>(input.id) : null;
  }

  writeAudit<T>(input: { action: string; sessionId?: string; commandId?: string; payload: T }): AuditEntry<T> {
    const payload = json(input.payload); const timestamp = now();
    const result = this.sqlite.query("INSERT INTO audit_log (action, session_id, command_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(input.action, input.sessionId ?? null, input.commandId ?? null, payload, timestamp);
    const row = this.sqlite.query("SELECT * FROM audit_log WHERE id = ?").get(result.lastInsertRowid) as AuditRow;
    return asAudit<T>(row);
  }
  getAudit<T>(id: number): AuditEntry<T> | null {
    const row = this.sqlite.query("SELECT * FROM audit_log WHERE id = ?").get(id) as AuditRow | null;
    return row ? this.corrupt("audit", String(row.id), "payload_json", row.payload_json, () => asAudit<T>(row)) : null;
  }
  upsertPushSubscription(input: { ownerId: string; endpointHash: string; encryptedMaterial: string; expiresAt?: string | null }): PushSubscription {
    if (!/^[a-f0-9]{64}$/.test(input.endpointHash)) throw new TypeError("Push endpoint hash must be a SHA-256 hex digest");
    if (!input.ownerId) throw new TypeError("Push subscription owner is required");
    if (!input.encryptedMaterial) throw new TypeError("Push subscription material is required");
    return this.transaction(() => {
      const existing = this.sqlite.query("SELECT * FROM push_subscriptions WHERE endpoint_hash = ?").get(input.endpointHash) as PushSubscriptionRow | null;
      if (existing && existing.owner_id !== input.ownerId) throw new Error("Push endpoint belongs to another owner");
      const timestamp = now();
      this.sqlite.query("INSERT INTO push_subscriptions (endpoint_hash, owner_id, encrypted_material, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint_hash) DO UPDATE SET encrypted_material = excluded.encrypted_material, expires_at = excluded.expires_at, updated_at = excluded.updated_at").run(input.endpointHash, input.ownerId, input.encryptedMaterial, input.expiresAt ?? null, timestamp, timestamp);
      const stored = this.getStoredPushSubscription(input.ownerId, input.endpointHash);
      if (!stored) throw new Error("Push subscription was not stored");
      const { encryptedMaterial: _encryptedMaterial, ...subscription } = stored;
      return subscription;
    });
  }

  getStoredPushSubscription(ownerId: string, endpointHash: string): StoredPushSubscription | null {
    const row = this.sqlite.query("SELECT * FROM push_subscriptions WHERE owner_id = ? AND endpoint_hash = ?").get(ownerId, endpointHash) as PushSubscriptionRow | null;
    return row ? asPushSubscription(row) : null;
  }

  listPushSubscriptions(ownerId: string, at = now()): StoredPushSubscription[] {
    const rows = this.sqlite.query("SELECT * FROM push_subscriptions WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at ASC").all(ownerId, at) as PushSubscriptionRow[];
    return rows.map(asPushSubscription);
  }

  revokePushSubscription(ownerId: string, endpointHash: string): boolean {
    return this.sqlite.query("DELETE FROM push_subscriptions WHERE owner_id = ? AND endpoint_hash = ?").run(ownerId, endpointHash).changes === 1;
  }

  deleteExpiredPushSubscriptions(at = now()): number {
    return this.sqlite.query("DELETE FROM push_subscriptions WHERE expires_at IS NOT NULL AND expires_at <= ?").run(at).changes;
  }
  listPendingActions<T, A = unknown>(): PendingAction<T, A>[] {
    const rows = this.sqlite.query("SELECT * FROM pending_actions ORDER BY created_at ASC").all() as PendingActionRow[];
    return rows.map((row) => this.pendingAction<T, A>(row));
  }
}

export const openCoreDatabase = (filename?: string): CoreDatabase => new CoreDatabase(filename);
export { DurableCommandDispatcher } from "./dispatcher";
export type { CorrelationLookup, DurableCommandDispatcherOptions, DurableCommandRemote } from "./dispatcher";
