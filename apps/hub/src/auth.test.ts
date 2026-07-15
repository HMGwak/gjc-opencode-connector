import { describe, expect, test } from "bun:test";
import { AccessJwtVerifier, type AccessJsonWebKey } from "./auth";

const encoder = new TextEncoder();
const base64url = (value: Uint8Array): string => btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const token = async (privateKey: CryptoKey, kid: string, now: number): Promise<string> => {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid })));
  const payload = base64url(encoder.encode(JSON.stringify({ iss: "issuer", aud: "hub", sub: "owner", exp: now / 1000 + 60 })));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${base64url(signature)}`;
};

async function key(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid } as AccessJsonWebKey };
}

describe("AccessJwtVerifier JWKS rotation", () => {
  test("refreshes once bypassing cache for an unknown kid and accepts a rotated key", async () => {
    const now = 1_700_000_000_000; const old = await key("old"); const rotated = await key("new");
    const calls: boolean[] = [];
    const verifier = new AccessJwtVerifier({ issuer: "issuer", audience: "hub", now: () => now, jwks: { resolve: async ({ bypassCache } = {}) => { calls.push(Boolean(bypassCache)); return { keys: bypassCache ? [rotated.jwk] : [old.jwk] }; } } });
    await expect(verifier.verify(await token(rotated.privateKey, "new", now))).resolves.toMatchObject({ sub: "owner" });
    expect(calls).toEqual([false, true]);
  });

  test("single-flights concurrent unknown-kid refreshes and fails closed when absent", async () => {
    const now = 1_700_000_000_000; const old = await key("old"); const unknown = await key("unknown"); let refreshes = 0;
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    const verifier = new AccessJwtVerifier({ issuer: "issuer", audience: "hub", now: () => now, jwks: { resolve: async ({ bypassCache } = {}) => { if (bypassCache) { refreshes++; await pending; } return { keys: [old.jwk] }; } } });
    const signed = await token(unknown.privateKey, "unknown", now);
    const first = verifier.verify(signed); const second = verifier.verify(signed); await Promise.resolve(); release();
    await expect(Promise.all([first, second])).rejects.toThrow("Access JWT rejected");
    expect(refreshes).toBe(1);
  });

  test("rejects malformed refreshed keys and refreshes after cache expiry", async () => {
    let now = 1_700_000_000_000; const valid = await key("key"); let calls = 0;
    const verifier = new AccessJwtVerifier({ issuer: "issuer", audience: "hub", now: () => now, cacheTtlMs: 10, jwks: { resolve: async () => { calls++; return { keys: calls === 1 ? [valid.jwk] : [{ kid: "key", kty: "RSA", n: "bad", e: "bad" }] }; } } });
    const signed = await token(valid.privateKey, "key", now);
    await expect(verifier.verify(signed)).resolves.toMatchObject({ sub: "owner" });
    now += 11;
    await expect(verifier.verify(signed)).rejects.toThrow("Access JWT rejected");
    expect(calls).toBe(2);
  });
});
