import type { CoreDatabase } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";
import { readPairingSecret } from "./pairing-secret";
import { createHubServer, DEFAULT_HOST, DEFAULT_PORT } from "./server";
import { acquireRuntimeLock, backupThenOpenDatabase } from "./startup";
import { GjcOnDiskDiscovery } from "./gjc-ondisk-discovery";
import { createHubWebHandler } from "./web";

const ownerId = process.env.HUB_OWNER_ID;
const secretPath = process.env.HUB_PAIRING_ROOT_SECRET_FILE;
const webRoot = process.env.HUB_WEB_ROOT;
const databasePath = process.env.HUB_DATABASE_PATH;
if (!ownerId || !secretPath || !webRoot || !databasePath) throw new Error("HUB_OWNER_ID, HUB_PAIRING_ROOT_SECRET_FILE, HUB_WEB_ROOT, and HUB_DATABASE_PATH are required");

const runtimeLock = acquireRuntimeLock(process.env.HUB_RUNTIME_LOCK_PATH ?? `${databasePath}.lock`);
let database: CoreDatabase;
try {
  ({ database } = await backupThenOpenDatabase(databasePath, process.env.HUB_DATABASE_BACKUP_DIR));
} catch (cause) {
  runtimeLock.release();
  throw cause;
}
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
const server = Bun.serve({ hostname: DEFAULT_HOST, port: DEFAULT_PORT, fetch: handler.fetch });

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop();
  try {
    database.sqlite.query("UPDATE sessions SET epoch_owner = NULL, epoch_claimed_at = NULL, view_owner = NULL, view_claimed_at = NULL WHERE epoch_owner IS NOT NULL OR view_owner IS NOT NULL").run();
    database.close();
  } finally {
    runtimeLock.release();
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
