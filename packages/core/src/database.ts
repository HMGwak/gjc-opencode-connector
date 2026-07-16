import { Database } from "bun:sqlite";
import type {
  AuditEntry,
  Command,
  CommandState,
  PendingAction,
  PendingActionState,
  PushSubscription,
  Session,
  SessionControlMode,
  SessionEvent,
  SessionOrigin,
  SessionStatus,
  StoredPushSubscription,
  TranscriptStatus,
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
  epoch_owner TEXT,
  epoch_claimed_at TEXT,
  view_owner TEXT,
  view_claimed_at TEXT,
  control_mode TEXT NOT NULL DEFAULT 'view-only' CHECK (control_mode IN ('view-only', 'controlled')),
  origin TEXT NOT NULL DEFAULT 'ondisk-discovery' CHECK (origin IN ('ondisk-discovery', 'coordinator-start', 'coordinator-resume', 'coordinator-continuation', 'opencode-discovery')),
  transcript_status TEXT NOT NULL DEFAULT 'available' CHECK (transcript_status IN ('available', 'unreadable')),
  control_cutover_seq INTEGER,
  continuation_parent_id TEXT REFERENCES sessions(id),
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
  source_event_id TEXT,
  source_revision TEXT,
  source_position INTEGER,
  content_hash TEXT,
  source TEXT CHECK (source IN ('gjc-ondisk', 'gjc-coordinator', 'opencode')),
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_session_created_idx ON events(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS events_source_identity_idx ON events(session_id, source, source_event_id) WHERE source IS NOT NULL AND source_event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'dispatching', 'remote-confirmed', 'applied', 'failed', 'unknown')),
  correlation_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_expires_at TEXT,
  claimed_epoch INTEGER,
  claimed_epoch_owner TEXT,
  pending_action_id TEXT REFERENCES pending_actions(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commands_session_state_idx ON commands(session_id, state);
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  remote_ref TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'answered', 'cancelled', 'expired', 'unknown')),
  payload_json TEXT NOT NULL,
  answer_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_actions_state_expires_idx ON pending_actions(state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS pending_actions_remote_ref_idx ON pending_actions(session_id, remote_ref) WHERE session_id IS NOT NULL AND remote_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_provisions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'resume', 'continuation')),
  source_session_id TEXT REFERENCES sessions(id),
  session_id TEXT REFERENCES sessions(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'confirmed', 'failed', 'unknown')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS session_provisions_active_source_idx ON session_provisions(source_session_id) WHERE source_session_id IS NOT NULL AND state IN ('pending', 'dispatching');
CREATE TABLE IF NOT EXISTS remote_cursors (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  adapter TEXT NOT NULL,
  source TEXT NOT NULL,
  cursor_scope TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, adapter, source, cursor_scope)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  remote_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, remote_id)
);
CREATE TABLE IF NOT EXISTS opencode_instances (
  id TEXT PRIMARY KEY,
  port INTEGER NOT NULL CHECK (port > 0 AND port <= 65535),
  password_fingerprint TEXT NOT NULL CHECK (length(password_fingerprint) = 64),
  first_seen_at TEXT NOT NULL,
  last_health_ok_at TEXT NOT NULL,
  UNIQUE (port, password_fingerprint)
);
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
CREATE TABLE IF NOT EXISTS device_pairings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS device_pairings_expires_idx ON device_pairings(expires_at);
CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE CHECK (length(credential_hash) = 64),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS device_credentials_owner_created_idx ON device_credentials(owner_id, created_at DESC);
`;
const migrationBootstrap = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, owner_id TEXT, adapter TEXT NOT NULL, remote_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stale', 'unknown', 'terminal')),
  reconciliation_epoch INTEGER NOT NULL DEFAULT 0, reconciled INTEGER NOT NULL DEFAULT 0,
  remote_revision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (adapter, remote_id)
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'dispatching', 'remote-confirmed', 'applied', 'failed', 'unknown')),
  correlation_id TEXT, attempt INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'cancelled', 'expired', 'unknown')),
  payload_json TEXT NOT NULL, answer_json TEXT, expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const columnsOf = (database: Database, table: string): Set<string> =>
  new Set((database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));

const addMissingColumns = (database: Database, table: string, definitions: readonly string[]): void => {
  const columns = columnsOf(database, table);
  for (const definition of definitions) {
    const name = definition.split(/\s+/, 1)[0]!;
    if (!columns.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
};

const migratePhase0 = (database: Database): void => {
  database.exec(migrationBootstrap);
  addMissingColumns(database, "sessions", [
    "owner_id TEXT", "epoch_owner TEXT", "epoch_claimed_at TEXT", "view_owner TEXT", "view_claimed_at TEXT",
    "control_mode TEXT NOT NULL DEFAULT 'view-only' CHECK (control_mode IN ('view-only', 'controlled'))",
    "origin TEXT NOT NULL DEFAULT 'ondisk-discovery' CHECK (origin IN ('ondisk-discovery', 'coordinator-start', 'coordinator-resume', 'coordinator-continuation', 'opencode-discovery'))",
    "transcript_status TEXT NOT NULL DEFAULT 'available' CHECK (transcript_status IN ('available', 'unreadable'))",
    "control_cutover_seq INTEGER", "continuation_parent_id TEXT REFERENCES sessions(id)",
  ]);
  addMissingColumns(database, "events", [
    "source_event_id TEXT", "source_revision TEXT", "source_position INTEGER", "content_hash TEXT",
    "source TEXT CHECK (source IN ('gjc-ondisk', 'gjc-coordinator', 'opencode'))",
  ]);

  if (!columnsOf(database, "pending_actions").has("session_id")) {
    database.exec(`
      ALTER TABLE pending_actions RENAME TO pending_actions_legacy;
      CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), remote_ref TEXT,
        version INTEGER NOT NULL CHECK (version >= 1),
        state TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'answered', 'cancelled', 'expired', 'unknown')),
        payload_json TEXT NOT NULL, answer_json TEXT, expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO pending_actions (id, version, state, payload_json, answer_json, expires_at, created_at, updated_at)
        SELECT id, version, state, payload_json, answer_json, expires_at, created_at, updated_at FROM pending_actions_legacy;
      DROP TABLE pending_actions_legacy;
    `);
  }
  addMissingColumns(database, "commands", [
    "claimed_epoch INTEGER", "claimed_epoch_owner TEXT", "pending_action_id TEXT REFERENCES pending_actions(id)",
  ]);
};

interface SessionRow {
  id: string; owner_id: string | null; adapter: string; remote_id: string; status: SessionStatus;
  reconciliation_epoch: number; reconciled: number; remote_revision: string | null;
  control_mode: SessionControlMode; origin: SessionOrigin; transcript_status: TranscriptStatus;
  created_at: string; updated_at: string;
}
interface EventRow { session_id: string; seq: number; type: string; payload_json: string; created_at: string; }
interface CommandRow { id: string; session_id: string; idempotency_key: string; state: CommandState; correlation_id: string | null; attempt: number; lease_expires_at: string | null; payload_json: string; created_at: string; updated_at: string; }
interface AuditRow { id: number; action: string; session_id: string | null; command_id: string | null; payload_json: string; created_at: string; }
interface PendingActionRow { id: string; version: number; state: PendingActionState; payload_json: string; answer_json: string | null; expires_at: string; created_at: string; updated_at: string; }
interface PushSubscriptionRow { endpoint_hash: string; owner_id: string; encrypted_material: string; expires_at: string | null; created_at: string; updated_at: string; }
interface DevicePairingRow { id: string; owner_id: string; code_hash: string; expires_at: string; attempts: number; max_attempts: number; consumed_at: string | null; created_at: string; }
interface DeviceCredentialRow { id: string; owner_id: string; device_name: string; credential_hash: string; created_at: string; last_used_at: string | null; revoked_at: string | null; }

export type DeviceCredential = {
  readonly id: string;
  readonly ownerId: string;
  readonly deviceName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
};

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
  return {
    id: row.id, ownerId: row.owner_id, adapter: row.adapter, remoteId: row.remote_id,
    status: row.status, reconciliationEpoch: row.reconciliation_epoch, reconciled: row.reconciled === 1,
    remoteRevision: row.remote_revision, controlMode: row.control_mode, origin: row.origin,
    transcriptStatus: row.transcript_status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
};
const asEvent = <T>(row: EventRow): SessionEvent<T> => ({ sessionId: row.session_id, seq: row.seq, type: row.type, payload: decodeJson<T>(row.payload_json, `event ${row.session_id}:${row.seq}`), createdAt: row.created_at });
const asCommand = <T>(row: CommandRow): Command<T> => ({ id: row.id, sessionId: row.session_id, idempotencyKey: row.idempotency_key, state: row.state, correlationId: row.correlation_id, attempt: row.attempt, leaseExpiresAt: row.lease_expires_at, payload: decodeJson<T>(row.payload_json, `command ${row.id}`), createdAt: row.created_at, updatedAt: row.updated_at });
const asAudit = <T>(row: AuditRow): AuditEntry<T> => ({ id: row.id, action: row.action, sessionId: row.session_id, commandId: row.command_id, payload: decodeJson<T>(row.payload_json, `audit ${row.id}`), createdAt: row.created_at });
const asPushSubscription = (row: PushSubscriptionRow): StoredPushSubscription => ({ ownerId: row.owner_id, endpointHash: row.endpoint_hash, encryptedMaterial: row.encrypted_material, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at });
const asDeviceCredential = (row: DeviceCredentialRow): DeviceCredential => ({ id: row.id, ownerId: row.owner_id, deviceName: row.device_name, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });

export class CoreDatabase {
  readonly sqlite: Database;
  readonly filename: string;
  private transactionDepth = 0;

  constructor(filename = ":memory:") {
    this.filename = filename;
    this.sqlite = new Database(filename, { create: true, strict: true });
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      migratePhase0(this.sqlite);
      this.sqlite.exec(schema);
      this.sqlite.query("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, 'phase-0-runtime-foundation', ?)").run(now());
      this.sqlite.exec("PRAGMA user_version = 1");
      this.sqlite.exec("COMMIT");
    } catch (cause) {
      this.sqlite.exec("ROLLBACK");
      throw cause;
    }
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
    this.sqlite.query("INSERT INTO sessions (id, owner_id, adapter, remote_id, status, control_mode, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 'controlled', 'coordinator-start', ?, ?)").run(input.id, input.ownerId, input.adapter, input.remoteId, timestamp, timestamp);
    return this.getSession(input.id)!;
  }

  upsertDiscoveredSession(input: {
    id: string; ownerId: string; adapter: "gjc"; remoteId: string; controlMode: "view-only";
    origin: "ondisk-discovery"; transcriptStatus: TranscriptStatus; updatedAt: string;
  }): Session {
    if (!input.ownerId) throw new TypeError("Session owner is required");
    const createdAt = now();
    this.sqlite.query(`
      INSERT INTO sessions (
        id, owner_id, adapter, remote_id, status, control_mode, origin, transcript_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      ON CONFLICT(adapter, remote_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        transcript_status = excluded.transcript_status
    `).run(
      input.id, input.ownerId, input.adapter, input.remoteId, input.controlMode, input.origin,
      input.transcriptStatus, createdAt, input.updatedAt,
    );
    const row = this.sqlite.query("SELECT * FROM sessions WHERE adapter = ? AND remote_id = ? AND owner_id IS NOT NULL")
      .get(input.adapter, input.remoteId) as SessionRow | null;
    if (!row) throw new Error("Discovered session belongs to another owner or is quarantined");
    return asSession(row);
  }

  claimView(input: { sessionId: string; owner: string; claimedAt: string; staleBefore: string }): boolean {
    const result = this.sqlite.query(`
      UPDATE sessions SET view_owner = ?, view_claimed_at = ?
      WHERE id = ? AND control_mode = 'view-only'
        AND (view_owner IS NULL OR view_owner = ? OR view_claimed_at < ?)
    `).run(input.owner, input.claimedAt, input.sessionId, input.owner, input.staleBefore);
    return result.changes === 1;
  }

  projectRemoteBatch(input: {
    mode: "view"; sessionId: string; adapter: string; source: "gjc-ondisk";
    cursorScope: string; owner: string; cursor: string;
    events: ReadonlyArray<{
      sourceEventId: string; sourceRevision: string; sourcePosition: number; contentHash: string;
      type: string; payload: unknown; createdAt: string;
    }>;
  }): number {
    return this.transaction(() => {
      const lease = this.sqlite.query(
        "SELECT 1 AS held FROM sessions WHERE id = ? AND control_mode = 'view-only' AND view_owner = ?",
      ).get(input.sessionId, input.owner);
      if (!lease) throw new Error("View projection lease is not held");

      let nextSeq = (this.sqlite.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?")
        .get(input.sessionId) as { seq: number }).seq;
      let inserted = 0;
      for (const event of input.events) {
        const existing = this.sqlite.query(`
          SELECT source_revision, source_position, content_hash FROM events
          WHERE session_id = ? AND source = ? AND source_event_id = ?
        `).get(input.sessionId, input.source, event.sourceEventId) as {
          source_revision: string | null; source_position: number | null; content_hash: string | null;
        } | null;
        if (existing) {
          if (existing.source_revision !== event.sourceRevision || existing.source_position !== event.sourcePosition || existing.content_hash !== event.contentHash) {
            throw new Error("Remote event identity changed");
          }
          continue;
        }
        nextSeq++;
        this.sqlite.query(`
          INSERT INTO events (
            session_id, seq, type, payload_json, created_at, source_event_id,
            source_revision, source_position, content_hash, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.sessionId, nextSeq, event.type, json(event.payload), event.createdAt, event.sourceEventId,
          event.sourceRevision, event.sourcePosition, event.contentHash, input.source,
        );
        inserted++;
      }
      this.sqlite.query(`
        INSERT INTO remote_cursors (session_id, adapter, source, cursor_scope, cursor_value, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, adapter, source, cursor_scope) DO UPDATE SET
          cursor_value = excluded.cursor_value,
          updated_at = excluded.updated_at
      `).run(input.sessionId, input.adapter, input.source, input.cursorScope, input.cursor, now());
      const leaseStillHeld = this.sqlite.query(
        "SELECT 1 AS held FROM sessions WHERE id = ? AND control_mode = 'view-only' AND view_owner = ?",
      ).get(input.sessionId, input.owner);
      if (!leaseStillHeld) throw new Error("View projection lease was lost");
      return inserted;
    });
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
    const result = this.sqlite.query("UPDATE sessions SET status = ?, reconciliation_epoch = ?, reconciled = ?, remote_revision = ?, updated_at = ? WHERE id = ? AND owner_id IS NOT NULL AND reconciliation_epoch = ?").run(status, epoch, reconciled ? 1 : 0, remoteRevision, now(), id, epoch - 1);
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

  createDevicePairing(input: { id: string; ownerId: string; codeHash: string; expiresAt: string; maxAttempts: number }): void {
    if (!input.ownerId || !/^[a-f0-9]{64}$/.test(input.codeHash) || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) throw new TypeError("Invalid device pairing");
    this.sqlite.query("INSERT INTO device_pairings (id, owner_id, code_hash, expires_at, max_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(input.id, input.ownerId, input.codeHash, input.expiresAt, input.maxAttempts, now());
  }

  redeemDevicePairing(input: { codeHash: string; at: string }): { readonly ownerId: string } | null {
    if (!/^[a-f0-9]{64}$/.test(input.codeHash)) return null;
    return this.transaction(() => {
      const row = this.sqlite.query("SELECT * FROM device_pairings WHERE code_hash = ?").get(input.codeHash) as DevicePairingRow | null;
      if (!row || row.consumed_at !== null || row.expires_at <= input.at || row.attempts >= row.max_attempts) return null;
      const updated = this.sqlite.query("UPDATE device_pairings SET consumed_at = ?, attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL").run(input.at, row.id);
      return updated.changes === 1 ? { ownerId: row.owner_id } : null;
    });
  }

  createDeviceCredential(input: { id: string; ownerId: string; deviceName: string; credentialHash: string }): DeviceCredential {
    if (!input.ownerId || !input.deviceName || !/^[a-f0-9]{64}$/.test(input.credentialHash)) throw new TypeError("Invalid device credential");
    const timestamp = now();
    this.sqlite.query("INSERT INTO device_credentials (id, owner_id, device_name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(input.id, input.ownerId, input.deviceName, input.credentialHash, timestamp);
    const row = this.sqlite.query("SELECT * FROM device_credentials WHERE id = ?").get(input.id) as DeviceCredentialRow | null;
    if (!row) throw new Error("Device credential was not stored");
    return asDeviceCredential(row);
  }

  authenticateDeviceCredential(credentialHash: string, at = now()): DeviceCredential | null {
    if (!/^[a-f0-9]{64}$/.test(credentialHash)) return null;
    const row = this.sqlite.query("SELECT * FROM device_credentials WHERE credential_hash = ? AND revoked_at IS NULL").get(credentialHash) as DeviceCredentialRow | null;
    if (!row) return null;
    this.sqlite.query("UPDATE device_credentials SET last_used_at = ? WHERE id = ?").run(at, row.id);
    return { ...asDeviceCredential(row), lastUsedAt: at };
  }

  listDeviceCredentials(ownerId: string): DeviceCredential[] {
    const rows = this.sqlite.query("SELECT * FROM device_credentials WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId) as DeviceCredentialRow[];
    return rows.map(asDeviceCredential);
  }

  revokeDeviceCredential(id: string, at = now()): boolean {
    return this.sqlite.query("UPDATE device_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id).changes === 1;
  }
  listPendingActions<T, A = unknown>(): PendingAction<T, A>[] {
    const rows = this.sqlite.query("SELECT * FROM pending_actions ORDER BY created_at ASC").all() as PendingActionRow[];
    return rows.map((row) => this.pendingAction<T, A>(row));
  }
}

export const openCoreDatabase = (filename?: string): CoreDatabase => new CoreDatabase(filename);
export { DurableCommandDispatcher } from "./dispatcher";
export type { CorrelationLookup, DurableCommandDispatcherOptions, DurableCommandRemote } from "./dispatcher";
