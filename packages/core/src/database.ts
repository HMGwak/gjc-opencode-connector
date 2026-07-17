import { Database } from "bun:sqlite";
import type {
  BackfillJob,
  BackfillJobState,
  AuditEntry,
  Command,
  CommandState,
  PendingAction,
  PendingActionState,
  ProjectionCheckpoint,
  ProjectionFailure,
  ProjectionGap,
  PushSubscription,
  Session,
  SessionControlMode,
  SessionEvent,
  SessionOrigin,
  SessionStatus,
  StoredPushSubscription,
  TranscriptStatus,
  WorkItem,
  SessionHierarchyEvidence,
  SessionHierarchyProjection,
  SessionHierarchyRollup,
  HierarchyBackfillCycle,
  HierarchyGeneration,
  HierarchyReadiness,
} from "./types";
import { classifyOwnerGraph } from "./session-hierarchy";
import { SecretDataError, assertSecretFree as assertRedactedSecretFree, redactDiagnostic, redactForCommand, redactForSink, type SinkKind } from "./redact";


export { SecretDataError } from "./redact";
export class CorruptPersistentDataError extends Error {
  constructor(readonly record: string, cause?: unknown) {
    super(`Persisted ${record} JSON is corrupt`);
    this.name = "CorruptPersistentDataError";
    this.cause = cause;
  }
}


export function assertSecretFree(value: unknown): void {
  try {
    assertRedactedSecretFree(value);
  } catch (cause) {
    if (cause instanceof SecretDataError) throw cause;
    if (cause instanceof Error) throw new SecretDataError(cause.message);
    throw cause;
  }
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
  active_projector_version TEXT,
  control_cutover_seq INTEGER,
  continuation_parent_id TEXT REFERENCES sessions(id),
  archived_at TEXT,
  archive_reason TEXT CHECK (archive_reason IN ('manual', 'retention')),
  archive_cursor_seq INTEGER CHECK (archive_cursor_seq IS NULL OR archive_cursor_seq > 0),
  workdir TEXT,
  source_created_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (adapter, remote_id)
);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
CREATE INDEX IF NOT EXISTS sessions_owner_updated_idx ON sessions(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_owner_source_created_idx ON sessions(owner_id, source_created_at);
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
  owner_id TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  remote_id TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  projector_version TEXT NOT NULL DEFAULT 'legacy',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, remote_id, projector_version)
);
CREATE INDEX IF NOT EXISTS work_items_owner_updated_idx ON work_items(owner_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS session_projection_checkpoints (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  projector_version TEXT NOT NULL,
  next_expected_seq INTEGER NOT NULL CHECK (next_expected_seq > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, projector_version)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_projection_gaps (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  projector_version TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  reason TEXT NOT NULL CHECK (reason IN ('missing', 'out-of-order', 'failed')),
  resolved_at TEXT,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (session_id, projector_version, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS late_event_quarantine (
  owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  projector_version TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('late-event')),
  state TEXT NOT NULL CHECK (state IN ('quarantined', 'reopened')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reopened_at TEXT,
  PRIMARY KEY (session_id, seq, projector_version)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS late_event_quarantine_owner_state_idx ON late_event_quarantine(owner_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS late_event_quarantine_session_state_idx ON late_event_quarantine(session_id, state, seq);
CREATE TABLE IF NOT EXISTS projection_failures (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  projector_version TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  reason TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  PRIMARY KEY (session_id, projector_version, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS projection_effects (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  projector_version TEXT NOT NULL,
  seq INTEGER NOT NULL,
  effect_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, projector_version, seq, effect_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sse_outbox (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sse_outbox_owner_id_idx ON sse_outbox(owner_id, id);
CREATE TABLE IF NOT EXISTS snapshot_tokens (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
  watermark INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_rows (
  token TEXT NOT NULL REFERENCES snapshot_tokens(token) ON DELETE CASCADE,
  row_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (token, row_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS schema_fence (
  name TEXT PRIMARY KEY,
  min_version INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backfill_jobs (
  name TEXT PRIMARY KEY,
  cursor_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','paused','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  started_at TEXT,
  paused_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL
);
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
  actor_id TEXT,
  device_id TEXT,
  correlation_id TEXT,
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
CREATE TABLE IF NOT EXISTS owner_hierarchy_generation (
  owner_id TEXT PRIMARY KEY CHECK (length(trim(owner_id)) > 0),
  active_generation INTEGER NOT NULL DEFAULT 0 CHECK (active_generation >= 0),
  evidence_revision INTEGER NOT NULL DEFAULT 0 CHECK (evidence_revision >= 0),
  evidence_schema_epoch INTEGER NOT NULL DEFAULT 0 CHECK (evidence_schema_epoch >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_hierarchy_evidence (
  owner_id TEXT NOT NULL, adapter TEXT NOT NULL, source_key TEXT NOT NULL,
  session_id TEXT NOT NULL, identity_namespace TEXT NOT NULL,
  observed_parent_session_id TEXT, observed_parent_owner_id TEXT,
  direct_human_evidence INTEGER NOT NULL CHECK (direct_human_evidence IN (0, 1)),
  structural_kind TEXT NOT NULL CHECK (structural_kind IN ('direct', 'continuation', 'subagent', 'tool', 'review')),
  observation_state TEXT NOT NULL CHECK (observation_state IN ('valid', 'unreadable', 'missing-parent', 'conflict')),
  captured_epoch INTEGER NOT NULL CHECK (captured_epoch >= 0), deleted_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, adapter, source_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_hierarchy_evidence_owner_session_idx ON session_hierarchy_evidence(owner_id, session_id);
CREATE TABLE IF NOT EXISTS session_hierarchy_backfill_snapshot (
  owner_id TEXT NOT NULL, epoch INTEGER NOT NULL, cycle INTEGER NOT NULL,
  required_adapters_json TEXT NOT NULL CHECK (json_valid(required_adapters_json)),
  frozen_at TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, epoch, cycle)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_hierarchy_backfill_run (
  owner_id TEXT NOT NULL, adapter TEXT NOT NULL, epoch INTEGER NOT NULL, cycle INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('enumerating', 'reconciling', 'complete')),
  expected_source_keys INTEGER NOT NULL DEFAULT 0 CHECK (expected_source_keys >= 0),
  observed_source_keys INTEGER NOT NULL DEFAULT 0 CHECK (observed_source_keys >= 0),
  frozen_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, adapter, epoch, cycle),
  FOREIGN KEY (owner_id, epoch, cycle) REFERENCES session_hierarchy_backfill_snapshot(owner_id, epoch, cycle) DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_hierarchy_backfill_manifest (
  owner_id TEXT NOT NULL, adapter TEXT NOT NULL, epoch INTEGER NOT NULL, cycle INTEGER NOT NULL, source_key TEXT NOT NULL,
  PRIMARY KEY (owner_id, adapter, epoch, cycle, source_key),
  FOREIGN KEY (owner_id, adapter, epoch, cycle) REFERENCES session_hierarchy_backfill_run(owner_id, adapter, epoch, cycle) DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_hierarchy_projection (
  owner_id TEXT NOT NULL, generation INTEGER NOT NULL, session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('root', 'internal', 'unknown')),
  root_session_id TEXT, parent_session_id TEXT, unknown_reason TEXT,
  lineage_kind TEXT, internal_kind TEXT, subagent_identity TEXT,
  PRIMARY KEY (owner_id, generation, session_id),
  FOREIGN KEY (owner_id, generation, root_session_id) REFERENCES session_hierarchy_projection(owner_id, generation, session_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, generation, parent_session_id) REFERENCES session_hierarchy_projection(owner_id, generation, session_id) DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_hierarchy_projection_owner_generation_root_idx ON session_hierarchy_projection(owner_id, generation, root_session_id);
CREATE TABLE IF NOT EXISTS session_hierarchy_generation_lease (
  owner_id TEXT NOT NULL, generation INTEGER NOT NULL, ref_count INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0), updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, generation)
) WITHOUT ROWID;
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
CREATE TABLE IF NOT EXISTS corrupt_payloads (
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload_column TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (record_type, record_id, payload_column)
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
const tableSql = (database: Database, table: string): string | null =>
  (database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | null)?.sql ?? null;
const inTransaction = (database: Database, callback: () => void): void => {
  const savepoint = `migration_${crypto.randomUUID().replaceAll("-", "")}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    callback();
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (cause) {
    database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw cause;
  }
};
const migrateSseOutbox = (database: Database): void => {
  inTransaction(database, () => {
    const columns = columnsOf(database, "sse_outbox");
    if (columns.size === 0) return;
    const required = ["id", "session_id", "event_json", "created_at"];
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length) throw new Error(`Unsupported sse_outbox schema: missing columns ${missing.join(", ")}`);
    if (!columns.has("owner_id")) database.exec("ALTER TABLE sse_outbox ADD COLUMN owner_id TEXT");
    database.exec("UPDATE sse_outbox SET owner_id = (SELECT owner_id FROM sessions WHERE sessions.id = sse_outbox.session_id) WHERE owner_id IS NULL OR trim(owner_id) = '';");
    const unresolved = database.query(`
      SELECT id
      FROM sse_outbox
      WHERE session_id IS NULL
        OR owner_id IS NULL
        OR trim(owner_id) = ''
        OR NOT EXISTS (
          SELECT 1 FROM sessions
          WHERE sessions.id = sse_outbox.session_id AND sessions.owner_id = sse_outbox.owner_id
        )
      ORDER BY id
    `).all() as Array<{ id: number }>;
    if (unresolved.length > 0) {
      throw new Error(`Cannot migrate sse_outbox without a provable session owner; manual repair required: ${unresolved.map(({ id }) => id).join(",")}`);
    }
    const current = tableSql(database, "sse_outbox")?.replace(/\s+/g, " ") ?? "";
    const finalOwner = /owner_id\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*length\s*\(\s*trim\s*\(\s*owner_id\s*\)\s*\)\s*>\s*0\s*\)/i.test(current);
    const finalSession = /session_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+sessions\s*\(\s*id\s*\)/i.test(current);
    const noOwnerDefault = !/owner_id\s+TEXT[^,)]*\bDEFAULT\b/i.test(current);
    const sessionForeignKey = (database.query("PRAGMA foreign_key_list(sse_outbox)").all() as Array<{ table: string; from: string }>).some((key) => key.table === "sessions" && key.from === "session_id");
    const ownerIndex = database.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'sse_outbox_owner_id_idx'").get() !== null;
    if (finalOwner && finalSession && noOwnerDefault && sessionForeignKey && ownerIndex) return;
    database.exec(`
      DROP INDEX IF EXISTS sse_outbox_owner_id_idx;
      ALTER TABLE sse_outbox RENAME TO sse_outbox_legacy;
      CREATE TABLE sse_outbox (
        id INTEGER PRIMARY KEY,
        owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO sse_outbox (id, owner_id, session_id, event_json, created_at)
        SELECT legacy.id, legacy.owner_id, legacy.session_id, legacy.event_json, legacy.created_at
        FROM sse_outbox_legacy AS legacy
        JOIN sessions ON sessions.id = legacy.session_id AND sessions.owner_id = legacy.owner_id
        WHERE legacy.owner_id IS NOT NULL AND trim(legacy.owner_id) <> ''
        ORDER BY legacy.id;
      DROP TABLE sse_outbox_legacy;
      CREATE INDEX sse_outbox_owner_id_idx ON sse_outbox(owner_id, id);
    `);
  });
};
/**
 * M2--M7 tables are deliberately listed here rather than inferred from callers.
 * A database can have been opened by an older binary, so this is also the last
 * line of defence against silently accepting a partially-created migration.
 *
 * `copy`, `valid`, and `order` are intentionally table-specific.  A repair must
 * never guess an owner, coerce a value, or choose a duplicate winner.
 */
const m2SchemaManifest = {
  sessions: { columns: ["id", "owner_id", "adapter", "remote_id", "status", "reconciliation_epoch", "reconciled", "remote_revision", "epoch_owner", "epoch_claimed_at", "view_owner", "view_claimed_at", "control_mode", "origin", "transcript_status", "active_projector_version", "control_cutover_seq", "continuation_parent_id", "archived_at", "archive_reason", "archive_cursor_seq", "workdir", "source_created_at", "created_at", "updated_at"], foreignKeys: [["continuation_parent_id", "sessions"]], checks: ["control_mode", "origin", "transcript_status"], unique: [], indexes: ["sessions_status_idx", "sessions_owner_updated_idx", "sessions_owner_source_created_idx"] },
  work_items: { columns: ["id", "owner_id", "session_id", "remote_id", "state", "payload_json", "projector_version", "created_at", "updated_at"], foreignKeys: [["session_id", "sessions"]], checks: ["owner_id"], unique: [["session_id", "remote_id", "projector_version"]], indexes: ["work_items_owner_updated_idx"] },
  late_event_quarantine: { columns: ["owner_id", "session_id", "seq", "projector_version", "reason", "state", "created_at", "updated_at", "reopened_at"], foreignKeys: [["session_id", "sessions"]], checks: ["owner_id", "seq", "reason", "state"], unique: [["session_id", "seq", "projector_version"]], indexes: ["late_event_quarantine_owner_state_idx", "late_event_quarantine_session_state_idx"] },
  sse_outbox: { columns: ["id", "owner_id", "session_id", "event_json", "created_at"], foreignKeys: [["session_id", "sessions"]], checks: ["owner_id"], unique: [], indexes: ["sse_outbox_owner_id_idx"] },
  session_projection_checkpoints: { columns: ["session_id", "projector_version", "next_expected_seq", "updated_at"], foreignKeys: [["session_id", "sessions"]], checks: ["next_expected_seq"], unique: [["session_id", "projector_version"]], indexes: [] },
  session_projection_gaps: { columns: ["session_id", "projector_version", "seq", "reason", "resolved_at", "detected_at"], foreignKeys: [["session_id", "sessions"]], checks: ["seq", "reason"], unique: [["session_id", "projector_version", "seq"]], indexes: [] },
  projection_failures: { columns: ["session_id", "projector_version", "seq", "reason", "failed_at"], foreignKeys: [["session_id", "sessions"]], checks: ["seq"], unique: [["session_id", "projector_version", "seq"]], indexes: [] },
  projection_effects: { columns: ["session_id", "projector_version", "seq", "effect_key", "created_at"], foreignKeys: [["session_id", "sessions"]], checks: [], unique: [["session_id", "projector_version", "seq", "effect_key"]], indexes: [] },
  snapshot_tokens: { columns: ["token", "owner_id", "watermark", "expires_at", "created_at"], foreignKeys: [], checks: ["owner_id"], unique: [], indexes: [] },
  snapshot_rows: { columns: ["token", "row_key", "payload_json"], foreignKeys: [["token", "snapshot_tokens"]], checks: [], unique: [["token", "row_key"]], indexes: [] },
  backfill_jobs: { columns: ["name", "cursor_json", "state", "attempts", "started_at", "paused_at", "completed_at", "failed_at", "error", "updated_at"], foreignKeys: [], checks: ["state", "attempts"], unique: [], indexes: [] },
  schema_fence: { columns: ["name", "min_version", "active", "updated_at"], foreignKeys: [], checks: ["active"], unique: [], indexes: [] },
  audit_log: { columns: ["id", "action", "session_id", "command_id", "actor_id", "device_id", "correlation_id", "payload_json", "created_at"], foreignKeys: [["session_id", "sessions"], ["command_id", "commands"]], checks: [], unique: [], indexes: ["audit_log_session_created_idx"] },
} as const;

type RebuildDescriptor = { copy: string; valid: string; id: string; order: string };
const m2Rebuilds: Record<string, RebuildDescriptor> = {
  work_items: { copy: "id, owner_id, session_id, remote_id, state, payload_json, projector_version, created_at, updated_at", valid: "id IS NOT NULL AND length(trim(owner_id)) > 0 AND session_id IN (SELECT id FROM sessions) AND remote_id IS NOT NULL AND state IS NOT NULL AND payload_json IS NOT NULL AND projector_version IS NOT NULL AND created_at IS NOT NULL AND updated_at IS NOT NULL AND id = (SELECT MIN(candidate.id) FROM work_items_rebuilt AS candidate WHERE candidate.session_id = work_items_rebuilt.session_id AND candidate.remote_id = work_items_rebuilt.remote_id AND candidate.projector_version = work_items_rebuilt.projector_version)", id: "id", order: "id" },
  late_event_quarantine: { copy: "owner_id, session_id, seq, projector_version, reason, state, created_at, updated_at, reopened_at", valid: "length(trim(owner_id)) > 0 AND session_id IN (SELECT id FROM sessions) AND seq > 0 AND reason = 'late-event' AND state IN ('quarantined', 'reopened')", id: "session_id || ':' || seq || ':' || projector_version", order: "session_id, seq, projector_version" },
  sse_outbox: { copy: "id, owner_id, session_id, event_json, created_at", valid: "id IS NOT NULL AND length(trim(owner_id)) > 0 AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = sse_outbox_rebuilt.session_id AND sessions.owner_id = sse_outbox_rebuilt.owner_id) AND event_json IS NOT NULL AND created_at IS NOT NULL", id: "id", order: "id" },
  session_projection_checkpoints: { copy: "session_id, projector_version, next_expected_seq, updated_at", valid: "session_id IN (SELECT id FROM sessions) AND next_expected_seq > 0", id: "session_id || ':' || projector_version", order: "session_id, projector_version" },
  projection_failures: { copy: "session_id, projector_version, seq, reason, failed_at", valid: "session_id IN (SELECT id FROM sessions) AND seq > 0", id: "session_id || ':' || projector_version || ':' || seq", order: "session_id, projector_version, seq" },
  projection_effects: { copy: "session_id, projector_version, seq, effect_key, created_at", valid: "session_id IN (SELECT id FROM sessions) AND seq IS NOT NULL AND effect_key IS NOT NULL", id: "session_id || ':' || projector_version || ':' || seq || ':' || effect_key", order: "session_id, projector_version, seq, effect_key" },
  snapshot_rows: { copy: "token, row_key, payload_json", valid: "token IN (SELECT token FROM snapshot_tokens) AND row_key IS NOT NULL AND payload_json IS NOT NULL", id: "token || ':' || row_key", order: "token, row_key" },
  schema_fence: { copy: "name, min_version, active, updated_at", valid: "name IS NOT NULL AND min_version IS NOT NULL AND active IN (0, 1) AND updated_at IS NOT NULL", id: "name", order: "name" },
  audit_log: { copy: "id, action, session_id, command_id, actor_id, device_id, correlation_id, payload_json, created_at", valid: "id IS NOT NULL AND action IS NOT NULL AND (session_id IS NULL OR session_id IN (SELECT id FROM sessions)) AND (command_id IS NULL OR command_id IN (SELECT id FROM commands)) AND payload_json IS NOT NULL AND created_at IS NOT NULL", id: "id", order: "id" },
  snapshot_tokens: { copy: "token, owner_id, watermark, expires_at, created_at", valid: "token IS NOT NULL AND length(trim(owner_id)) > 0 AND watermark IS NOT NULL AND expires_at IS NOT NULL AND created_at IS NOT NULL", id: "token", order: "token" },
  backfill_jobs: { copy: "name, cursor_json, state, attempts, started_at, paused_at, completed_at, failed_at, error, updated_at", valid: "name IS NOT NULL AND cursor_json IS NOT NULL AND json_valid(cursor_json) AND state IN ('pending', 'running', 'paused', 'complete', 'failed') AND attempts >= 0 AND updated_at IS NOT NULL", id: "name", order: "name" },
};

const recreateM2Index = (database: Database, index: string): void => {
  const definitions: Record<string, string> = {
    sessions_status_idx: "CREATE INDEX sessions_status_idx ON sessions(status)",
    sessions_owner_updated_idx: "CREATE INDEX sessions_owner_updated_idx ON sessions(owner_id, updated_at DESC)",
    sessions_owner_source_created_idx: "CREATE INDEX sessions_owner_source_created_idx ON sessions(owner_id, source_created_at)",
    work_items_owner_updated_idx: "CREATE INDEX work_items_owner_updated_idx ON work_items(owner_id, updated_at DESC)",
    late_event_quarantine_owner_state_idx: "CREATE INDEX late_event_quarantine_owner_state_idx ON late_event_quarantine(owner_id, state, updated_at DESC)",
    late_event_quarantine_session_state_idx: "CREATE INDEX late_event_quarantine_session_state_idx ON late_event_quarantine(session_id, state, seq)",
    sse_outbox_owner_id_idx: "CREATE INDEX sse_outbox_owner_id_idx ON sse_outbox(owner_id, id)",
    audit_log_session_created_idx: "CREATE INDEX audit_log_session_created_idx ON audit_log(session_id, created_at)",
  };
  database.exec(definitions[index]!);
};

const m2ShapeMismatch = (database: Database, table: string, requirement: typeof m2SchemaManifest[keyof typeof m2SchemaManifest]): string | null => {
  const columns = columnsOf(database, table);
  const missing = requirement.columns.filter((column) => !columns.has(column));
  if (missing.length) return `missing columns ${missing.join(", ")}`;
  const sql = tableSql(database, table)?.replace(/\s+/g, " ") ?? "";
  for (const check of requirement.checks) if (!new RegExp(`\\b${check}\\b[^,]*CHECK\\s*\\(`, "i").test(sql)) return `missing check for ${check}`;
  const foreignKeys = database.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string }>;
  for (const [from, target] of requirement.foreignKeys) if (!foreignKeys.some((key) => key.from === from && key.table === target)) return `missing foreign key ${from} -> ${target}`;
  const indexes = database.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  for (const unique of requirement.unique) if (!indexes.some((index) => index.unique === 1 && (database.query(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map(({ name }) => name).join(",") === unique.join(","))) return `missing unique constraint (${unique.join(", ")})`;
  return null;
};

const rebuildM2Table = (database: Database, table: string, descriptor: RebuildDescriptor, reason: string): void => {
  const legacy = `${table}_rebuilt`;
  database.exec(`ALTER TABLE ${table} RENAME TO ${legacy};`);
  database.exec(schema);
  database.query(`INSERT OR IGNORE INTO corrupt_payloads (record_type, record_id, payload_column, payload_json, detected_at) SELECT ?, CAST(${descriptor.id} AS TEXT), 'row', ?, ? FROM ${legacy} WHERE NOT (${descriptor.valid}) ORDER BY ${descriptor.order}`).run(table, json("projection-diagnostics", { reason }), now());
  database.exec(`INSERT INTO ${table} (${descriptor.copy}) SELECT ${descriptor.copy} FROM ${legacy} WHERE ${descriptor.valid} ORDER BY ${descriptor.order}; DROP TABLE ${legacy};`);
};

const preflightM2Schema = (database: Database): void => {
  for (const [table, requirement] of Object.entries(m2SchemaManifest)) {
    const mismatch = m2ShapeMismatch(database, table, requirement);
    if (mismatch) {
      const descriptor = m2Rebuilds[table];
      if (!descriptor) throw new Error(`Unsupported ${table} schema: ${mismatch}; ownership/FK mapping is unrepairable`);
      rebuildM2Table(database, table, descriptor, mismatch);
    }
    for (const index of requirement.indexes) if (!database.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) recreateM2Index(database, index);
    const revalidated = m2ShapeMismatch(database, table, requirement);
    if (revalidated) throw new Error(`Unsupported ${table} schema after rebuild: ${revalidated}`);
  }
};
const validateSchema = (database: Database): void => {
  const requirements: Record<string, readonly string[]> = {
    work_items: ["id", "owner_id", "session_id", "remote_id", "state", "payload_json", "projector_version", "created_at", "updated_at"],
    pending_actions: ["id", "session_id", "owner_id", "remote_ref", "version", "state", "payload_json", "answer_json", "expires_at", "created_at", "updated_at"],
    backfill_jobs: ["name", "cursor_json", "state", "attempts", "started_at", "paused_at", "completed_at", "failed_at", "error", "updated_at"],
  };
  for (const [table, required] of Object.entries(requirements)) {
    const missing = required.filter((column) => !columnsOf(database, table).has(column));
    if (missing.length) throw new Error(`Unsupported ${table} schema: missing columns ${missing.join(", ")}`);
  }
  const requireShape = (table: string, pattern: RegExp, detail: string): void => {
    if (!pattern.test(tableSql(database, table)?.replace(/\s+/g, " ") ?? "")) throw new Error(`Unsupported ${table} schema: missing ${detail}`);
  };
  requireShape("work_items", /UNIQUE\s*\(\s*session_id\s*,\s*remote_id\s*,\s*projector_version\s*\)/i, "unique session remote projector constraint");
  requireShape("work_items", /length\s*\(\s*trim\s*\(\s*owner_id\s*\)\s*\)\s*>\s*0/i, "non-empty owner check");
  requireShape("pending_actions", /state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\(\s*'pending'\s*,\s*'dispatching'\s*,\s*'answered'\s*,\s*'cancelled'\s*,\s*'expired'\s*,\s*'unknown'\s*\)\s*\)/i, "supported state check");
  requireShape("backfill_jobs", /state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\(\s*'pending'\s*,\s*'running'\s*,\s*'paused'\s*,\s*'complete'\s*,\s*'failed'\s*\)\s*\)/i, "supported state check");
  requireShape("session_projection_gaps", /reason\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*reason\s+IN\s*\(\s*'missing'\s*,\s*'out-of-order'\s*,\s*'failed'\s*\)\s*\)/i, "canonical projection gap reason check");
  requireShape("sse_outbox", /owner_id\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*length\s*\(\s*trim\s*\(\s*owner_id\s*\)\s*\)\s*>\s*0\s*\)/i, "non-empty owner check");
  requireShape("sse_outbox", /owner_id\s+TEXT(?![^,)]*\bDEFAULT\b)\s+NOT\s+NULL\s+CHECK\s*\(\s*length\s*\(\s*trim\s*\(\s*owner_id\s*\)\s*\)\s*>\s*0\s*\)/i, "owner without a default and with a non-empty check");
  requireShape("sse_outbox", /session_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+sessions\s*\(\s*id\s*\)/i, "required session foreign key");
  for (const [table, target] of [["work_items", "sessions"], ["pending_actions", "sessions"]] as const) {
    if (!(database.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).some((key) => key.table === target)) throw new Error(`Unsupported ${table} schema: missing foreign key to ${target}`);
  }
  if (!(database.query("PRAGMA foreign_key_list(sse_outbox)").all() as Array<{ table: string; from: string }>).some((key) => key.table === "sessions" && key.from === "session_id")) throw new Error("Unsupported sse_outbox schema: missing foreign key to sessions");
  for (const index of ["work_items_owner_updated_idx", "pending_actions_state_expires_idx", "sse_outbox_owner_id_idx"]) {
    if (!database.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) throw new Error(`Unsupported schema: missing index ${index}`);
  }
};
const redactPersistedDiagnostics = (database: Database): void => {
  const projectionFailures = database.query("SELECT session_id, projector_version, seq, reason FROM projection_failures").all() as Array<{ session_id: string; projector_version: string; seq: number; reason: string }>;
  for (const failure of projectionFailures) database.query("UPDATE projection_failures SET reason = ? WHERE session_id = ? AND projector_version = ? AND seq = ?").run(redactDiagnostic("projection-diagnostics", failure.reason), failure.session_id, failure.projector_version, failure.seq);

  const backfillJobs = database.query("SELECT name, error FROM backfill_jobs WHERE error IS NOT NULL").all() as Array<{ name: string; error: string }>;
  for (const job of backfillJobs) database.query("UPDATE backfill_jobs SET error = ? WHERE name = ?").run(redactDiagnostic("projection-diagnostics", job.error), job.name);

  const corruptPayloads = database.query("SELECT record_type, record_id, payload_column, payload_json FROM corrupt_payloads").all() as Array<{ record_type: string; record_id: string; payload_column: string; payload_json: string }>;
  for (const payload of corruptPayloads) database.query("UPDATE corrupt_payloads SET payload_json = ? WHERE record_type = ? AND record_id = ? AND payload_column = ?").run(redactDiagnostic("projection-diagnostics", payload.payload_json), payload.record_type, payload.record_id, payload.payload_column);

  const audits = database.query("SELECT rowid, payload_json FROM audit_log").all() as Array<{ rowid: number; payload_json: string }>;
  for (const audit of audits) {
    const safe = redactDiagnostic("audit", audit.payload_json);
    if (safe !== audit.payload_json) database.query("UPDATE audit_log SET payload_json = ? WHERE rowid = ?").run(json("audit", safe), audit.rowid);
  }
};

const repairBackfillJobs = (database: Database): void => {
  const columns = columnsOf(database, "backfill_jobs");
  if (columns.size === 0) return;
  const required = ["name", "cursor_json", "state", "attempts", "started_at", "completed_at", "error", "updated_at"];
  if (!required.every((column) => columns.has(column))) {
    database.exec(`
      ALTER TABLE backfill_jobs RENAME TO backfill_jobs_legacy;
      INSERT OR IGNORE INTO corrupt_payloads (record_type, record_id, payload_column, payload_json, detected_at)
        SELECT 'backfill_job', rowid, 'row', '{"reason":"unsupported legacy schema"}', '${now()}'
        FROM backfill_jobs_legacy;
      DROP TABLE backfill_jobs_legacy;
    `);
    return;
  }
  const definition = tableSql(database, "backfill_jobs")?.replace(/\s+/g, " ") ?? "";
  if (/CHECK\s*\(\s*state\s+IN\s*\(\s*'pending'\s*,\s*'running'\s*,\s*'paused'\s*,\s*'complete'\s*,\s*'failed'\s*\)\s*\)/i.test(definition)) return;

  database.exec(`
    ALTER TABLE backfill_jobs RENAME TO backfill_jobs_legacy;
    INSERT OR IGNORE INTO corrupt_payloads (record_type, record_id, payload_column, payload_json, detected_at)
      SELECT 'backfill_job', COALESCE(name, rowid), 'row',
        json_object('name', name, 'cursor_json', cursor_json, 'state', state), '${now()}'
      FROM backfill_jobs_legacy
      WHERE name IS NULL OR cursor_json IS NULL OR NOT json_valid(cursor_json)
        OR state NOT IN ('pending', 'running', 'paused', 'complete', 'failed');
    CREATE TABLE backfill_jobs (
      name TEXT PRIMARY KEY,
      cursor_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','running','paused','complete','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      started_at TEXT,
      paused_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      error TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO backfill_jobs (name, cursor_json, state, attempts, started_at, paused_at, completed_at, failed_at, error, updated_at)
      SELECT name, cursor_json, state, COALESCE(attempts, 0), started_at, ${columns.has("paused_at") ? "paused_at" : "NULL"}, completed_at, ${columns.has("failed_at") ? "failed_at" : "NULL"}, error, updated_at
      FROM backfill_jobs_legacy
      WHERE name IS NOT NULL AND cursor_json IS NOT NULL AND json_valid(cursor_json)
        AND state IN ('pending', 'running', 'paused', 'complete', 'failed')
        AND COALESCE(attempts, 0) >= 0 AND updated_at IS NOT NULL;
    DROP TABLE backfill_jobs_legacy;
  `);
};
const migrateProjectionGaps = (database: Database): void => {
  const existing = tableSql(database, "session_projection_gaps");
  if (!existing || /reason\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*reason\s+IN\s*\(\s*'missing'\s*,\s*'out-of-order'\s*,\s*'failed'\s*\)\s*\)/i.test(existing)) return;
  const invalid = database.query(`
    SELECT session_id, projector_version, seq, reason, resolved_at, detected_at
    FROM session_projection_gaps
    WHERE reason NOT IN ('missing', 'out-of-order', 'failed', 'projection-failure')
  `).all() as Array<{ session_id: string; projector_version: string; seq: number; reason: string; resolved_at: string | null; detected_at: string }>;
  for (const row of invalid) {
    database.query("INSERT OR IGNORE INTO corrupt_payloads (record_type, record_id, payload_column, payload_json, detected_at) VALUES (?, ?, ?, ?, ?)").run(
      "session_projection_gap",
      `${row.session_id}:${row.projector_version}:${row.seq}`,
      "reason",
      json("projection-diagnostics", { reason: row.reason }),
      row.detected_at,
    );
  }
  database.exec(`
    ALTER TABLE session_projection_gaps RENAME TO session_projection_gaps_legacy;
    CREATE TABLE session_projection_gaps (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      projector_version TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      reason TEXT NOT NULL CHECK (reason IN ('missing', 'out-of-order', 'failed')),
      resolved_at TEXT,
      detected_at TEXT NOT NULL,
      PRIMARY KEY (session_id, projector_version, seq)
    ) WITHOUT ROWID;
    INSERT INTO session_projection_gaps (session_id, projector_version, seq, reason, resolved_at, detected_at)
      SELECT session_id, projector_version, seq,
        CASE reason WHEN 'projection-failure' THEN 'failed' ELSE reason END,
        resolved_at, detected_at
      FROM session_projection_gaps_legacy
      WHERE reason IN ('missing', 'out-of-order', 'failed', 'projection-failure');
    DROP TABLE session_projection_gaps_legacy;
  `);
};

const migratePhase0 = (database: Database): void => {
  database.exec(migrationBootstrap);
  migrateSseOutbox(database);
  repairBackfillJobs(database);
  migrateProjectionGaps(database);
  const quarantineUnsupportedTable = (table: "work_items" | "pending_actions", required: readonly string[]): void => {
    const columns = columnsOf(database, table);
    if (columns.size === 0 || required.every((column) => columns.has(column))) return;
    database.exec(`
      ALTER TABLE ${table} RENAME TO ${table}_unsupported_legacy;
      INSERT OR IGNORE INTO corrupt_payloads (record_type, record_id, payload_column, payload_json, detected_at)
        SELECT '${table}', rowid, 'row', '{"reason":"unsupported legacy schema"}', '${now()}'
        FROM ${table}_unsupported_legacy;
      DROP TABLE ${table}_unsupported_legacy;
    `);
  };
  quarantineUnsupportedTable("work_items", ["id", "owner_id", "session_id", "remote_id", "state", "payload_json", "created_at", "updated_at"]);
  quarantineUnsupportedTable("pending_actions", ["id", "version", "state", "payload_json", "answer_json", "expires_at", "created_at", "updated_at"]);
  addMissingColumns(database, "sessions", [
    "owner_id TEXT", "epoch_owner TEXT", "epoch_claimed_at TEXT", "view_owner TEXT", "view_claimed_at TEXT",
    "control_mode TEXT NOT NULL DEFAULT 'view-only' CHECK (control_mode IN ('view-only', 'controlled'))",
    "origin TEXT NOT NULL DEFAULT 'ondisk-discovery' CHECK (origin IN ('ondisk-discovery', 'coordinator-start', 'coordinator-resume', 'coordinator-continuation', 'opencode-discovery'))",
    "transcript_status TEXT NOT NULL DEFAULT 'available' CHECK (transcript_status IN ('available', 'unreadable'))",
    "control_cutover_seq INTEGER", "continuation_parent_id TEXT REFERENCES sessions(id)", "archived_at TEXT",
    "archive_reason TEXT CHECK (archive_reason IN ('manual', 'retention'))", "archive_cursor_seq INTEGER CHECK (archive_cursor_seq IS NULL OR archive_cursor_seq > 0)",
    "active_projector_version TEXT", "title TEXT", "workdir TEXT", "source_created_at TEXT",
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
  if (columnsOf(database, "pending_actions").size > 0) addMissingColumns(database, "pending_actions", ["owner_id TEXT NOT NULL DEFAULT ''"]);
  if (columnsOf(database, "work_items").size > 0) addMissingColumns(database, "work_items", ["projector_version TEXT NOT NULL DEFAULT 'legacy'"]);
  if (columnsOf(database, "audit_log").size > 0) addMissingColumns(database, "audit_log", ["actor_id TEXT", "device_id TEXT", "correlation_id TEXT"]);
  if (columnsOf(database, "pending_actions").has("owner_id")) database.exec("UPDATE pending_actions SET owner_id = COALESCE((SELECT owner_id FROM sessions WHERE sessions.id = pending_actions.session_id), '') WHERE owner_id = ''");
  const unresolved = database.query("SELECT id FROM pending_actions WHERE trim(owner_id) = '' OR owner_id IS NULL").all() as Array<{ id: string }>;
  if (unresolved.length > 0) throw new Error(`Cannot migrate pending actions without a session owner: ${unresolved.map(({ id }) => id).join(",")}`);
  const pendingSchema = database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_actions'").get() as { sql: string } | null;
  if (pendingSchema?.sql.includes("DEFAULT ''") || !pendingSchema?.sql.includes("length(trim(owner_id)) > 0") || !pendingSchema?.sql.includes("REFERENCES sessions(id)") || !/state\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\(\s*'pending'\s*,\s*'dispatching'\s*,\s*'answered'\s*,\s*'cancelled'\s*,\s*'expired'\s*,\s*'unknown'\s*\)\s*\)/i.test(pendingSchema.sql)) {
    database.exec(`
      ALTER TABLE pending_actions RENAME TO pending_actions_owner_legacy;
      CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id),
        owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
        remote_ref TEXT,
        version INTEGER NOT NULL CHECK (version >= 1),
        state TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'answered', 'cancelled', 'expired', 'unknown')),
        payload_json TEXT NOT NULL,
        answer_json TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO pending_actions (id, session_id, owner_id, remote_ref, version, state, payload_json, answer_json, expires_at, created_at, updated_at)
        SELECT id, session_id, owner_id, remote_ref, version, state, payload_json, answer_json, expires_at, created_at, updated_at
        FROM pending_actions_owner_legacy;
      DROP TABLE pending_actions_owner_legacy;
    `);
  }
  const commandForeignKeys = database.query("PRAGMA foreign_key_list(commands)").all() as Array<{ table: string }>;
  if (commandForeignKeys.some(({ table }) => table === "pending_actions_owner_legacy")) {
    database.exec(`
      ALTER TABLE commands RENAME TO commands_pending_action_legacy;
      CREATE TABLE commands (
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
      INSERT INTO commands (id, session_id, idempotency_key, state, correlation_id, attempt, lease_expires_at, claimed_epoch, claimed_epoch_owner, pending_action_id, payload_json, created_at, updated_at)
        SELECT id, session_id, idempotency_key, state, correlation_id, attempt, lease_expires_at, claimed_epoch, claimed_epoch_owner, pending_action_id, payload_json, created_at, updated_at
        FROM commands_pending_action_legacy;
      DROP TABLE commands_pending_action_legacy;
    `);
  }
};

interface SessionRow {
  id: string; owner_id: string | null; adapter: string; remote_id: string; status: SessionStatus;
  reconciliation_epoch: number; reconciled: number; remote_revision: string | null;
  control_mode: SessionControlMode; origin: SessionOrigin; transcript_status: TranscriptStatus; active_projector_version: string | null; archived_at: string | null; continuation_parent_id: string | null;
  title: string | null; workdir: string | null; source_created_at: string | null; created_at: string; updated_at: string;
}
interface EventRow { session_id: string; seq: number; type: string; payload_json: string; created_at: string; }
interface CommandRow { id: string; session_id: string; idempotency_key: string; state: CommandState; correlation_id: string | null; attempt: number; lease_expires_at: string | null; payload_json: string; created_at: string; updated_at: string; }
interface AuditRow { id: number; action: string; session_id: string | null; command_id: string | null; actor_id: string | null; device_id: string | null; correlation_id: string | null; payload_json: string; created_at: string; }
interface PendingActionRow { id: string; session_id: string | null; owner_id: string; version: number; state: PendingActionState; payload_json: string; answer_json: string | null; expires_at: string; created_at: string; updated_at: string; }
interface WorkItemRow { id: string; owner_id: string; session_id: string; remote_id: string; state: string; projector_version: string; payload_json: string; created_at: string; updated_at: string; }
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
const SSE_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const CONTINUATION_EVENT_SEQ_STRIDE = 10_000_000;
const continuationGlobalSeq = (segmentIndex: number, localSeq: number): number => {
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0 || !Number.isSafeInteger(localSeq) || localSeq < 1 || localSeq >= CONTINUATION_EVENT_SEQ_STRIDE) throw new Error("Invalid continuation event sequence");
  const globalSeq = segmentIndex * CONTINUATION_EVENT_SEQ_STRIDE + localSeq;
  if (!Number.isSafeInteger(globalSeq)) throw new Error("Continuation event sequence exceeds safe integer range");
  return globalSeq;
};
const SSE_OUTBOX_MAX_ROWS_PER_OWNER = 10_000;
const json = (sink: SinkKind, value: unknown): string => JSON.stringify(redactForSink(sink, value));
/** Commands are durable but intentionally not an authoritative §3 sink. */
const commandJson = (value: unknown): string => JSON.stringify(redactForCommand(value));
const projectionGapReason = (reason: "out-of-order" | "failed"): string => redactForSink("projection-diagnostics", reason) as string;
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
    transcriptStatus: row.transcript_status, activeProjectorVersion: row.active_projector_version, archivedAt: row.archived_at, title: row.title, workdir: row.workdir,
    sourceCreatedAt: row.source_created_at, createdAt: row.created_at, updatedAt: row.updated_at, continuationParentId: row.continuation_parent_id,
  };
};
const asEvent = <T>(row: EventRow): SessionEvent<T> => ({ sessionId: row.session_id, seq: row.seq, type: row.type, payload: decodeJson<T>(row.payload_json, `event ${row.session_id}:${row.seq}`), createdAt: row.created_at });
const asCommand = <T>(row: CommandRow): Command<T> => ({ id: row.id, sessionId: row.session_id, idempotencyKey: row.idempotency_key, state: row.state, correlationId: row.correlation_id, attempt: row.attempt, leaseExpiresAt: row.lease_expires_at, payload: decodeJson<T>(row.payload_json, `command ${row.id}`), createdAt: row.created_at, updatedAt: row.updated_at });
const asAudit = <T>(row: AuditRow): AuditEntry<T> => ({ id: row.id, action: row.action, sessionId: row.session_id, commandId: row.command_id, actorId: row.actor_id, deviceId: row.device_id, correlationId: row.correlation_id, payload: decodeJson<T>(row.payload_json, `audit ${row.id}`), createdAt: row.created_at });
const asPushSubscription = (row: PushSubscriptionRow): StoredPushSubscription => ({ ownerId: row.owner_id, endpointHash: row.endpoint_hash, encryptedMaterial: row.encrypted_material, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at });
const asDeviceCredential = (row: DeviceCredentialRow): DeviceCredential => ({ id: row.id, ownerId: row.owner_id, deviceName: row.device_name, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });

export class CoreDatabase {
  readonly sqlite: Database;
  readonly filename: string;
  private transactionDepth = 0;
  private readonly readOnly: boolean;
  private readonly generationRefs = new Map<string, number>();
  private generationRefKey(ownerId: string, generation: number): string { return `${ownerId}\u0000${generation}`; }
  getHierarchyGeneration(ownerId: string): HierarchyGeneration | null {
    const row = this.sqlite.query(`SELECT owner_id, active_generation, evidence_revision, evidence_schema_epoch, updated_at FROM owner_hierarchy_generation WHERE owner_id=?`).get(ownerId) as { owner_id: string; active_generation: number; evidence_revision: number; evidence_schema_epoch: number; updated_at: string } | null;
    return row === null ? null : { ownerId: row.owner_id, activeGeneration: row.active_generation, evidenceRevision: row.evidence_revision, evidenceSchemaEpoch: row.evidence_schema_epoch, updatedAt: row.updated_at };
  }

  listSessionHierarchyEvidence(ownerId: string): SessionHierarchyEvidence[] {
    return (this.sqlite.query(`SELECT owner_id, adapter, source_key, session_id, identity_namespace, observed_parent_session_id, observed_parent_owner_id, direct_human_evidence, structural_kind, observation_state, captured_epoch, deleted_at FROM session_hierarchy_evidence WHERE owner_id=? ORDER BY adapter, source_key`).all(ownerId) as Array<{ owner_id: string; adapter: string; source_key: string; session_id: string; identity_namespace: string; observed_parent_session_id: string | null; observed_parent_owner_id: string | null; direct_human_evidence: number; structural_kind: SessionHierarchyEvidence["structuralKind"]; observation_state: SessionHierarchyEvidence["observationState"]; captured_epoch: number; deleted_at: string | null }>).map((row) => ({ ownerId: row.owner_id, adapter: row.adapter, sourceKey: row.source_key, sessionId: row.session_id, identityNamespace: row.identity_namespace, observedParentSessionId: row.observed_parent_session_id, observedParentOwnerId: row.observed_parent_owner_id, directHumanEvidence: row.direct_human_evidence === 1, structuralKind: row.structural_kind, observationState: row.observation_state, capturedEpoch: row.captured_epoch, deletedAt: row.deleted_at }));
  }

  resetHierarchyGenerationLeases(): void {
    this.generationRefs.clear();
    this.sqlite.query(`UPDATE session_hierarchy_generation_lease SET ref_count=0, updated_at=?`).run(now());
  }

  beginHierarchyBackfillCycle(ownerId: string, input: { epoch: number; requiredAdapters: readonly string[] }): HierarchyBackfillCycle {
    return this.transaction(() => {
      const requiredAdapters = [...new Set(input.requiredAdapters)].sort();
      const row = this.sqlite.query(`SELECT COALESCE(MAX(cycle), 0) + 1 cycle FROM session_hierarchy_backfill_snapshot WHERE owner_id=? AND epoch=?`).get(ownerId, input.epoch) as { cycle: number };
      this.createHierarchyBackfillSnapshot(ownerId, input.epoch, row.cycle, requiredAdapters);
      return { ownerId, epoch: input.epoch, cycle: row.cycle, requiredAdapters, frozenAt: null };
    });
  }

  getHierarchyReadiness(ownerId: string, requiredEpoch: number, cycle: number): HierarchyReadiness {
    const generation = this.getHierarchyGeneration(ownerId);
    const coverageGapCount = this.hierarchyCoverageGapCount(ownerId, requiredEpoch, cycle);
    const evidenceSchemaEpoch = generation?.evidenceSchemaEpoch ?? 0;
    return { ownerId, evidenceSchemaEpoch, requiredEpoch, coverageGapCount, ready: evidenceSchemaEpoch >= requiredEpoch && coverageGapCount === 0 };
  }
  classifyAndProjectSessionHierarchy(ownerId: string, generation: number, backfill: { epoch: number; cycle: number } | null = null): void {
    this.transaction(() => {
      const projections = classifyOwnerGraph(ownerId, this.listSessionHierarchyEvidence(ownerId)).map((row) => ({ ...row, generation }));
      this.projectSessionHierarchy(ownerId, generation, projections, backfill);
    });
  }

  upsertSessionHierarchyEvidence(evidence: SessionHierarchyEvidence): void {
    this.transaction(() => {
      const timestamp = now();
      this.sqlite.query(`INSERT INTO session_hierarchy_evidence (owner_id, adapter, source_key, session_id, identity_namespace, observed_parent_session_id, observed_parent_owner_id, direct_human_evidence, structural_kind, observation_state, captured_epoch, deleted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, adapter, source_key) DO UPDATE SET session_id=excluded.session_id, identity_namespace=excluded.identity_namespace, observed_parent_session_id=excluded.observed_parent_session_id, observed_parent_owner_id=excluded.observed_parent_owner_id, direct_human_evidence=excluded.direct_human_evidence, structural_kind=excluded.structural_kind, observation_state=excluded.observation_state, captured_epoch=excluded.captured_epoch, deleted_at=excluded.deleted_at, updated_at=excluded.updated_at`).run(evidence.ownerId, evidence.adapter, evidence.sourceKey, evidence.sessionId, evidence.identityNamespace, evidence.observedParentSessionId, evidence.observedParentOwnerId, evidence.directHumanEvidence ? 1 : 0, evidence.structuralKind, evidence.observationState, evidence.capturedEpoch, evidence.deletedAt, timestamp);
      this.sqlite.query(`INSERT INTO owner_hierarchy_generation (owner_id, updated_at) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET evidence_revision=evidence_revision+1, updated_at=excluded.updated_at`).run(evidence.ownerId, timestamp);
    });
  }

  createHierarchyBackfillSnapshot(ownerId: string, epoch: number, cycle: number, requiredAdapters: readonly string[]): void {
    this.sqlite.query(`INSERT INTO session_hierarchy_backfill_snapshot (owner_id, epoch, cycle, required_adapters_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(ownerId, epoch, cycle, JSON.stringify([...new Set(requiredAdapters)].sort()), now());
  }
  upsertHierarchyBackfillRun(input: { ownerId: string; adapter: string; epoch: number; cycle: number; state: "enumerating" | "reconciling" | "complete"; expectedSourceKeys: number; observedSourceKeys: number; frozenAt: string | null }): void {
    this.transaction(() => {
      const snapshot = this.sqlite.query(`SELECT frozen_at FROM session_hierarchy_backfill_snapshot WHERE owner_id=? AND epoch=? AND cycle=?`).get(input.ownerId, input.epoch, input.cycle) as { frozen_at: string | null } | null;
      if (!snapshot) throw new Error("Backfill snapshot does not exist");
      if (snapshot.frozen_at !== null) throw new Error("Frozen backfill snapshot is immutable");
      const run = this.sqlite.query(`SELECT state, expected_source_keys, observed_source_keys, frozen_at FROM session_hierarchy_backfill_run WHERE owner_id=? AND adapter=? AND epoch=? AND cycle=?`).get(input.ownerId, input.adapter, input.epoch, input.cycle) as { state: string; expected_source_keys: number; observed_source_keys: number; frozen_at: string | null } | null;
      if (run !== null && run.frozen_at !== null) {
        if (run.state !== input.state || run.expected_source_keys !== input.expectedSourceKeys || run.observed_source_keys !== input.observedSourceKeys || run.frozen_at !== input.frozenAt) throw new Error("Frozen backfill run is immutable");
        return;
      }
      this.sqlite.query(`INSERT INTO session_hierarchy_backfill_run (owner_id, adapter, epoch, cycle, state, expected_source_keys, observed_source_keys, frozen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, adapter, epoch, cycle) DO UPDATE SET state=excluded.state, expected_source_keys=excluded.expected_source_keys, observed_source_keys=excluded.observed_source_keys, frozen_at=excluded.frozen_at, updated_at=excluded.updated_at`).run(input.ownerId, input.adapter, input.epoch, input.cycle, input.state, input.expectedSourceKeys, input.observedSourceKeys, input.frozenAt, now());
    });
  }
  addHierarchyBackfillManifestEntry(ownerId: string, adapter: string, epoch: number, cycle: number, sourceKey: string): void {
    const run = this.sqlite.query(`SELECT frozen_at FROM session_hierarchy_backfill_run WHERE owner_id=? AND adapter=? AND epoch=? AND cycle=?`).get(ownerId, adapter, epoch, cycle) as { frozen_at: string | null } | null;
    if (!run) throw new Error("Backfill run does not exist");
    if (run.frozen_at !== null) throw new Error("Frozen backfill manifest is immutable");
    this.sqlite.query(`INSERT OR IGNORE INTO session_hierarchy_backfill_manifest (owner_id, adapter, epoch, cycle, source_key) VALUES (?, ?, ?, ?, ?)`).run(ownerId, adapter, epoch, cycle, sourceKey);
  }
  freezeHierarchyBackfillSnapshot(ownerId: string, epoch: number, cycle: number): void {
    this.transaction(() => {
      const snapshot = this.sqlite.query(`SELECT required_adapters_json, frozen_at FROM session_hierarchy_backfill_snapshot WHERE owner_id=? AND epoch=? AND cycle=?`).get(ownerId, epoch, cycle) as { required_adapters_json: string; frozen_at: string | null } | null;
      if (!snapshot) throw new Error("Backfill snapshot does not exist");
      if (snapshot.frozen_at !== null) return;
      const incomplete = this.sqlite.query(`SELECT 1 FROM json_each(?) required LEFT JOIN session_hierarchy_backfill_run run ON run.owner_id=? AND run.epoch=? AND run.cycle=? AND run.adapter=required.value WHERE run.adapter IS NULL OR run.state<>'complete' OR run.frozen_at IS NULL OR run.expected_source_keys<>run.observed_source_keys LIMIT 1`).get(snapshot.required_adapters_json, ownerId, epoch, cycle);
      if (incomplete) throw new Error("Every required backfill run must complete, match counts, and freeze before its snapshot");
      this.sqlite.query(`UPDATE session_hierarchy_backfill_snapshot SET frozen_at=? WHERE owner_id=? AND epoch=? AND cycle=?`).run(now(), ownerId, epoch, cycle);
    });
  }
  hierarchyCoverageGapCount(ownerId: string, epoch: number, cycle: number): number {
    const row = this.sqlite.query(`SELECT CASE WHEN s.frozen_at IS NULL THEN 1 ELSE (SELECT count(*) FROM json_each(s.required_adapters_json) a LEFT JOIN session_hierarchy_backfill_run r ON r.owner_id=s.owner_id AND r.epoch=s.epoch AND r.cycle=s.cycle AND r.adapter=a.value WHERE r.adapter IS NULL OR r.state <> 'complete' OR r.frozen_at IS NULL OR r.expected_source_keys <> r.observed_source_keys) + (SELECT count(*) FROM session_hierarchy_backfill_manifest m LEFT JOIN session_hierarchy_evidence e ON e.owner_id=m.owner_id AND e.adapter=m.adapter AND e.source_key=m.source_key AND e.captured_epoch=m.epoch WHERE m.owner_id=s.owner_id AND m.epoch=s.epoch AND m.cycle=s.cycle AND (e.source_key IS NULL OR e.observation_state NOT IN ('valid','unreadable','missing-parent','conflict'))) END gaps FROM session_hierarchy_backfill_snapshot s WHERE s.owner_id=? AND s.epoch=? AND s.cycle=?`).get(ownerId, epoch, cycle) as { gaps: number } | null;
    return row?.gaps ?? Number.MAX_SAFE_INTEGER;
  }
  projectSessionHierarchy(ownerId: string, generation: number, rows: readonly SessionHierarchyProjection[], backfill: { epoch: number; cycle: number } | null = null): void {
    this.transaction(() => {
      if (rows.some((row) => row.ownerId !== ownerId || row.generation !== generation)) throw new Error("Projection owner or generation mismatch");
      for (const row of rows) this.sqlite.query(`INSERT INTO session_hierarchy_projection (owner_id, generation, session_id, kind, root_session_id, parent_session_id, unknown_reason, lineage_kind, internal_kind, subagent_identity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.ownerId, row.generation, row.sessionId, row.kind, row.rootSessionId, row.parentSessionId, row.unknownReason, row.lineageKind, row.internalKind, row.subagentIdentity);
      const nodeCount = (this.sqlite.query(`SELECT count(*) AS count FROM session_hierarchy_projection WHERE owner_id=? AND generation=?`).get(ownerId, generation) as { count: number }).count;
      if (nodeCount !== rows.length) throw new Error("Incomplete hierarchy projection node count");
      const invalid = this.sqlite.query(`SELECT 1 FROM session_hierarchy_projection p LEFT JOIN session_hierarchy_projection r ON r.owner_id=p.owner_id AND r.generation=p.generation AND r.session_id=p.root_session_id LEFT JOIN session_hierarchy_projection parent ON parent.owner_id=p.owner_id AND parent.generation=p.generation AND parent.session_id=p.parent_session_id WHERE p.owner_id=? AND p.generation=? AND ((p.kind='root' AND (p.root_session_id<>p.session_id OR p.parent_session_id IS NOT NULL)) OR (p.kind='internal' AND (r.kind<>'root' OR p.parent_session_id IS NULL OR parent.kind NOT IN ('root','internal'))) OR (p.kind='unknown' AND p.root_session_id IS NOT NULL)) LIMIT 1`).get(ownerId, generation);
      if (invalid) throw new Error("Invalid hierarchy projection graph");
      const continuationRows = this.sqlite.query("SELECT id, continuation_parent_id FROM sessions WHERE owner_id=?").all(ownerId) as Array<{ id: string; continuation_parent_id: string | null }>;
      const parents = new Map(continuationRows.map((row) => [row.id, row.continuation_parent_id]));
      for (const id of parents.keys()) {
        const seen = new Set<string>();
        for (let current: string | null = id; current !== null; current = parents.get(current) ?? null) {
          if (seen.has(current) || !parents.has(current)) throw new Error("Invalid continuation lineage");
          seen.add(current);
        }
      }
      const gaps = backfill ? this.hierarchyCoverageGapCount(ownerId, backfill.epoch, backfill.cycle) : 0;
      if (gaps) throw new Error(`Hierarchy backfill incomplete: ${gaps} gap(s)`);
      this.sqlite.query(`INSERT INTO owner_hierarchy_generation (owner_id, active_generation, evidence_schema_epoch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET active_generation=excluded.active_generation, evidence_schema_epoch=CASE WHEN ?=0 THEN excluded.evidence_schema_epoch ELSE owner_hierarchy_generation.evidence_schema_epoch END, updated_at=excluded.updated_at`).run(ownerId, generation, backfill?.epoch ?? 0, now(), gaps);
    });
  }
  acquireGenerationLease(ownerId: string): number {
    return this.transaction(() => {
      const state = this.sqlite.query(`SELECT active_generation FROM owner_hierarchy_generation WHERE owner_id=?`).get(ownerId) as { active_generation: number } | null;
      const generation = state?.active_generation ?? 0, key = this.generationRefKey(ownerId, generation);
      this.generationRefs.set(key, (this.generationRefs.get(key) ?? 0) + 1);
      this.sqlite.query(`INSERT INTO session_hierarchy_generation_lease (owner_id, generation, ref_count, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(owner_id, generation) DO UPDATE SET ref_count=ref_count+1, updated_at=excluded.updated_at`).run(ownerId, generation, now());
      return generation;
    });
  }
  releaseGenerationLease(ownerId: string, generation: number): void {
    const key = this.generationRefKey(ownerId, generation), refs = this.generationRefs.get(key) ?? 0;
    if (refs <= 0) throw new Error("Generation lease was not acquired");
    if (refs === 1) this.generationRefs.delete(key); else this.generationRefs.set(key, refs - 1);
    this.sqlite.query(`UPDATE session_hierarchy_generation_lease SET ref_count=MAX(0, ref_count-1), updated_at=? WHERE owner_id=? AND generation=?`).run(now(), ownerId, generation);
  }
  pruneOldGenerations(ownerId: string): number {
    const active = (this.sqlite.query(`SELECT active_generation FROM owner_hierarchy_generation WHERE owner_id=?`).get(ownerId) as { active_generation: number } | null)?.active_generation;
    if (active === undefined) return 0;
    let deleted = 0;
    for (const { generation } of this.sqlite.query(`SELECT DISTINCT generation FROM session_hierarchy_projection WHERE owner_id=? AND generation<>?`).all(ownerId, active) as Array<{ generation: number }>) if ((this.generationRefs.get(this.generationRefKey(ownerId, generation)) ?? 0) === 0) deleted += this.sqlite.query(`DELETE FROM session_hierarchy_projection WHERE owner_id=? AND generation=?`).run(ownerId, generation).changes;
    return deleted;
  }
  hierarchyRollups(ownerId: string, generation = (this.sqlite.query(`SELECT active_generation FROM owner_hierarchy_generation WHERE owner_id=?`).get(ownerId) as { active_generation: number } | null)?.active_generation ?? 0): SessionHierarchyRollup[] {
    return this.sqlite.query(`SELECT p.root_session_id AS rootSessionId, SUM(CASE WHEN p.kind='internal' AND s.continuation_parent_id IS NULL THEN 1 ELSE 0 END) AS internalCount, COALESCE(a.actionableCount,0) AS actionableCount, SUM(CASE WHEN p.kind='internal' AND p.lineage_kind<>'continuation' AND s.status IN ('stale','unknown') THEN 1 ELSE 0 END) AS failureCount, MAX(s.updated_at) AS lastActivityAt FROM session_hierarchy_projection p LEFT JOIN sessions s ON s.id=p.session_id AND s.owner_id=p.owner_id LEFT JOIN (SELECT hierarchy.root_session_id, count(*) actionableCount FROM pending_actions pa JOIN session_hierarchy_projection hierarchy ON hierarchy.owner_id=pa.owner_id AND hierarchy.session_id=pa.session_id WHERE pa.owner_id=? AND pa.state IN ('pending','dispatching','unknown') AND hierarchy.generation=? AND hierarchy.kind IN ('root','internal') GROUP BY hierarchy.root_session_id) a ON a.root_session_id=p.root_session_id WHERE p.owner_id=? AND p.generation=? AND p.kind IN ('root','internal') GROUP BY p.root_session_id`).all(ownerId, generation, ownerId, generation) as SessionHierarchyRollup[];
  }

  constructor(filename = ":memory:", options: { readonly?: boolean } = {}) {
    this.filename = filename;
    this.readOnly = options.readonly === true;
    this.sqlite = new Database(filename, { create: !this.readOnly, readonly: this.readOnly, strict: true });
    this.sqlite.exec(this.readOnly ? "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;" : "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (this.readOnly) {
      validateSchema(this.sqlite);
      return;
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      migratePhase0(this.sqlite);
      this.sqlite.exec(schema);
      preflightM2Schema(this.sqlite);
      redactPersistedDiagnostics(this.sqlite);
      validateSchema(this.sqlite);
      this.sqlite.query("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, 'phase-0-runtime-foundation', ?)").run(now());
      this.sqlite.exec("PRAGMA user_version = 1");
      this.sqlite.query("INSERT INTO schema_fence (name, min_version, active, updated_at) VALUES ('phase-0-runtime-foundation', 1, 1, ?) ON CONFLICT(name) DO UPDATE SET min_version = excluded.min_version, active = excluded.active, updated_at = excluded.updated_at").run(now());
      this.sqlite.query("INSERT INTO schema_fence (name, min_version, active, updated_at) VALUES ('min_binary_version', 1, 1, ?) ON CONFLICT(name) DO UPDATE SET min_version = excluded.min_version, active = excluded.active, updated_at = excluded.updated_at").run(now());
      this.sqlite.query("INSERT OR IGNORE INTO backfill_jobs (name, cursor_json, state, updated_at) VALUES ('pending-actions-owner', '{}', 'complete', ?)").run(now());
      this.sqlite.query("INSERT OR IGNORE INTO backfill_jobs (name, cursor_json, state, updated_at) VALUES ('historical-projection-v1', '{}', 'pending', ?)").run(now());
      this.sqlite.query("INSERT OR IGNORE INTO backfill_jobs (name, cursor_json, state, updated_at) VALUES ('historical-archive-backfill-v1', '{}', 'pending', ?)").run(now());
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
    this.sqlite.query("INSERT OR IGNORE INTO corrupt_payloads (record_type, record_id, payload_column, payload_json, detected_at) VALUES (?, ?, ?, ?, ?)").run(recordType, recordId, payloadColumn, json("projection-diagnostics", { reason: redactDiagnostic("projection-diagnostics", payload) }), now());
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
    return { id: row.id, sessionId: row.session_id, ownerId: row.owner_id, version: row.version, state: row.state, payload, answer, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private workItem<T>(row: WorkItemRow): WorkItem<T> {
    return { id: row.id, ownerId: row.owner_id, sessionId: row.session_id, remoteId: row.remote_id, state: row.state, projectorVersion: row.projector_version, payload: this.corrupt("work_item", row.id, "payload_json", row.payload_json, () => decodeJson<T>(row.payload_json, `work item ${row.id}`)), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private enqueueMobileState(ownerId: string, sessionId: string | null, type: string, payload: unknown): void {
    if (sessionId === null) return;
    const session = this.getSessionForOwner(sessionId, ownerId);
    if (!session) throw new Error("SSE state requires an owned session");
    this.sqlite.query("INSERT INTO sse_outbox (owner_id, session_id, event_json, created_at) VALUES (?, ?, ?, ?)").run(ownerId, session.id, json("sse-outbox", { type, sessionId, payload }), now());
    this.pruneSseOutbox(ownerId);
  }
  private pruneSseOutbox(ownerId: string): void {
    const cutoff = new Date(Date.now() - SSE_OUTBOX_RETENTION_MS).toISOString();
    this.sqlite.query("DELETE FROM sse_outbox WHERE owner_id = ? AND created_at < ?").run(ownerId, cutoff);
    this.sqlite.query("DELETE FROM sse_outbox WHERE id IN (SELECT id FROM sse_outbox WHERE owner_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?)").run(ownerId, SSE_OUTBOX_MAX_ROWS_PER_OWNER);
  }

  private quarantineLateEvent(session: Session, seq: number): void {
    this.sqlite.query(`
      INSERT OR IGNORE INTO late_event_quarantine (
        owner_id, session_id, seq, projector_version, reason, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'late-event', 'quarantined', ?, ?)
    `).run(session.ownerId, session.id, seq, session.activeProjectorVersion ?? "legacy", now(), now());
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

  createSession(input: Pick<Session, "id" | "ownerId" | "adapter" | "remoteId"> & { continuationParentId?: string | null }): Session {
    if (!input.ownerId) throw new TypeError("Session owner is required");
    return this.transaction(() => {
      if (input.continuationParentId !== undefined && input.continuationParentId !== null && !this.getSessionForOwner(input.continuationParentId, input.ownerId)) {
        throw new Error("Continuation parent must belong to the session owner");
      }
      const timestamp = now();
      this.sqlite.query("INSERT INTO sessions (id, owner_id, adapter, remote_id, status, control_mode, origin, continuation_parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 'controlled', ?, ?, ?, ?)").run(input.id, input.ownerId, input.adapter, input.remoteId, input.continuationParentId ? "coordinator-continuation" : "coordinator-start", input.continuationParentId ?? null, timestamp, timestamp);
      const session = this.getSession(input.id)!;
      this.enqueueMobileState(input.ownerId, session.id, "session.created", session);
      return session;
    });
  }

  upsertDiscoveredSession(input: {
    id: string; ownerId: string; adapter: "gjc"; remoteId: string; controlMode: "view-only";
    origin: "ondisk-discovery"; transcriptStatus: TranscriptStatus; updatedAt: string;
    title?: string | null; workdir?: string | null; sourceCreatedAt?: string | null;
  }): Session {
    if (!input.ownerId) throw new TypeError("Session owner is required");
    return this.transaction(() => {
      const existing = this.sqlite.query("SELECT * FROM sessions WHERE adapter = ? AND remote_id = ?").get(input.adapter, input.remoteId) as SessionRow | null;
      if (existing?.owner_id && existing.owner_id !== input.ownerId) throw new Error("Discovered session belongs to another owner or is quarantined");
      const changed = !existing || existing.transcript_status !== input.transcriptStatus ||
        (input.title !== undefined && input.title !== existing.title) ||
        (input.workdir !== undefined && input.workdir !== existing.workdir) ||
        (input.sourceCreatedAt !== undefined && input.sourceCreatedAt !== existing.source_created_at);
      const createdAt = now();
      this.sqlite.query(`
        INSERT INTO sessions (
          id, owner_id, adapter, remote_id, status, control_mode, origin, transcript_status,
          title, workdir, source_created_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter, remote_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          transcript_status = excluded.transcript_status,
          title = COALESCE(excluded.title, sessions.title),
          workdir = COALESCE(excluded.workdir, sessions.workdir),
          source_created_at = COALESCE(excluded.source_created_at, sessions.source_created_at)
      `).run(
        input.id, input.ownerId, input.adapter, input.remoteId, input.controlMode, input.origin,
        input.transcriptStatus, input.title ?? null, input.workdir ?? null, input.sourceCreatedAt ?? null, createdAt, input.updatedAt,
      );
      const row = this.sqlite.query("SELECT * FROM sessions WHERE adapter = ? AND remote_id = ? AND owner_id = ?")
        .get(input.adapter, input.remoteId, input.ownerId) as SessionRow | null;
      if (!row) throw new Error("Discovered session belongs to another owner or is quarantined");
      const session = asSession(row);
      if (changed) this.enqueueMobileState(input.ownerId, session.id, existing ? "session.discovered-updated" : "session.discovered", session);
      return session;
    });
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
          input.sessionId, nextSeq, event.type, json("events", event.payload), event.createdAt, event.sourceEventId,
          event.sourceRevision, event.sourcePosition, event.contentHash, input.source,
        );
        const archivedSession = this.getSession(input.sessionId);
        if (archivedSession?.archivedAt) this.quarantineLateEvent(archivedSession, nextSeq);
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
  getSessionByRemoteIdForOwner(ownerId: string, adapter: string, remoteId: string): Session | null {
    const row = this.sqlite.query("SELECT * FROM sessions WHERE owner_id = ? AND adapter = ? AND remote_id = ?").get(ownerId, adapter, remoteId) as SessionRow | null;
    return row ? asSession(row) : null;
  }
  listArchivedSessionsForOwner(ownerId: string): Session[] {
    return (this.sqlite.query("SELECT * FROM sessions WHERE owner_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC").all(ownerId) as SessionRow[]).map(asSession);
  }
  archiveSessionForOwner(input: { id: string; ownerId: string; archivedAt?: string; archiveReason?: "manual" | "retention"; actorId?: "owner" | "system"; deviceId?: string | null; correlationId?: string }): Session | null {
    if (!input.ownerId) throw new TypeError("Session owner is required");
    this.validateTransitionAudit(input);
    return this.transaction(() => {
      const session = this.getSessionForOwner(input.id, input.ownerId);
      if (!session) return null;
      if (session.archivedAt) return session;
      const timestamp = input.archivedAt ?? now();
      const eligibility = this.canArchiveSessionForOwner(input.id, input.ownerId, timestamp);
      if (!eligibility.eligible) throw new Error(`Session cannot be archived: ${eligibility.blockers.join(",")}`);
      const cursor = (this.sqlite.query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?").get(input.id) as { seq: number }).seq;
      const changed = this.sqlite.query("UPDATE sessions SET archived_at = ?, archive_reason = ?, archive_cursor_seq = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND archived_at IS NULL AND reconciliation_epoch = ? AND active_projector_version IS ?").run(timestamp, input.archiveReason ?? "manual", cursor, timestamp, input.id, input.ownerId, session.reconciliationEpoch, session.activeProjectorVersion);
      if (changed.changes !== 1) throw new Error("Archive transition lost");
      const updated = this.getSessionForOwner(input.id, input.ownerId);
      if (!updated) throw new Error("Archived session disappeared");
      this.writeTransitionAudit("session.archived", updated, input);
      this.enqueueMobileState(input.ownerId, updated.id, "session.archived", updated);
      return updated;
    });
  }
  archiveSessionsBeforeForOwner(input: { ownerId: string; sourceCreatedAtBefore: string; archivedAt?: string }): Session[] {
    if (!input.ownerId) throw new TypeError("Session owner is required");
    return this.transaction(() => {
      const timestamp = input.archivedAt ?? now();
      const correlationId = crypto.randomUUID();
      const candidates = this.sqlite.query(`
        SELECT * FROM sessions
        WHERE owner_id = ? AND archived_at IS NULL
          AND source_created_at IS NOT NULL AND source_created_at < ?
        ORDER BY source_created_at ASC
      `).all(input.ownerId, input.sourceCreatedAtBefore) as SessionRow[];
      const archived: Session[] = [];
      for (const candidate of candidates) {
        if (!this.canArchiveSessionForOwner(candidate.id, input.ownerId, timestamp).eligible) continue;
        const result = this.archiveSessionForOwner({ id: candidate.id, ownerId: input.ownerId, archivedAt: timestamp, archiveReason: "retention", actorId: "system", correlationId });
        if (result) archived.push(result);
      }
      return archived;
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
      if (session.status === "terminal" && !session.archivedAt) throw new Error("Terminal sessions are immutable");
      const row = this.sqlite.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?").get(sessionId) as { seq: number };
      const event: EventRow = { session_id: sessionId, seq: row.seq + 1, type, payload_json: json("events", payload), created_at: now() };
      this.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(event.session_id, event.seq, event.type, json("events", payload), event.created_at);
      if (session.archivedAt) this.quarantineLateEvent(session, event.seq);
      const appended = asEvent<T>(event);
      this.enqueueMobileState(session.ownerId, sessionId, "event.appended", appended);
      return appended;
    });
  }
  private continuationSegments(sessionId: string): SessionRow[] {
    const requested = this.sqlite.query("SELECT * FROM sessions WHERE id=? AND owner_id IS NOT NULL").get(sessionId) as SessionRow | null;
    if (!requested) throw new Error("Session does not exist");
    const segments: SessionRow[] = [requested], visited = new Set([requested.id]);
    let current = requested;
    while (current.continuation_parent_id !== null) {
      const parent = this.sqlite.query("SELECT * FROM sessions WHERE id=? AND owner_id=?").get(current.continuation_parent_id, requested.owner_id) as SessionRow | null;
      if (!parent || visited.has(parent.id)) throw new Error("Invalid continuation lineage");
      segments.unshift(parent); visited.add(parent.id); current = parent;
    }
    while (true) {
      const children = this.sqlite.query("SELECT * FROM sessions WHERE continuation_parent_id=? AND owner_id=? ORDER BY id").all(segments.at(-1)!.id, requested.owner_id) as SessionRow[];
      if (children.length > 1) throw new Error("Ambiguous continuation lineage");
      if (children.length === 0) return segments;
      if (visited.has(children[0]!.id)) throw new Error("Invalid continuation lineage");
      segments.push(children[0]!); visited.add(children[0]!.id);
    }
  }
  getContinuationAggregateForOwner(sessionId: string, ownerId: string): Session {
    const segments = this.continuationSegments(sessionId);
    if (segments[0]!.owner_id !== ownerId) throw new Error("Session does not exist");
    const origin = asSession(segments[0]!), head = asSession(segments.at(-1)!);
    return { ...origin, status: head.status, reconciliationEpoch: head.reconciliationEpoch, reconciled: head.reconciled, remoteRevision: head.remoteRevision, transcriptStatus: head.transcriptStatus, activeProjectorVersion: head.activeProjectorVersion, archivedAt: head.archivedAt, updatedAt: head.updatedAt };
  }
  listEvents<T>(sessionId: string, after = 0): SessionEvent<T>[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid continuation event sequence");
    const segments = this.continuationSegments(sessionId);
    try {
      return segments.flatMap((segment, index) => (this.sqlite.query("SELECT * FROM events WHERE session_id=? ORDER BY seq ASC").all(segment.id) as EventRow[]).map((row) => ({ ...this.corrupt("event", `${row.session_id}:${row.seq}`, "payload_json", row.payload_json, () => asEvent<T>(row)), seq: continuationGlobalSeq(index, row.seq) }))).filter((event) => event.seq > after);
    } catch (cause) {
      if (cause instanceof CorruptPersistentDataError) this.sqlite.query("UPDATE sessions SET status='unknown', reconciled=0, updated_at=? WHERE id=?").run(now(), sessionId);
      throw cause;
    }
  }
  eventSequenceBounds(sessionId: string): { first: number | null; last: number | null } {
    const events = this.listEvents(sessionId);
    return { first: events[0]?.seq ?? null, last: events.at(-1)?.seq ?? null };
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
    const payload = commandJson(input.payload);
    this.sqlite.query("INSERT INTO commands (id, session_id, idempotency_key, state, payload_json, created_at, updated_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?)").run(input.id, input.sessionId, input.idempotencyKey, payload, timestamp, timestamp);
    const command = this.getCommand<T>(input.id)!;
    this.enqueueMobileState(session.ownerId, session.id, "command.accepted", command);
    return { command, duplicate: false };
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
      const transitioned = this.getCommand<T>(id)!;
      const session = this.getSession(command.sessionId)!;
      this.enqueueMobileState(session.ownerId, session.id, "command.updated", transitioned);
      return transitioned;
    });
  }

  createPendingAction<T>(input: { id: string; ownerId?: string; sessionId?: string; remoteRef?: string; payload: T; expiresAt: string }): PendingAction<T> {
    const ownerId = input.ownerId ?? (input.sessionId ? this.getSession(input.sessionId)?.ownerId : undefined);
    if (!ownerId?.trim()) throw new TypeError("Pending action owner is required");
    if (input.sessionId && !this.getSessionForOwner(input.sessionId, ownerId)) throw new Error("Session does not exist for owner");
    return this.transaction(() => {
      const timestamp = now();
      this.sqlite.query("INSERT INTO pending_actions (id, session_id, owner_id, remote_ref, version, state, payload_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?)").run(input.id, input.sessionId ?? null, ownerId, input.remoteRef ?? null, json("pending-actions", input.payload), input.expiresAt, timestamp, timestamp);
      const action = this.getPendingAction<T>(input.id)!;
      this.enqueueMobileState(ownerId, action.sessionId, "pending-action.created", action);
      return action;
    });
  }
  createPendingActionForOwner<T>(input: { id: string; ownerId: string; sessionId: string; remoteRef?: string; payload: T; expiresAt: string }): PendingAction<T> {
    return this.createPendingAction(input);
  }

  getPendingAction<T, A = unknown>(id: string): PendingAction<T, A> | null {
    const row = this.sqlite.query("SELECT * FROM pending_actions WHERE id = ?").get(id) as PendingActionRow | null;
    return row ? this.pendingAction<T, A>(row) : null;
  }
  getPendingActionForOwner<T, A = unknown>(id: string, ownerId: string): PendingAction<T, A> | null {
    const row = this.sqlite.query("SELECT * FROM pending_actions WHERE id = ? AND owner_id = ?").get(id, ownerId) as PendingActionRow | null;
    return row ? this.pendingAction<T, A>(row) : null;
  }

  updatePendingAction<T, A>(input: { id: string; expectedVersion: number; state: Exclude<PendingActionState, "pending">; answer?: A; updatedAt: string }): PendingAction<T, A> | null {
    return this.transaction(() => {
      const result = this.sqlite.query("UPDATE pending_actions SET state = ?, answer_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = 'pending' AND version = ?").run(input.state, input.answer === undefined ? null : json("pending-actions", input.answer), input.updatedAt, input.id, input.expectedVersion);
      const action = result.changes === 1 ? this.getPendingAction<T, A>(input.id) : null;
      if (action) this.enqueueMobileState(action.ownerId, action.sessionId, "pending-action.updated", action);
      return action;
    });
  }
  private validateTransitionAudit(input: { actorId?: "owner" | "system"; deviceId?: string | null; correlationId?: string }): void {
    if (input.actorId === "owner" && (!input.deviceId || !input.correlationId?.trim())) throw new TypeError("Owner transition audit requires a device and correlation");
    if (input.actorId === "system" && input.deviceId !== undefined && input.deviceId !== null) throw new TypeError("System transition audit cannot have a device");
  }
  private writeTransitionAudit(action: string, session: Session, input: { actorId?: "owner" | "system"; deviceId?: string | null; correlationId?: string }): void {
    const actorId = input.actorId ?? "system";
    this.writeAudit({
      action, sessionId: session.id, actorId, deviceId: actorId === "system" ? undefined : input.deviceId ?? undefined,
      correlationId: input.correlationId ?? crypto.randomUUID(), payload: { result: action === "session.archived" ? "archived" : "unarchived" },
    });
  }

  writeAudit<T>(input: { action: string; sessionId?: string; commandId?: string; actorId?: string; deviceId?: string; correlationId?: string; payload: T }): AuditEntry<T> {
    const timestamp = now();
    const result = this.sqlite.query("INSERT INTO audit_log (action, session_id, command_id, actor_id, device_id, correlation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.action, input.sessionId ?? null, input.commandId ?? null, input.actorId ?? null, input.deviceId ?? null, input.correlationId ?? null, json("audit", typeof input.payload === "string" ? redactDiagnostic("audit", input.payload) : input.payload), timestamp);
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
    const safe = redactForSink("push", input) as typeof input;
    return this.transaction(() => {
      const existing = this.sqlite.query("SELECT * FROM push_subscriptions WHERE endpoint_hash = ?").get(safe.endpointHash) as PushSubscriptionRow | null;
      if (existing && existing.owner_id !== safe.ownerId) throw new Error("Push endpoint belongs to another owner");
      const timestamp = now();
      this.sqlite.query("INSERT INTO push_subscriptions (endpoint_hash, owner_id, encrypted_material, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint_hash) DO UPDATE SET encrypted_material = excluded.encrypted_material, expires_at = excluded.expires_at, updated_at = excluded.updated_at").run((redactForSink("push", input) as typeof input).endpointHash, (redactForSink("push", input) as typeof input).ownerId, (redactForSink("push", input) as typeof input).encryptedMaterial, (redactForSink("push", input) as typeof input).expiresAt ?? null, timestamp, timestamp);
      const stored = this.getStoredPushSubscription(safe.ownerId, safe.endpointHash);
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
    if (!this.readOnly) this.sqlite.query("UPDATE device_credentials SET last_used_at = ? WHERE id = ?").run(at, row.id);
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
  listPendingActionsForOwner<T, A = unknown>(ownerId: string): PendingAction<T, A>[] {
    const rows = this.sqlite.query("SELECT * FROM pending_actions WHERE owner_id = ? ORDER BY created_at ASC").all(ownerId) as PendingActionRow[];
    return rows.map((row) => this.pendingAction<T, A>(row));
  }
  activateProjectorVersion(input: { sessionId: string; ownerId: string; projectorVersion: string; expectedCurrentVersion?: string | null }): boolean {
    if (!input.ownerId || !input.projectorVersion) return false;
    return this.transaction(() => {
      const timestamp = now();
      const changed = input.expectedCurrentVersion == null
        ? this.sqlite.query("UPDATE sessions SET active_projector_version = ?, reconciliation_epoch = reconciliation_epoch + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND active_projector_version IS NOT ? AND (active_projector_version IS NULL OR active_projector_version = 'legacy')").run(input.projectorVersion, timestamp, input.sessionId, input.ownerId, input.projectorVersion)
        : this.sqlite.query("UPDATE sessions SET active_projector_version = ?, reconciliation_epoch = reconciliation_epoch + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND active_projector_version = ? AND active_projector_version IS NOT ?").run(input.projectorVersion, timestamp, input.sessionId, input.ownerId, input.expectedCurrentVersion, input.projectorVersion);
      if (changed.changes !== 1) return false;
      const session = this.getSessionForOwner(input.sessionId, input.ownerId);
      if (!session) throw new Error("Activated session disappeared");
      this.enqueueMobileState(input.ownerId, input.sessionId, "session.projector-version-activated", session);
      return true;
    });
  }
  cutoverProjectorVersion<T>(input: {
    sessionId: string; ownerId: string; projectorVersion: string; expectedCurrentVersion: string | null;
    expectedReconciliationEpoch: number;
    workItems: ReadonlyArray<{ id: string; remoteId: string; state: string; payload: T }>;
  }): boolean {
    if (!input.ownerId || !input.projectorVersion || !Number.isSafeInteger(input.expectedReconciliationEpoch) || input.expectedReconciliationEpoch < 0) return false;
    const casFailed = new Error("Projector cutover CAS failed");
    try {
      return this.transaction(() => {
        const timestamp = now();
        const changedItems: Array<{ id: string; remoteId: string; state: string; payload: T }> = [];
        for (const item of input.workItems) {
          const payload = json("work-items", item.payload);
          const existing = this.sqlite.query("SELECT state, payload_json FROM work_items WHERE session_id = ? AND remote_id = ? AND projector_version = ?").get(input.sessionId, item.remoteId, input.projectorVersion) as { state: string; payload_json: string } | null;
          if (existing?.state === item.state && existing.payload_json === payload) continue;
          this.sqlite.query("INSERT INTO work_items (id, owner_id, session_id, remote_id, state, payload_json, projector_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, remote_id, projector_version) DO UPDATE SET state = excluded.state, payload_json = excluded.payload_json, updated_at = excluded.updated_at").run(item.id, input.ownerId, input.sessionId, item.remoteId, item.state, json("work-items", item.payload), input.projectorVersion, timestamp, timestamp);
          changedItems.push(item);
        }
        const changed = this.sqlite.query("UPDATE sessions SET active_projector_version = ?, reconciliation_epoch = reconciliation_epoch + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND archived_at IS NULL AND active_projector_version IS ? AND reconciliation_epoch = ?").run(input.projectorVersion, timestamp, input.sessionId, input.ownerId, input.expectedCurrentVersion, input.expectedReconciliationEpoch);
        if (changed.changes !== 1) throw casFailed;
        const session = this.getSessionForOwner(input.sessionId, input.ownerId);
        if (!session) throw new Error("Activated session disappeared");
        for (const item of changedItems) {
          const row = this.sqlite.query("SELECT * FROM work_items WHERE session_id = ? AND remote_id = ? AND projector_version = ?").get(input.sessionId, item.remoteId, input.projectorVersion) as WorkItemRow;
          this.enqueueMobileState(input.ownerId, input.sessionId, "work-item.upserted", this.workItem<T>(row));
        }
        this.enqueueMobileState(input.ownerId, input.sessionId, "session.projector-version-activated", session);
        return true;
      });
    } catch (cause) {
      if (cause === casFailed) return false;
      throw cause;
    }
  }
  upsertWorkItem<T>(input: { id: string; ownerId: string; sessionId: string; remoteId: string; state: string; payload: T; projectorVersion?: string }): WorkItem<T> {
    if (!input.ownerId || !input.remoteId || !this.getSessionForOwner(input.sessionId, input.ownerId)) throw new Error("Work item must belong to an owned session");
    return this.transaction(() => {
      const timestamp = now(); const version = input.projectorVersion ?? "legacy"; const payload = json("work-items", input.payload);
      const existing = this.sqlite.query("SELECT * FROM work_items WHERE session_id = ? AND remote_id = ? AND projector_version = ?").get(input.sessionId, input.remoteId, version) as WorkItemRow | null;
      if (existing && existing.state === input.state && existing.payload_json === payload) return this.workItem<T>(existing);
      this.sqlite.query("INSERT INTO work_items (id, owner_id, session_id, remote_id, state, payload_json, projector_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, remote_id, projector_version) DO UPDATE SET state = excluded.state, payload_json = excluded.payload_json, updated_at = excluded.updated_at").run(input.id, input.ownerId, input.sessionId, input.remoteId, input.state, json("work-items", input.payload), version, timestamp, timestamp);
      const item = this.workItem<T>(this.sqlite.query("SELECT * FROM work_items WHERE session_id = ? AND remote_id = ? AND projector_version = ?").get(input.sessionId, input.remoteId, version) as WorkItemRow);
      this.enqueueMobileState(input.ownerId, input.sessionId, "work-item.upserted", item);
      return item;
    });
  }
  listWorkItemsForOwner<T>(ownerId: string): WorkItem<T>[] {
    return (this.sqlite.query(`
      SELECT work_items.* FROM work_items
      JOIN sessions ON sessions.id = work_items.session_id
      WHERE work_items.owner_id = ?
        AND sessions.owner_id = ?
        AND sessions.archived_at IS NULL
        AND work_items.projector_version = COALESCE(sessions.active_projector_version, 'legacy')
      ORDER BY work_items.updated_at DESC
    `).all(ownerId, ownerId) as WorkItemRow[]).map((row) => this.workItem<T>(row));
  }
  getProjectionCheckpoint(sessionId: string, projectorVersion = "legacy"): ProjectionCheckpoint {
    const row = this.sqlite.query("SELECT * FROM session_projection_checkpoints WHERE session_id = ? AND projector_version = ?").get(sessionId, projectorVersion) as { session_id: string; projector_version: string; next_expected_seq: number; updated_at: string } | null;
    return row ? { sessionId: row.session_id, projectorVersion: row.projector_version, nextExpectedSeq: row.next_expected_seq, updatedAt: row.updated_at } : { sessionId, projectorVersion, nextExpectedSeq: 1, updatedAt: "" };
  }
  #advanceAppliedProjection(input: { sessionId: string; ownerId: string; projectorVersion: string; seq: number }): boolean {
    const timestamp = now();
    const changed = this.sqlite.query("UPDATE session_projection_checkpoints SET next_expected_seq = ?, updated_at = ? WHERE session_id = ? AND projector_version = ? AND next_expected_seq = ?").run(input.seq + 1, timestamp, input.sessionId, input.projectorVersion, input.seq);
    if (changed.changes === 0 && this.sqlite.query("INSERT OR IGNORE INTO session_projection_checkpoints (session_id, projector_version, next_expected_seq, updated_at) VALUES (?, ?, ?, ?)").run(input.sessionId, input.projectorVersion, input.seq + 1, timestamp).changes === 0) return false;
    this.sqlite.query("UPDATE session_projection_gaps SET resolved_at = ? WHERE session_id = ? AND projector_version = ? AND seq = ? AND resolved_at IS NULL").run(redactForSink("projection-diagnostics", timestamp) as string, input.sessionId, input.projectorVersion, input.seq);
    this.sqlite.query("DELETE FROM projection_failures WHERE session_id = ? AND projector_version = ? AND seq = ?").run(input.sessionId, input.projectorVersion, input.seq);
    this.enqueueMobileState(input.ownerId, input.sessionId, "projection.applied", { projectorVersion: input.projectorVersion, seq: input.seq });
    return true;
  }
  listProjectionGaps(sessionId: string, projectorVersion = "legacy"): ProjectionGap[] {
    return (this.sqlite.query("SELECT * FROM session_projection_gaps WHERE session_id = ? AND projector_version = ? ORDER BY seq").all(sessionId, projectorVersion) as Array<{ session_id: string; projector_version: string; seq: number; reason: string; resolved_at: string | null; detected_at: string }>).map((r) => ({ sessionId: r.session_id, projectorVersion: r.projector_version, seq: r.seq, reason: r.reason, resolvedAt: r.resolved_at, detectedAt: r.detected_at }));
  }
  applyProjection(input: { sessionId: string; ownerId: string; projectorVersion: string; apply: (event: SessionEvent) => void; effectKey?: string }): number {
    if (!input.ownerId.trim() || !this.getSessionForOwner(input.sessionId, input.ownerId)) throw new Error("Session does not exist for owner");
    let applied = 0;
    for (;;) {
      let failed: { seq: number; reason: string } | null = null;
      try {
        const advanced = this.transaction(() => {
          const checkpoint = this.getProjectionCheckpoint(input.sessionId, input.projectorVersion);
          const session = this.getSessionForOwner(input.sessionId, input.ownerId);
          if (!session || session.archivedAt) return false;
          const event = this.sqlite.query("SELECT * FROM events WHERE session_id = ? AND seq = ?").get(input.sessionId, checkpoint.nextExpectedSeq) as EventRow | null;
          if (!event) {
            const higherEvent = this.sqlite.query("SELECT seq FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 1").get(input.sessionId, checkpoint.nextExpectedSeq) as { seq: number } | null;
            if (higherEvent) this.sqlite.query("INSERT OR IGNORE INTO session_projection_gaps (session_id, projector_version, seq, reason, detected_at) VALUES (?, ?, ?, ?, ?)")
              .run(input.sessionId, input.projectorVersion, higherEvent.seq, projectionGapReason("out-of-order"), now());
            return false;
          }
          try {
            const effectKey = input.effectKey ?? "applyProjection";
            const effectExists = this.sqlite.query("SELECT 1 FROM projection_effects WHERE session_id = ? AND projector_version = ? AND seq = ? AND effect_key = ?").get(input.sessionId, input.projectorVersion, event.seq, effectKey);
            if (!effectExists) {
              input.apply(asEvent(event));
              this.sqlite.query("INSERT INTO projection_effects VALUES (?, ?, ?, ?, ?)").run(input.sessionId, input.projectorVersion, event.seq, effectKey, now());
            }
            return this.#advanceAppliedProjection({ sessionId: input.sessionId, ownerId: input.ownerId, projectorVersion: input.projectorVersion, seq: event.seq });
          } catch (cause) {
            failed = { seq: event.seq, reason: redactDiagnostic("projection-diagnostics", cause) };
            throw cause;
          }
        });
        if (!advanced) return applied;
        applied++;
      } catch {
        if (!failed) throw new Error("Projection transaction failed");
        this.transaction(() => {
          const timestamp = now();
          this.sqlite.query("INSERT OR REPLACE INTO projection_failures VALUES (?, ?, ?, ?, ?)").run(input.sessionId, input.projectorVersion, failed!.seq, redactDiagnostic("projection-diagnostics", failed!.reason), timestamp);
        });
        return applied;
      }
    }
  }
  listProjectionFailures(sessionId: string, projectorVersion: string): ProjectionFailure[] {
    return (this.sqlite.query("SELECT * FROM projection_failures WHERE session_id = ? AND projector_version = ? ORDER BY seq").all(sessionId, projectorVersion) as Array<{session_id:string; projector_version:string; seq:number; reason:string; failed_at:string}>).map((r) => ({sessionId:r.session_id, projectorVersion:r.projector_version, seq:r.seq, reason:r.reason, failedAt:r.failed_at}));
  }
  unarchiveSessionForOwner(input: { id: string; ownerId: string; actorId?: "owner" | "system"; deviceId?: string | null; correlationId?: string }): Session | null {
    if (!input.ownerId) throw new TypeError("Session owner is required");
    this.validateTransitionAudit(input);
    return this.transaction(() => {
      const timestamp = now();
      const changed = this.sqlite.query("UPDATE sessions SET archived_at = NULL, archive_reason = NULL, archive_cursor_seq = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND archived_at IS NOT NULL").run(timestamp, input.id, input.ownerId);
      const session = this.getSessionForOwner(input.id, input.ownerId);
      if (changed.changes === 1 && session) {
        this.sqlite.query("UPDATE late_event_quarantine SET state = 'reopened', reopened_at = ?, updated_at = ? WHERE session_id = ? AND owner_id = ? AND state = 'quarantined'").run(timestamp, timestamp, input.id, input.ownerId);
        this.writeTransitionAudit("session.unarchived", session, input);
        this.enqueueMobileState(input.ownerId, input.id, "session.unarchived", session);
      }
      return session;
    });
  }
  canArchiveSessionForOwner(id: string, ownerId: string, at = now()): { eligible: boolean; blockers: string[] } {
    const blockers: string[] = [];
    const session = this.getSessionForOwner(id, ownerId);
    if (!session) blockers.push("session");
    if (session && session.status !== "terminal") blockers.push("terminal");
    if (session && !session.reconciled) blockers.push("reconciled");
    if (session && new Date(session.updatedAt).getTime() > new Date(at).getTime() - 15 * 60 * 1_000) blockers.push("grace-period");
    if (this.sqlite.query("SELECT 1 FROM pending_actions WHERE session_id = ? AND state IN ('pending','dispatching','unknown')").get(id)) blockers.push("pending-actions");
    if (this.sqlite.query("SELECT 1 FROM commands WHERE session_id = ? AND state IN ('accepted','dispatching','remote-confirmed','unknown')").get(id)) blockers.push("commands");
    const projectorVersion = session?.activeProjectorVersion ?? "legacy";
    if (session && this.sqlite.query("SELECT 1 FROM work_items WHERE session_id = ? AND projector_version = ? AND state NOT IN ('closed','done','resolved')").get(id, projectorVersion)) blockers.push("work-items");
    if (session && this.sqlite.query("SELECT 1 FROM session_projection_gaps WHERE session_id = ? AND projector_version = ? AND resolved_at IS NULL").get(id, projectorVersion)) blockers.push("projection-gaps");
    if (session && this.sqlite.query("SELECT 1 FROM projection_failures WHERE session_id = ? AND projector_version = ?").get(id, projectorVersion)) blockers.push("projection-failures");
    if (session) {
      const maximum = this.sqlite.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?").get(id) as { seq: number };
      const checkpoint = this.getProjectionCheckpoint(id, projectorVersion);
      if (checkpoint.nextExpectedSeq !== maximum.seq + 1) blockers.push("active-projection-checkpoint");
    }
    return { eligible: blockers.length === 0, blockers };
  }
  createMobileSnapshot(input: { token: string; ownerId: string; expiresAt: string; authorizeSession: (session: Session) => boolean; maxRows?: number; maxTokens?: number; at?: string }): { watermark: number } {
    if (!input.ownerId.trim() || !input.token || !input.expiresAt || typeof input.authorizeSession !== "function") throw new RangeError("Invalid snapshot");
    const maxRows = input.maxRows ?? 5_000; const maxTokens = input.maxTokens ?? 3; const at = input.at ?? now();
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new RangeError("Invalid snapshot quota");
    return this.transaction(() => {
      this.sqlite.query("DELETE FROM snapshot_tokens WHERE expires_at <= ?").run(at);
      const tokens = (this.sqlite.query("SELECT COUNT(*) AS count FROM snapshot_tokens WHERE owner_id = ?").get(input.ownerId) as { count: number }).count;
      if (tokens >= maxTokens) this.sqlite.query("DELETE FROM snapshot_tokens WHERE token = (SELECT token FROM snapshot_tokens WHERE owner_id = ? ORDER BY created_at ASC, token ASC LIMIT 1)").run(input.ownerId);
      const sessions = (this.sqlite.query("SELECT * FROM sessions WHERE owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC").all(input.ownerId) as SessionRow[])
        .map(asSession)
        .filter(input.authorizeSession);
      const authorizedSessionIds = sessions.map(({ id }) => id);
      const placeholders = authorizedSessionIds.map(() => "?").join(",");
      const work = authorizedSessionIds.length === 0 ? [] : (this.sqlite.query(`SELECT work_items.* FROM work_items JOIN sessions ON sessions.id = work_items.session_id WHERE work_items.owner_id = ? AND sessions.owner_id = ? AND work_items.session_id IN (${placeholders}) AND sessions.archived_at IS NULL AND work_items.projector_version = COALESCE(sessions.active_projector_version, 'legacy') ORDER BY work_items.updated_at DESC`).all(input.ownerId, input.ownerId, ...authorizedSessionIds) as WorkItemRow[]).map((row) => this.workItem(row));
      const actions = authorizedSessionIds.length === 0 ? [] : (this.sqlite.query(`SELECT pending_actions.* FROM pending_actions JOIN sessions ON sessions.id = pending_actions.session_id WHERE pending_actions.owner_id = ? AND pending_actions.session_id IN (${placeholders}) AND pending_actions.state = 'pending' AND pending_actions.expires_at > ? AND sessions.owner_id = ? AND sessions.archived_at IS NULL ORDER BY pending_actions.created_at ASC`).all(input.ownerId, ...authorizedSessionIds, at, input.ownerId) as PendingActionRow[]).map((row) => this.pendingAction(row));
      const rows = [...sessions.map((value) => ({ key: `session:${value.id}`, payload: { kind: "session", value } })), ...work.map((value) => ({ key: `work:${value.id}`, payload: { kind: "work", value } })), ...actions.map((value) => ({ key: `action:${value.id}`, payload: { kind: "action", value } }))];
      if (rows.length > maxRows) throw new RangeError("Snapshot row quota exceeded");
      const watermark = (this.sqlite.query("SELECT COALESCE(MAX(id), 0) AS id FROM sse_outbox WHERE owner_id = ?").get(input.ownerId) as { id: number }).id;
      this.sqlite.query("INSERT INTO snapshot_tokens VALUES (?, ?, ?, ?, ?)").run(input.token, input.ownerId, watermark, input.expiresAt, at);
      for (const row of rows) this.sqlite.query("INSERT INTO snapshot_rows VALUES (?, ?, ?)").run(input.token, row.key, json("snapshots", row.payload));
      return { watermark };
    });
  }
  readSnapshot<T>(token: string, ownerId: string, at = now()): Array<{ key: string; payload: T }> | null {
    const found = this.sqlite.query("SELECT 1 FROM snapshot_tokens WHERE token = ? AND owner_id = ? AND expires_at > ?").get(token, ownerId, at);
    if (!found) return null;
    return (this.sqlite.query("SELECT row_key, payload_json FROM snapshot_rows WHERE token = ? ORDER BY row_key").all(token) as Array<{row_key:string; payload_json:string}>).map((r) => ({ key: r.row_key, payload: decodeJson<T>(r.payload_json, `snapshot ${token}:${r.row_key}`) }));
  }
  enqueueSse(ownerId: string, event: unknown, sessionId?: string): number {
    if (!ownerId.trim()) throw new TypeError("SSE owner is required");
    if (!sessionId?.trim() || !this.getSessionForOwner(sessionId, ownerId)) throw new TypeError("SSE requires an owned session");
    return this.transaction(() => {
      const result = this.sqlite.query("INSERT INTO sse_outbox (owner_id, session_id, event_json, created_at) VALUES (?, ?, ?, ?)").run(ownerId, sessionId, json("sse-outbox", event), now());
      this.pruneSseOutbox(ownerId);
      return Number(result.lastInsertRowid);
    });
  }
  minimumRetainedSseCursor(ownerId: string): number {
    if (!ownerId.trim()) throw new TypeError("SSE owner is required");
    const row = this.sqlite.query("SELECT MIN(id) AS id FROM sse_outbox WHERE owner_id = ?").get(ownerId) as { id: number | null };
    return row.id === null ? 0 : row.id - 1;
  }
  listSseAfter<T>(ownerId: string, watermark: number, authorizedSessionIdsOrCap?: readonly string[] | number, cap = 100): Array<{ id: number; sessionId: string; event: T }> {
    const authorizedSessionIds = authorizedSessionIdsOrCap === undefined || typeof authorizedSessionIdsOrCap === "number" ? null : [...new Set(authorizedSessionIdsOrCap)];
    const effectiveCap = typeof authorizedSessionIdsOrCap === "number" ? authorizedSessionIdsOrCap : cap;
    if (effectiveCap < 1 || effectiveCap > 1_000) throw new RangeError("Invalid SSE cap");
    if (authorizedSessionIds?.some((id) => !id.trim())) throw new RangeError("Invalid authorized session");
    const sessionFilter = authorizedSessionIds === null
      ? { clause: "", parameters: [] as string[] }
      : authorizedSessionIds.length === 0
        ? { clause: " AND 0", parameters: [] as string[] }
        : { clause: ` AND session_id IN (${authorizedSessionIds.map(() => "?").join(",")})`, parameters: authorizedSessionIds };
    return (this.sqlite.query(`SELECT id, session_id, event_json FROM sse_outbox WHERE owner_id = ? AND id > ?${sessionFilter.clause} ORDER BY id LIMIT ?`).all(ownerId, watermark, ...sessionFilter.parameters, effectiveCap) as Array<{id:number;session_id:string;event_json:string}>).map((r) => ({ id:r.id, sessionId:r.session_id, event:decodeJson<T>(r.event_json, `sse ${r.id}`) }));
  }
  setSchemaFence(name: string, minVersion: number, active: boolean): void {
    this.sqlite.query("INSERT INTO schema_fence VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET min_version=excluded.min_version, active=excluded.active, updated_at=excluded.updated_at").run(name, minVersion, active ? 1 : 0, now());
  }
  activeSchemaFenceVersion(name = "min_binary_version"): number | null {
    const row = this.sqlite.query("SELECT min_version FROM schema_fence WHERE name = ? AND active = 1").get(name) as { min_version: number } | null;
    return row?.min_version ?? null;
  }
  getBackfillJob(name: string): BackfillJob | null {
    const row = this.sqlite.query("SELECT * FROM backfill_jobs WHERE name = ?").get(name) as { name: string; cursor_json: string; state: BackfillJobState; attempts: number; started_at: string | null; paused_at: string | null; completed_at: string | null; failed_at: string | null; error: string | null; updated_at: string } | null;
    return row && { name: row.name, cursor: decodeJson(row.cursor_json, `backfill ${name}`), state: row.state, attempts: row.attempts, startedAt: row.started_at, pausedAt: row.paused_at, completedAt: row.completed_at, failedAt: row.failed_at, error: row.error, updatedAt: row.updated_at };
  }
  saveBackfillJob(name: string, cursor: unknown, state: BackfillJobState): void {
    this.sqlite.query("INSERT INTO backfill_jobs (name, cursor_json, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET cursor_json=excluded.cursor_json, state=excluded.state, updated_at=excluded.updated_at").run(name, json("projection-diagnostics", cursor), state, now());
  }
  runHistoricalProjectionBackfill(input: { projectorVersion?: string; fold: (event: SessionEvent) => void; effectKey?: string; limit?: number }): BackfillJob {
    const limit = input.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Historical projection batch must be between 1 and 500");
    const name = "historical-projection-v1";
    return this.transaction(() => {
      let job = this.getBackfillJob(name)!;
      if (job.state === "complete") return job;
      if (job.state !== "running") job = this.startBackfillJob(name, job.cursor);
      const cursor = (job.cursor && typeof job.cursor === "object" ? job.cursor : {}) as { sessionId?: string; seq?: number };
      const events = this.sqlite.query(`
        SELECT events.*, sessions.owner_id FROM events JOIN sessions ON sessions.id = events.session_id
        WHERE sessions.owner_id IS NOT NULL AND (events.session_id > ? OR (events.session_id = ? AND events.seq > ?))
        ORDER BY events.session_id, events.seq LIMIT ?
      `).all(cursor.sessionId ?? "", cursor.sessionId ?? "", cursor.seq ?? 0, limit) as Array<EventRow & { owner_id: string }>;
      let last = cursor;
      const version = input.projectorVersion ?? "legacy";
      const effectKey = input.effectKey ?? name;
      for (const event of events) {
        const checkpoint = this.getProjectionCheckpoint(event.session_id, version);
        if (event.seq === checkpoint.nextExpectedSeq) {
          const seen = this.sqlite.query("SELECT 1 FROM projection_effects WHERE session_id = ? AND projector_version = ? AND seq = ? AND effect_key = ?").get(event.session_id, version, event.seq, effectKey);
          if (!seen) {
            input.fold(asEvent(event));
            this.sqlite.query("INSERT INTO projection_effects VALUES (?, ?, ?, ?, ?)").run(event.session_id, version, event.seq, effectKey, now());
          }
          this.#advanceAppliedProjection({ sessionId: event.session_id, ownerId: event.owner_id, projectorVersion: version, seq: event.seq });
        }
        last = { sessionId: event.session_id, seq: event.seq };
      }
      const complete = events.length < limit;
      this.sqlite.query("UPDATE backfill_jobs SET cursor_json=?, state=?, completed_at=CASE WHEN ? THEN ? ELSE completed_at END, updated_at=? WHERE name=?").run(json("projection-diagnostics", last), complete ? "complete" : "running", complete ? 1 : 0, now(), now(), name);
      return this.getBackfillJob(name)!;
    });
  }
  runHistoricalArchiveBackfill(input: { at?: string; limit?: number } = {}): BackfillJob {
    const limit = input.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Historical archive batch must be between 1 and 500");
    const name = "historical-archive-backfill-v1";
    return this.transaction(() => {
      if (this.getBackfillJob("historical-projection-v1")?.state !== "complete") throw new Error("historical-archive-backfill-v1 requires completed historical-projection-v1");
      let job = this.getBackfillJob(name)!;
      if (job.state === "complete") return job;
      if (job.state !== "running") job = this.startBackfillJob(name, job.cursor);
      const cursor = (job.cursor && typeof job.cursor === "object" ? job.cursor : {}) as { sessionId?: string };
      const sessions = this.sqlite.query("SELECT id, owner_id FROM sessions WHERE id > ? AND owner_id IS NOT NULL ORDER BY id LIMIT ?").all(cursor.sessionId ?? "", limit) as Array<{ id: string; owner_id: string }>;
      let last = cursor; const at = input.at ?? now();
      for (const session of sessions) {
        if (this.canArchiveSessionForOwner(session.id, session.owner_id, at).eligible) this.archiveSessionForOwner({ id: session.id, ownerId: session.owner_id, archivedAt: at, archiveReason: "retention", actorId: "system" });
        last = { sessionId: session.id };
      }
      const complete = sessions.length < limit;
      this.sqlite.query("UPDATE backfill_jobs SET cursor_json=?, state=?, completed_at=CASE WHEN ? THEN ? ELSE completed_at END, updated_at=? WHERE name=?").run(json("projection-diagnostics", last), complete ? "complete" : "running", complete ? 1 : 0, now(), now(), name);
      return this.getBackfillJob(name)!;
    });
  }
  startBackfillJob(name: string, cursor: unknown = {}): BackfillJob {
    if (name === "historical-archive-backfill-v1" && this.getBackfillJob("historical-projection-v1")?.state !== "complete") throw new Error("historical-archive-backfill-v1 requires completed historical-projection-v1");
    const timestamp = now();
    this.sqlite.query("INSERT INTO backfill_jobs (name, cursor_json, state, attempts, started_at, updated_at) VALUES (?, ?, 'running', 1, ?, ?) ON CONFLICT(name) DO UPDATE SET cursor_json=excluded.cursor_json, state='running', attempts=backfill_jobs.attempts + 1, started_at=?, paused_at=NULL, error=NULL, updated_at=?").run(name, json("projection-diagnostics", cursor), timestamp, timestamp, timestamp, timestamp);
    return this.getBackfillJob(name)!;
  }
  pauseBackfillJob(name: string): BackfillJob | null {
    const timestamp = now();
    this.sqlite.query("UPDATE backfill_jobs SET state='paused', paused_at=?, updated_at=? WHERE name=? AND state='running'").run(timestamp, timestamp, name);
    return this.getBackfillJob(name);
  }
  advanceBackfillJob(name: string, cursor: unknown): BackfillJob | null {
    const changed = this.sqlite.query("UPDATE backfill_jobs SET cursor_json=?, updated_at=? WHERE name=? AND state='running'").run(json("projection-diagnostics", cursor), now(), name);
    return changed.changes ? this.getBackfillJob(name) : null;
  }
  failBackfillJob(name: string, error: string): BackfillJob | null {
    const timestamp = now();
    this.sqlite.query("UPDATE backfill_jobs SET state='failed', error=?, failed_at=?, updated_at=? WHERE name=? AND state IN ('running','paused')").run(redactDiagnostic("projection-diagnostics", error), timestamp, timestamp, name);
    return this.getBackfillJob(name);
  }
  completeBackfillJob(name: string): BackfillJob | null {
    const timestamp = now();
    this.sqlite.query("UPDATE backfill_jobs SET state='complete', completed_at=?, error=NULL, updated_at=? WHERE name=? AND state='running'").run(timestamp, timestamp, name);
    return this.getBackfillJob(name);
  }
}

export const openCoreDatabase = (filename?: string): CoreDatabase => new CoreDatabase(filename);
export { DurableCommandDispatcher } from "./dispatcher";
export type { CorrelationLookup, DurableCommandDispatcherOptions, DurableCommandRemote } from "./dispatcher";
