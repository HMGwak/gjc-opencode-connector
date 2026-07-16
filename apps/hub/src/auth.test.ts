import { describe, expect, test } from "bun:test";
import { openCoreDatabase } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";

describe("device pairing authentication", () => {
  test("records only opaque identifiers in audit events", async () => {
    const database = openCoreDatabase();
    const verifier = new DeviceCredentialVerifier({ database, ownerId: "owner", pairingSecret: crypto.getRandomValues(new Uint8Array(32)) });
    const pairing = await verifier.createPairing({ expiresInMs: 60_000 });
    const registration = await verifier.redeemPairing({ code: pairing.code, deviceName: "Phone" });
    const audit = database.sqlite.query("SELECT payload_json FROM audit_log ORDER BY id").all() as Array<{ payload_json: string }>;
    expect(audit.join(" ")).not.toContain(pairing.code);
    expect(audit.join(" ")).not.toContain(registration.credential);
    database.close();
  });
});
