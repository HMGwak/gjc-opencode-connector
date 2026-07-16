import { openCoreDatabase } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";
import { readPairingSecret } from "./pairing-secret";

const ownerId = process.env.HUB_OWNER_ID;
const secretPath = process.env.HUB_PAIRING_ROOT_SECRET_FILE;
if (!ownerId || !secretPath) throw new Error("HUB_OWNER_ID and HUB_PAIRING_ROOT_SECRET_FILE are required");

const database = openCoreDatabase(process.env.HUB_DATABASE_PATH);
const auth = new DeviceCredentialVerifier({ database, ownerId, pairingSecret: await readPairingSecret(secretPath) });
const [command, argument] = process.argv.slice(2);

try {
  if (command === "create-pairing") {
    const pairing = await auth.createPairing({ expiresInMs: 300_000 });
    console.log(`Pairing code: ${pairing.code}`);
    console.log(`Expires at: ${pairing.expiresAt}`);
  } else if (command === "list-devices") {
    for (const device of auth.listDevices()) console.log(`${device.id}\t${device.deviceName}\t${device.revokedAt ?? "active"}\t${device.lastUsedAt ?? "never used"}`);
  } else if (command === "revoke-device" && argument) {
    if (!auth.revokeDevice(argument)) throw new Error("Active device was not found");
    console.log("Device revoked");
  } else {
    throw new Error("Usage: create-pairing | list-devices | revoke-device <device-id>");
  }
} finally {
  database.close();
}
