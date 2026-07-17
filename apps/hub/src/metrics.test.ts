import { describe, expect, test } from "bun:test";
import { openCoreDatabase, type AgentAdapter } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";
import { prometheusMetrics, readiness } from "./metrics";
import { createHubServer } from "./server";

const randomSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

describe("operational metrics", () => {
  test("reports WAL checkpoint and subscription metrics", async () => {
    const database = openCoreDatabase();
    const metrics = await prometheusMetrics({ database });
    expect(metrics).toContain("hub_wal_bytes 0"); expect(metrics).toContain("hub_wal_checkpoint_success 1"); expect(metrics).toContain("hub_push_subscriptions 0"); database.close();
  });

  test("unhealthy adapters fail readiness", async () => {
    const database = openCoreDatabase();
    const adapter: AgentAdapter = { name: "bad", reconciliationCapabilities: { stableRemoteId: true, revision: true, terminalState: true, tombstone: true, watermark: true, fencing: true }, reconcile: async () => null };
    expect(await readiness({ database, adapters: { bad: adapter }, adapterHealth: () => "unhealthy" })).toMatchObject({ ok: false, adapters: { bad: "unhealthy" } }); database.close();
  });
  test("exports bounded adapter health metrics", async () => {
    const database = openCoreDatabase();
    const adapter: AgentAdapter = { name: "adapter", reconciliationCapabilities: { stableRemoteId: true, revision: true, terminalState: true, tombstone: true, watermark: true, fencing: true }, reconcile: async () => null };
    const adapters = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`adapter-${String(index).padStart(2, "0")}`, adapter]));
    const metrics = await prometheusMetrics({ database, adapters, adapterHealth: (name) => name === "adapter-00" ? "unhealthy" : "healthy" });
    const adapterLines = metrics.match(/^hub_adapter_ready\{adapter="[^"]+"\} [01]$/gm) ?? [];
    expect(adapterLines).toHaveLength(20);
    expect(metrics).toContain('hub_adapter_ready{adapter="adapter-00"} 0');
    expect(metrics).toContain('hub_adapter_ready{adapter="adapter-01"} 1');
    expect(metrics).not.toContain('hub_adapter_ready{adapter="adapter-20"}');
    database.close();
  });

  test("metrics requires the configured owner", async () => {
    const database = openCoreDatabase();
    const ownerAuth = new DeviceCredentialVerifier({ database, ownerId: "owner", pairingSecret: randomSecret() });
    const otherAuth = new DeviceCredentialVerifier({ database, ownerId: "other", pairingSecret: randomSecret() });
    const server = createHubServer({ database, auth: ownerAuth, metricsOwnerId: "owner" });
    const otherPairing = await otherAuth.createPairing({ expiresInMs: 60_000 });
    const other = await otherAuth.redeemPairing({ code: otherPairing.code, deviceName: "Other" });
    expect((await server.fetch(new Request("http://loopback/api/v1/metrics", { headers: { authorization: `Bearer ${other.credential}` } }))).status).toBe(403);
    const ownerPairing = await ownerAuth.createPairing({ expiresInMs: 60_000 });
    const owner = await ownerAuth.redeemPairing({ code: ownerPairing.code, deviceName: "Owner" });
    expect((await server.fetch(new Request("http://loopback/api/v1/metrics", { headers: { authorization: `Bearer ${owner.credential}` } }))).status).toBe(200); database.close();
  });
  test("counts checkpoint lag as the inclusive pending sequence interval", async () => {
    const database = openCoreDatabase();
    const cases = [
      { id: "caught-up", maximumSeq: 5, nextExpectedSeq: 6, lag: 0 },
      { id: "one-pending", maximumSeq: 5, nextExpectedSeq: 5, lag: 1 },
      { id: "multiple-pending", maximumSeq: 5, nextExpectedSeq: 2, lag: 4 },
    ];
    for (const { id, maximumSeq, nextExpectedSeq } of cases) {
      database.createSession({ id, ownerId: "owner", adapter: "adapter", remoteId: id });
      database.sqlite.query("UPDATE sessions SET active_projector_version = 'gjc-ondisk-v1' WHERE id = ?").run(id);
      database.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, 'event', '{}', datetime('now'))").run(id, maximumSeq);
      database.sqlite.query("INSERT INTO session_projection_checkpoints VALUES (?, 'gjc-ondisk-v1', ?, datetime('now'))").run(id, nextExpectedSeq);
    }
    const metrics = await prometheusMetrics({ database });
    for (const { id, lag } of cases) expect(metrics).toContain(`projection_checkpoint_lag_events{session_id="${id}"} ${lag}`);
    database.close();
  });
  test("exports the authoritative bounded metrics contract", async () => {
    const database = openCoreDatabase();
    const ids = ["pending", "open-command", "unknown-command", "work", "gap", "failure", "grace"];
    for (const id of ids) database.createSession({ id, ownerId: "owner", adapter: "adapter", remoteId: id });
    database.createPendingActionForOwner({ id: "action", ownerId: "owner", sessionId: "pending", payload: { marker: "never-a-label" }, expiresAt: "2030-01-01T00:00:00.000Z" });
    database.setReconciliation("open-command", "active", 1, true, "revision");
    database.acceptCommand({ id: "open-command", sessionId: "open-command", idempotencyKey: "open-command-key", payload: {} });
    database.setReconciliation("unknown-command", "active", 1, true, "revision");
    database.acceptCommand({ id: "unknown-command", sessionId: "unknown-command", idempotencyKey: "unknown-command-key", payload: {} });
    database.sqlite.query("UPDATE commands SET state = 'unknown' WHERE id = 'unknown-command'").run();
    database.upsertWorkItem({ id: "work", ownerId: "owner", sessionId: "work", remoteId: "work", state: "open", payload: {} });
    database.sqlite.query("INSERT INTO session_projection_gaps VALUES ('gap', 'legacy', 1, 'missing', NULL, '2026-01-01T00:00:00.000Z')").run();
    database.sqlite.query("INSERT INTO projection_failures VALUES ('failure', 'legacy', 1, 'failed', '2026-01-01T00:00:00.000Z')").run();
    for (const id of ids) database.sqlite.query("UPDATE sessions SET status = 'terminal', reconciled = 1, reconciliation_epoch = reconciliation_epoch + 1 WHERE id = ?").run(id);
    for (let index = 0; index < 70; index += 1) {
      const id = `lag-${String(index).padStart(2, "0")}`;
      database.createSession({ id, ownerId: "owner", adapter: "adapter", remoteId: id });
      database.sqlite.query("UPDATE sessions SET active_projector_version = 'gjc-ondisk-v1' WHERE id = ?").run(id);
      database.sqlite.query("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, '{}', datetime('now'))").run(id, 10, index === 0 ? "normalized.unknown" : "event");
      database.sqlite.query("INSERT INTO session_projection_checkpoints VALUES (?, 'gjc-ondisk-v1', 1, datetime('now'))").run(id);
    }
    database.sqlite.query("INSERT INTO sse_outbox (owner_id, session_id, event_json, created_at) VALUES ('owner', 'pending', '{}', '2000-01-01T00:00:00.000Z')").run();
    database.sqlite.query("INSERT INTO snapshot_tokens VALUES ('token-secret', 'owner', 0, '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    database.saveBackfillJob("job-running", {}, "running");
    const metrics = await prometheusMetrics({ database });

    expect(metrics).toContain("projection_gaps_unresolved_count 1");
    expect(metrics).toContain("projection_failures_pending_count 1");
    expect(metrics).toContain("unknown_normalized_event_type_count 1");
    expect(metrics).toMatch(/sse_outbox_oldest_row_age_seconds [1-9]\d*/);
    expect(metrics).toContain("snapshot_tokens_active_count 1");
    expect(metrics).toContain("backfill_jobs_running_count 1");
    expect(metrics).toContain("cutover_pending_sessions_count 0");
    expect(metrics).toContain("session_hierarchy_roots_count 0");
    expect(metrics).toContain("session_hierarchy_internal_count 0");
    expect(metrics).toContain("session_hierarchy_unknown_count 0");
    expect(metrics).toContain("session_hierarchy_backfill_incomplete_count 0");
    expect(metrics).toContain("session_hierarchy_generation_leases_count 0");
    const lagLines = metrics.match(/^projection_checkpoint_lag_events\{session_id="[^"]+"\} \d+$/gm) ?? [];
    expect(lagLines).toHaveLength(20);
    expect(lagLines[0]).toContain('session_id="lag-00"');
    expect(lagLines[19]).toContain('session_id="lag-19"');
    expect(lagLines).toEqual(expect.arrayContaining([
      'projection_checkpoint_lag_events{session_id="lag-00"} 10',
      'projection_checkpoint_lag_events{session_id="lag-19"} 10',
    ]));
    expect([...metrics.matchAll(/^archive_blocked_reason_counts\{reason="([^"]+)"\} \d+$/gm)].map((match) => match[1])).toEqual([
      "grace-period", "open-pending-action", "open-command", "open-work-item", "unresolved-gap", "unresolved-failure", "unknown-command-state", "active-projection-checkpoint",
    ]);
    expect(metrics).toContain('archive_blocked_reason_counts{reason="open-pending-action"} 1');
    expect(metrics).toContain('archive_blocked_reason_counts{reason="open-command"} 1');
    expect(metrics).toContain('archive_blocked_reason_counts{reason="open-work-item"} 1');
    expect(metrics).toContain('archive_blocked_reason_counts{reason="unresolved-gap"} 1');
    expect(metrics).toContain('archive_blocked_reason_counts{reason="unresolved-failure"} 1');
    expect(metrics).toContain('archive_blocked_reason_counts{reason="unknown-command-state"} 1');
    expect(metrics).not.toContain("token-secret");
    expect(metrics).not.toContain("never-a-label");
    database.close();
  });
});
