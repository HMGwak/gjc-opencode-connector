import { describe, expect, test } from "bun:test";
import { openCoreDatabase } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";

const randomSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

describe("DeviceCredentialVerifier", () => {
  test("issues a one-use pairing code and persists only verification material", async () => {
    const database = openCoreDatabase();
    const verifier = new DeviceCredentialVerifier({ database, ownerId: "owner-1", pairingSecret: randomSecret(), now: () => 1_700_000_000_000 });

    const pairing = await verifier.createPairing({ expiresInMs: 60_000 });

    expect(pairing.code).toMatch(/^\d{6}$/);
    const registration = await verifier.redeemPairing({ code: pairing.code, deviceName: "Personal phone" });

    await expect(verifier.verify(registration.credential)).resolves.toEqual({ sub: "owner-1", deviceId: registration.deviceId });
    expect(database.sqlite.query("SELECT code_hash FROM device_pairings").all()).not.toContain(pairing.code);
    expect(database.sqlite.query("SELECT credential_hash FROM device_credentials").all()).not.toContain(registration.credential);
    database.close();
  });

  test("fails closed for expired, reused, and revoked credentials", async () => {
    let now = 1_700_000_000_000;
    const database = openCoreDatabase();
    const verifier = new DeviceCredentialVerifier({ database, ownerId: "owner-1", pairingSecret: randomSecret(), now: () => now });

    const expired = await verifier.createPairing({ expiresInMs: 1 });
    now += 2;
    await expect(verifier.redeemPairing({ code: expired.code, deviceName: "Phone" })).rejects.toThrow("Pairing code rejected");

    const active = await verifier.createPairing({ expiresInMs: 60_000 });
    const registration = await verifier.redeemPairing({ code: active.code, deviceName: "Phone" });
    await expect(verifier.redeemPairing({ code: active.code, deviceName: "Phone" })).rejects.toThrow("Pairing code rejected");
    expect(verifier.revokeDevice(registration.deviceId)).toBe(true);
    await expect(verifier.verify(registration.credential)).rejects.toThrow("Device credential rejected");
    database.close();
  });
});
