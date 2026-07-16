import { openCoreDatabase } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";
import { readPairingSecret } from "./pairing-secret";
import { createHubServer, DEFAULT_HOST, DEFAULT_PORT } from "./server";
import { GjcOnDiskDiscovery } from "./gjc-ondisk-discovery";
import { createHubWebHandler } from "./web";

const ownerId = process.env.HUB_OWNER_ID;
const secretPath = process.env.HUB_PAIRING_ROOT_SECRET_FILE;
const webRoot = process.env.HUB_WEB_ROOT;
if (!ownerId || !secretPath || !webRoot) throw new Error("HUB_OWNER_ID, HUB_PAIRING_ROOT_SECRET_FILE, and HUB_WEB_ROOT are required");

const database = openCoreDatabase(process.env.HUB_DATABASE_PATH);
const auth = new DeviceCredentialVerifier({ database, ownerId, pairingSecret: await readPairingSecret(secretPath) });
const api = createHubServer({ database, auth, publicOrigin: process.env.HUB_PUBLIC_ORIGIN });
const discovery = new GjcOnDiskDiscovery({
  database,
  ownerId,
  codingAgentDir: process.env.GJC_CODING_AGENT_DIR,
});
const synchronize = () => void discovery.synchronize().catch(() => console.warn("GJC on-disk session discovery failed"));
synchronize();
const intervalMs = Number.parseInt(process.env.HUB_GJC_SYNC_INTERVAL_MS ?? "15000", 10);
const interval = setInterval(synchronize, Number.isFinite(intervalMs) && intervalMs >= 1_000 ? intervalMs : 15_000);
interval.unref();
const handler = createHubWebHandler({ api, webRoot });
Bun.serve({ hostname: DEFAULT_HOST, port: DEFAULT_PORT, fetch: handler.fetch });
