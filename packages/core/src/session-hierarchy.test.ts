import { describe, expect, test } from "bun:test";
import { classifyOwnerGraph, MAX_SESSION_HIERARCHY_DEPTH } from "./session-hierarchy";
import type { SessionHierarchyEvidence } from "./types";

const row = (sessionId: string, overrides: Partial<SessionHierarchyEvidence> = {}): SessionHierarchyEvidence => ({ ownerId: "owner", adapter: "gjc", sourceKey: sessionId, sessionId, identityNamespace: "gjc", observedParentSessionId: null, observedParentOwnerId: null, directHumanEvidence: false, structuralKind: "subagent", observationState: "valid", capturedEpoch: 1, deletedAt: null, ...overrides });

describe("classifyOwnerGraph", () => {
  test("requires direct human evidence for roots and aggregates structural children", () => {
    const result = classifyOwnerGraph("owner", [
      row("root", { directHumanEvidence: true, structuralKind: "direct" }),
      row("child", { observedParentSessionId: "root" }),
      row("forged-subagent", { directHumanEvidence: true, structuralKind: "subagent" }),
      row("unknown"),
    ]);
    expect(result).toMatchObject([
      { sessionId: "child", kind: "internal", rootSessionId: "root" },
      { sessionId: "forged-subagent", kind: "unknown", unknownReason: "missing-human-evidence" },
      { sessionId: "root", kind: "root" },
      { sessionId: "unknown", kind: "unknown", unknownReason: "missing-human-evidence" },
    ]);
  });
  test("preserves continuation edges while resolving every segment to the human origin", () => {
    const result = classifyOwnerGraph("owner", [
      row("origin", { directHumanEvidence: true, structuralKind: "direct" }),
      row("continuation-1", { observedParentSessionId: "origin", structuralKind: "continuation" }),
      row("continuation-2", { observedParentSessionId: "continuation-1", structuralKind: "continuation" }),
    ]);
    expect(result).toMatchObject([
      { sessionId: "continuation-1", kind: "internal", rootSessionId: "origin", parentSessionId: "origin", lineageKind: "continuation" },
      { sessionId: "continuation-2", kind: "internal", rootSessionId: "origin", parentSessionId: "continuation-1", lineageKind: "continuation" },
      { sessionId: "origin", kind: "root", rootSessionId: "origin" },
    ]);
  });
  test("fails closed for self edges, cycles, absent parents, cross-owner edges, and duplicates", () => {
    const result = classifyOwnerGraph("owner", [row("self", { observedParentSessionId: "self" }), row("a", { observedParentSessionId: "b" }), row("b", { observedParentSessionId: "a" }), row("missing", { observedParentSessionId: "gone" }), row("foreign", { observedParentSessionId: "root", observedParentOwnerId: "other" }), row("dup"), row("dup", { sourceKey: "dup-2" })]);
    expect(Object.fromEntries(result.map((item) => [item.sessionId, item.unknownReason]))).toMatchObject({ self: "self-parent", a: "cycle", b: "cycle", missing: "missing-parent", foreign: "cross-owner-parent", dup: "duplicate-header-id" });
  });
  test("enforces the bounded iterative lineage depth", () => {
    const rows = [row("root", { directHumanEvidence: true, structuralKind: "direct" })];
    for (let index = 1; index <= MAX_SESSION_HIERARCHY_DEPTH + 1; index++) rows.push(row(`n${index}`, { observedParentSessionId: index === 1 ? "root" : `n${index - 1}` }));
    expect(classifyOwnerGraph("owner", rows).find((item) => item.sessionId === `n${MAX_SESSION_HIERARCHY_DEPTH + 1}`)).toMatchObject({ kind: "unknown", unknownReason: "depth-limit" });
  });
});
