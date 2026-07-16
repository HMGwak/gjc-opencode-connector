import { openCoreDatabase } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";
import { readPairingSecret } from "./pairing-secret";
import { createHubServer, DEFAULT_HOST, DEFAULT_PORT } from "./server";
import { createHubWebHandler } from "./web";

const ownerId = process.env.HUB_OWNER_ID;
const secretPath = process.env.HUB_PAIRING_ROOT_SECRET_FILE;
const webRoot = process.env.HUB_WEB_ROOT;
if (!ownerId || !secretPath || !webRoot) throw new Error("HUB_OWNER_ID, HUB_PAIRING_ROOT_SECRET_FILE, and HUB_WEB_ROOT are required");

const database = openCoreDatabase(process.env.HUB_DATABASE_PATH);
const auth = new DeviceCredentialVerifier({ database, ownerId, pairingSecret: await readPairingSecret(secretPath) });
const api = createHubServer({ database, auth, publicOrigin: process.env.HUB_PUBLIC_ORIGIN });
const handler = createHubWebHandler({ api, webRoot });
Bun.serve({ hostname: DEFAULT_HOST, port: DEFAULT_PORT, fetch: handler.fetch });
