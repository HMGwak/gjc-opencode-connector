import type { AgentAdapter, CoreDatabase } from "@planee/core";
import { stat } from "node:fs/promises";

export type AdapterHealth = "healthy" | "unhealthy";
export interface HubMetricsOptions {
  readonly database: CoreDatabase;
  readonly adapters?: Readonly<Record<string, AgentAdapter>>;
  readonly adapterHealth?: (name: string, adapter: AgentAdapter) => Promise<AdapterHealth> | AdapterHealth;
}
export interface HubReadiness {
  readonly ok: boolean;
  readonly database: "ready" | "unready";
  readonly adapters: Readonly<Record<string, AdapterHealth>>;
}

const archiveBlockerReasons = ["grace-period", "open-pending-action", "open-command", "open-work-item", "unresolved-gap", "unresolved-failure", "unknown-command-state", "active-projection-checkpoint"] as const;
const maxAdapterMetrics = 20;
const label = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const count = (database: CoreDatabase, sql: string): number => Number((database.sqlite.query(sql).get() as { count: number }).count);

export async function readiness(options: HubMetricsOptions): Promise<HubReadiness> {
  let database: HubReadiness["database"] = "ready";
  try { options.database.sqlite.query("SELECT 1").get(); } catch { database = "unready"; }
  const adapters: Record<string, AdapterHealth> = {};
  for (const [name, adapter] of Object.entries(options.adapters ?? {})) {
    try { adapters[name] = await options.adapterHealth?.(name, adapter) ?? "healthy"; }
    catch { adapters[name] = "unhealthy"; }
  }
  return { ok: database === "ready" && Object.values(adapters).every((value) => value === "healthy"), database, adapters };
}

async function walBytes(database: CoreDatabase): Promise<number> {
  if (database.filename === ":memory:") return 0;
  try { return (await stat(`${database.filename}-wal`)).size; } catch { return 0; }
}

/** Checkpoints WAL before observing it; no journal contents are ever exposed. */
export async function prometheusMetrics(options: HubMetricsOptions): Promise<string> {
  let checkpointed = 0;
  try { options.database.sqlite.query("PRAGMA wal_checkpoint(PASSIVE)").get(); checkpointed = 1; } catch { /* readiness reports DB failure */ }
  const database = options.database;
  const ready = await readiness(options);
  const outbox = database.sqlite.query("SELECT COALESCE(MAX(0, unixepoch('now') - unixepoch(MIN(created_at))), 0) AS oldest_age_seconds FROM sse_outbox").get() as { oldest_age_seconds: number };
  const checkpointLags = database.sqlite.query(`
    SELECT sessions.id AS session_id, MAX(0, latest.maximum_seq + 1 - COALESCE(checkpoints.next_expected_seq, 1)) AS lag
    FROM sessions
    JOIN (SELECT session_id, MAX(seq) AS maximum_seq FROM events GROUP BY session_id) AS latest ON latest.session_id = sessions.id
    LEFT JOIN session_projection_checkpoints AS checkpoints ON checkpoints.session_id = sessions.id AND checkpoints.projector_version = sessions.active_projector_version
    WHERE sessions.active_projector_version IS NOT NULL
    ORDER BY lag DESC, sessions.id ASC
    LIMIT 20
  `).all() as Array<{ session_id: string; lag: number }>;
  const lines = [
    "# TYPE hub_wal_bytes gauge", `hub_wal_bytes ${await walBytes(database)}`,
    "# TYPE hub_wal_checkpoint_success gauge", `hub_wal_checkpoint_success ${checkpointed}`,
    "# TYPE hub_push_subscriptions gauge", `hub_push_subscriptions ${count(database, "SELECT COUNT(*) AS count FROM push_subscriptions")}`,
    "# TYPE hub_database_ready gauge", `hub_database_ready ${ready.database === "ready" ? 1 : 0}`,
    "# TYPE projection_gaps_unresolved_count gauge", `projection_gaps_unresolved_count ${count(database, "SELECT COUNT(*) AS count FROM session_projection_gaps WHERE resolved_at IS NULL")}`,
    "# TYPE projection_failures_pending_count gauge", `projection_failures_pending_count ${count(database, "SELECT COUNT(*) AS count FROM projection_failures")}`,
    "# TYPE unknown_normalized_event_type_count gauge", `unknown_normalized_event_type_count ${count(database, "SELECT COUNT(*) AS count FROM events WHERE (type = 'unknown' OR type LIKE '%.unknown') AND unixepoch(created_at) >= unixepoch('now', '-24 hours')")}`,
    "# TYPE sse_outbox_oldest_row_age_seconds gauge", `sse_outbox_oldest_row_age_seconds ${Number(outbox.oldest_age_seconds)}`,
    "# TYPE session_hierarchy_roots_count gauge", `session_hierarchy_roots_count ${count(database, "SELECT COUNT(*) AS count FROM session_hierarchy_projection projection JOIN owner_hierarchy_generation generation ON generation.owner_id = projection.owner_id AND generation.active_generation = projection.generation WHERE projection.kind = 'root'")}`,
    "# TYPE session_hierarchy_internal_count gauge", `session_hierarchy_internal_count ${count(database, "SELECT COUNT(*) AS count FROM session_hierarchy_projection projection JOIN owner_hierarchy_generation generation ON generation.owner_id = projection.owner_id AND generation.active_generation = projection.generation WHERE projection.kind = 'internal'")}`,
    "# TYPE session_hierarchy_unknown_count gauge", `session_hierarchy_unknown_count ${count(database, "SELECT COUNT(*) AS count FROM session_hierarchy_projection projection JOIN owner_hierarchy_generation generation ON generation.owner_id = projection.owner_id AND generation.active_generation = projection.generation WHERE projection.kind = 'unknown'")}`,
    "# TYPE session_hierarchy_backfill_incomplete_count gauge", `session_hierarchy_backfill_incomplete_count ${count(database, "SELECT COUNT(*) AS count FROM session_hierarchy_backfill_run WHERE state <> 'complete' OR frozen_at IS NULL OR expected_source_keys <> observed_source_keys")}`,
    "# TYPE session_hierarchy_generation_leases_count gauge", `session_hierarchy_generation_leases_count ${count(database, "SELECT COUNT(*) AS count FROM session_hierarchy_generation_lease WHERE ref_count > 0")}`,
    "# TYPE snapshot_tokens_active_count gauge", `snapshot_tokens_active_count ${count(database, "SELECT COUNT(*) AS count FROM snapshot_tokens WHERE unixepoch(expires_at) > unixepoch('now')")}`,
    "# TYPE backfill_jobs_running_count gauge", `backfill_jobs_running_count ${count(database, "SELECT COUNT(*) AS count FROM backfill_jobs WHERE state = 'running'")}`,
    "# TYPE cutover_pending_sessions_count gauge", `cutover_pending_sessions_count ${count(database, "SELECT COUNT(*) AS count FROM sessions WHERE control_cutover_seq IS NOT NULL AND active_projector_version IS NULL")}`,
    "# TYPE archive_blocked_reason_counts gauge",
    "# TYPE hub_adapter_ready gauge",
  ];
  for (const { session_id, lag } of checkpointLags) lines.push(`projection_checkpoint_lag_events{session_id="${label(session_id)}"} ${lag}`);
  for (const [name, health] of Object.entries(ready.adapters).sort(([left], [right]) => left.localeCompare(right)).slice(0, maxAdapterMetrics)) {
    lines.push(`hub_adapter_ready{adapter="${label(name)}"} ${health === "healthy" ? 1 : 0}`);
  }
  const terminal = "sessions.status = 'terminal' AND sessions.reconciled = 1 AND sessions.archived_at IS NULL";
  const activeVersion = "COALESCE(sessions.active_projector_version, 'legacy')";
  const archiveQueries: Record<(typeof archiveBlockerReasons)[number], string> = {
    "grace-period": `SELECT COUNT(*) AS count FROM sessions WHERE ${terminal} AND unixepoch(updated_at) > unixepoch('now', '-15 minutes')`,
    "open-pending-action": `SELECT COUNT(*) AS count FROM sessions WHERE ${terminal} AND EXISTS (SELECT 1 FROM pending_actions WHERE session_id = sessions.id AND state IN ('pending', 'dispatching', 'unknown'))`,
    "open-command": `SELECT COUNT(*) AS count FROM sessions WHERE ${terminal} AND EXISTS (SELECT 1 FROM commands WHERE session_id = sessions.id AND state IN ('accepted', 'dispatching', 'remote-confirmed'))`,
    "open-work-item": `SELECT COUNT(*) AS count FROM sessions WHERE ${terminal} AND EXISTS (SELECT 1 FROM work_items WHERE session_id = sessions.id AND projector_version = ${activeVersion} AND state NOT IN ('closed', 'done', 'resolved'))`,
    "unresolved-gap": `SELECT COUNT(*) AS count FROM sessions WHERE ${terminal} AND EXISTS (SELECT 1 FROM session_projection_gaps WHERE session_id = sessions.id AND projector_version = ${activeVersion} AND resolved_at IS NULL)`,
    "unresolved-failure": `SELECT COUNT(*) AS count FROM sessions WHERE ${terminal} AND EXISTS (SELECT 1 FROM projection_failures WHERE session_id = sessions.id AND projector_version = ${activeVersion})`,
    "unknown-command-state": `SELECT COUNT(*) AS count FROM sessions WHERE ${terminal} AND EXISTS (SELECT 1 FROM commands WHERE session_id = sessions.id AND state = 'unknown')`,
    "active-projection-checkpoint": `SELECT COUNT(*) AS count FROM sessions WHERE ${terminal} AND COALESCE((SELECT next_expected_seq FROM session_projection_checkpoints WHERE session_id = sessions.id AND projector_version = ${activeVersion}), 1) <> COALESCE((SELECT MAX(seq) + 1 FROM events WHERE session_id = sessions.id), 1)`,
  };
  for (const reason of archiveBlockerReasons) lines.push(`archive_blocked_reason_counts{reason="${reason}"} ${count(database, archiveQueries[reason])}`);
  return `${lines.join("\n")}\n`;
}
