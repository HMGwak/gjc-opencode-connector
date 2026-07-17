import { describe, expect, test } from "bun:test";
import { openCoreDatabase } from "@planee/core";
import { readiness } from "./readiness";

describe("hierarchy readiness", () => {
  test("fails closed while retaining a warm prior generation", async () => {
    const database = openCoreDatabase();
    try {
      database.beginHierarchyBackfillCycle("owner", { epoch: 1, requiredAdapters: ["gjc"] });
      database.classifyAndProjectSessionHierarchy("owner", 1);
      const result = await readiness({ database }, "ready", {
        ownerId: "owner",
        requiredEpoch: 2,
        cycle: 1,
        getHierarchyReadiness: database.getHierarchyReadiness.bind(database),
      });
      expect(database.getHierarchyGeneration("owner")?.activeGeneration).toBe(1);
      expect(result).toMatchObject({ ok: false, recovery: "ready", hierarchy: "warming" });
    } finally {
      database.close();
    }
  });

  test("reports ready only after the requested epoch and cycle are complete", async () => {
    const database = openCoreDatabase();
    try {
      const cycle = database.beginHierarchyBackfillCycle("owner", { epoch: 1, requiredAdapters: [] });
      database.freezeHierarchyBackfillSnapshot("owner", 1, cycle.cycle);
      database.classifyAndProjectSessionHierarchy("owner", 1, { epoch: 1, cycle: cycle.cycle });
      const result = await readiness({ database }, "ready", {
        ownerId: "owner",
        requiredEpoch: 1,
        cycle: cycle.cycle,
        getHierarchyReadiness: database.getHierarchyReadiness.bind(database),
      });
      expect(result).toMatchObject({ ok: true, hierarchy: "ready" });
    } finally {
      database.close();
    }
  });
});
