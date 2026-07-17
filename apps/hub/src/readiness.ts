import type { HubMetricsOptions, HubReadiness as BaseHubReadiness } from "./metrics";
import { readiness as baseReadiness } from "./metrics";

export interface HierarchyReadiness {
  readonly ownerId: string;
  readonly requiredEpoch: number;
  readonly cycle: number;
  getHierarchyReadiness(ownerId: string, requiredEpoch: number, cycle: number): {
    readonly evidenceSchemaEpoch: number;
    readonly coverageGapCount: number;
    readonly ready: boolean;
  };
}

export type HierarchyState = "ready" | "warming";
export type RecoveryState = "recovering" | "ready" | "failed";

export interface HubReadiness extends BaseHubReadiness {
  readonly recovery: RecoveryState;
  readonly hierarchy?: HierarchyState;
}

export async function readiness(options: HubMetricsOptions, recovery: RecoveryState, hierarchy?: HierarchyReadiness): Promise<HubReadiness> {
  const status = await baseReadiness(options);
  const hierarchyStatus = hierarchy?.getHierarchyReadiness(hierarchy.ownerId, hierarchy.requiredEpoch, hierarchy.cycle);
  const hierarchyState: HierarchyState = hierarchyStatus?.ready === false ? "warming" : "ready";
  return { ...status, recovery, ...(hierarchy ? { hierarchy: hierarchyState } : {}), ok: recovery === "ready" && hierarchyState === "ready" && status.ok };
}
