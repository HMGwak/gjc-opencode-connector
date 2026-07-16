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
});
