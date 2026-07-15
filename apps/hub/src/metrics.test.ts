import { describe, expect, test } from "bun:test";
import { openCoreDatabase, type AgentAdapter } from "@planee/core";
import { AccessJwtVerifier } from "./auth";
import { prometheusMetrics, readiness } from "./metrics";
import { createHubServer } from "./server";

const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
async function token(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder(); const header = b64(encoder.encode(JSON.stringify({ alg: "RS256", kid: "key" }))); const payload = b64(encoder.encode(JSON.stringify(claims)));
  return `${header}.${payload}.${b64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`))))}`;
}

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
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const now = Date.now(); const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "key" };
    const auth = new AccessJwtVerifier({ issuer: "issuer", audience: "hub", jwks: { resolve: async () => ({ keys: [jwk] }) } }); const database = openCoreDatabase();
    const server = createHubServer({ database, auth, metricsOwnerId: "owner" }); const claims = { iss: "issuer", aud: "hub", sub: "other", exp: now / 1000 + 60 };
    expect((await server.fetch(new Request("http://loopback/api/v1/metrics", { headers: { authorization: `Bearer ${await token(pair.privateKey, claims)}` } }))).status).toBe(403);
    claims.sub = "owner";
    expect((await server.fetch(new Request("http://loopback/api/v1/metrics", { headers: { authorization: `Bearer ${await token(pair.privateKey, claims)}` } }))).status).toBe(200); database.close();
  });
});
