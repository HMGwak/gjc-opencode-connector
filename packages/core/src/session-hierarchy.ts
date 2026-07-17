import type { SessionHierarchyEvidence, SessionHierarchyProjection, SessionHierarchyUnknownReason } from "./types";

export const MAX_SESSION_HIERARCHY_DEPTH = 64;

/**
 * Classifies one owner's immutable observation snapshot. Callers must never mix
 * owners in a call: a foreign parent is evidence of an invalid edge, not a join.
 */
export function classifyOwnerGraph(ownerId: string, evidence: readonly SessionHierarchyEvidence[]): SessionHierarchyProjection[] {
  const active = evidence.filter((row) => row.ownerId === ownerId && row.deletedAt === null);
  const bySession = new Map<string, SessionHierarchyEvidence>();
  const duplicates = new Set<string>();
  const identities = new Map<string, string>();
  for (const row of active) {
    const identity = `${row.identityNamespace}\u0000${row.sessionId}`;
    if (identities.has(identity)) duplicates.add(row.sessionId);
    else identities.set(identity, row.sessionId);
    if (bySession.has(row.sessionId)) duplicates.add(row.sessionId);
    else bySession.set(row.sessionId, row);
  }

  const result = new Map<string, SessionHierarchyProjection>();
  const classify = (sessionId: string, trail: readonly string[]): SessionHierarchyProjection => {
    const row = bySession.get(sessionId);
    const unknown = (reason: SessionHierarchyUnknownReason): SessionHierarchyProjection => ({
      ownerId, generation: 0, sessionId, kind: "unknown", rootSessionId: null,
      parentSessionId: row?.observedParentSessionId ?? null, unknownReason: reason,
      lineageKind: row?.structuralKind ?? null, internalKind: null, subagentIdentity: null,
    });
    if (!row || row.observationState !== "valid") return unknown("invalid-evidence");
    if (duplicates.has(sessionId)) return unknown("duplicate-header-id");
    if (row.directHumanEvidence) {
      const root: SessionHierarchyProjection = { ownerId, generation: 0, sessionId, kind: "root", rootSessionId: sessionId, parentSessionId: null, unknownReason: null, lineageKind: "direct", internalKind: null, subagentIdentity: null };
      result.set(sessionId, root);
      return root;
    }
    const parent = row.observedParentSessionId;
    if (!parent) return unknown("missing-human-evidence");
    if (row.observedParentOwnerId !== null && row.observedParentOwnerId !== ownerId) return unknown("cross-owner-parent");
    if (parent === sessionId) return unknown("self-parent");
    if (trail.length >= MAX_SESSION_HIERARCHY_DEPTH) return unknown("depth-limit");
    if (trail.includes(sessionId) || trail.includes(parent)) return unknown("cycle");
    if (!bySession.has(parent)) return unknown("missing-parent");
    const parentProjection = classify(parent, [...trail, sessionId]);
    if (parentProjection.kind === "unknown") return unknown(parentProjection.unknownReason ?? "invalid-evidence");
    const projection: SessionHierarchyProjection = {
      ownerId, generation: 0, sessionId, kind: "internal", rootSessionId: parentProjection.rootSessionId,
      parentSessionId: parent, unknownReason: null, lineageKind: row.structuralKind,
      internalKind: row.structuralKind, subagentIdentity: null,
    };
    result.set(sessionId, projection);
    return projection;
  };
  return [...bySession.keys()].sort().map((sessionId) => classify(sessionId, []));
}
