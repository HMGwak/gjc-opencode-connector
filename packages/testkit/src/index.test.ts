import { describe, expect, test } from "bun:test";
import manifest from "../contracts/control-plane-manifest.json";

describe("Phase 0 control-plane manifest", () => {
  test("pins verified local control-plane versions", () => {
    expect(manifest.opencode.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.gjcCoordinator.version).toMatch(/^gjc\/\d+\.\d+\.\d+$/);
    expect(manifest.probes.every((probe) => probe.readOnly)).toBe(true);
  });

  test("fails closed for unverified replay and mutation semantics", () => {
    expect(manifest.opencode.contracts.prompt_async.expectedStatus).toBe(204);
    expect(manifest.opencode.contracts.cursorReplay.status).toBe("unavailable");
    expect(manifest.gjcCoordinator.contracts.remoteIdempotency.status).toBe("unavailable");
    expect(manifest.gjcCoordinator.contracts.remoteIdempotency.expectation).toContain("unknown");
  });
});
