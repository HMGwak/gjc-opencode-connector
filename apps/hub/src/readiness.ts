import type { HubMetricsOptions, HubReadiness as BaseHubReadiness } from "./metrics";
import { readiness as baseReadiness } from "./metrics";

export type RecoveryState = "recovering" | "ready" | "failed";

export interface HubReadiness extends BaseHubReadiness {
  readonly recovery: RecoveryState;
}

export async function readiness(options: HubMetricsOptions, recovery: RecoveryState): Promise<HubReadiness> {
  const status = await baseReadiness(options);
  return { ...status, recovery, ok: recovery === "ready" && status.ok };
}
