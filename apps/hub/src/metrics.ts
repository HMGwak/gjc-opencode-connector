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

const metricName = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, "_");
const label = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

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
  const ready = await readiness(options);
  const subscriptions = (options.database.sqlite.query("SELECT COUNT(*) AS count FROM push_subscriptions").get() as { count: number }).count;
  const lines = [
    "# TYPE hub_wal_bytes gauge",
    `hub_wal_bytes ${await walBytes(options.database)}`,
    "# TYPE hub_wal_checkpoint_success gauge",
    `hub_wal_checkpoint_success ${checkpointed}`,
    "# TYPE hub_push_subscriptions gauge",
    `hub_push_subscriptions ${subscriptions}`,
    "# TYPE hub_database_ready gauge",
    `hub_database_ready ${ready.database === "ready" ? 1 : 0}`,
    "# TYPE hub_adapter_ready gauge",
  ];
  for (const [name, status] of Object.entries(ready.adapters)) lines.push(`hub_adapter_ready{adapter="${label(metricName(name))}"} ${status === "healthy" ? 1 : 0}`);
  return `${lines.join("\n")}\n`;
}
