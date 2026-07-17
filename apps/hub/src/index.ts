import { CoreDatabase, type CoreDatabase as CoreDatabaseType } from "@planee/core";
import { DeviceCredentialVerifier } from "./auth";
import { readPairingSecret } from "./pairing-secret";
import { createHubServer, DEFAULT_HOST, DEFAULT_PORT } from "./server";
import { acquireRuntimeLock, backupThenOpenDatabase, initializeHierarchy } from "./startup";
import { GjcOnDiskDiscovery } from "./gjc-ondisk-discovery";
import { createHubWebHandler } from "./web";

const ownerId = process.env.HUB_OWNER_ID;
const secretPath = process.env.HUB_PAIRING_ROOT_SECRET_FILE;
const webRoot = process.env.HUB_WEB_ROOT;
const databasePath = process.env.HUB_DATABASE_PATH;
const readOnly = process.argv.includes("--readonly");
const binaryVersion = Number.parseInt(process.env.HUB_BINARY_VERSION ?? "1", 10);
if (!ownerId || !secretPath || !webRoot || !databasePath) throw new Error("HUB_OWNER_ID, HUB_PAIRING_ROOT_SECRET_FILE, HUB_WEB_ROOT, and HUB_DATABASE_PATH are required");
if (!Number.isSafeInteger(binaryVersion) || binaryVersion < 1) throw new Error("HUB_BINARY_VERSION must be a positive integer");

const runtimeLock = acquireRuntimeLock(process.env.HUB_RUNTIME_LOCK_PATH ?? `${databasePath}.lock`);
let database: CoreDatabaseType;
try {
  ({ database } = readOnly
    ? { database: new CoreDatabase(databasePath, { readonly: true }) }
    : await backupThenOpenDatabase(databasePath, process.env.HUB_DATABASE_BACKUP_DIR));
  const requiredVersion = database.activeSchemaFenceVersion();
  if (!readOnly && requiredVersion !== null && requiredVersion > binaryVersion) {
    throw new Error(`Database requires binary version ${requiredVersion}; this Hub is version ${binaryVersion}`);
  }
} catch (cause) {
  runtimeLock.release();
  throw cause;
}
const auth = new DeviceCredentialVerifier({ database, ownerId, pairingSecret: await readPairingSecret(secretPath) });
const api = createHubServer({ database, auth, publicOrigin: process.env.HUB_PUBLIC_ORIGIN, readOnly });
const discovery = readOnly ? null : new GjcOnDiskDiscovery({
  database,
  ownerId,
  codingAgentDir: process.env.GJC_CODING_AGENT_DIR,
});
let synchronizing = false;
const synchronize = async (): Promise<void> => {
  if (synchronizing || discovery === null) return;
  synchronizing = true;
  try {
    await discovery.synchronize();
    await initializeHierarchy(database, discovery);
  } catch (cause) {
    console.warn("GJC on-disk session synchronization failed", cause);
  } finally {
    synchronizing = false;
  }
};
if (!readOnly) await synchronize();
const intervalMs = Number.parseInt(process.env.HUB_GJC_SYNC_INTERVAL_MS ?? "15000", 10);
const interval = readOnly ? null : setInterval(() => void synchronize(), Number.isFinite(intervalMs) && intervalMs >= 1_000 ? intervalMs : 15_000);
interval?.unref();
const handler = createHubWebHandler({ api, webRoot });
const server = Bun.serve({ hostname: DEFAULT_HOST, port: DEFAULT_PORT, fetch: handler.fetch });

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop();
  try {
    if (!readOnly) database.sqlite.query("UPDATE sessions SET epoch_owner = NULL, epoch_claimed_at = NULL, view_owner = NULL, view_claimed_at = NULL WHERE epoch_owner IS NOT NULL OR view_owner IS NOT NULL").run();
    database.close();
  } finally {
    runtimeLock.release();
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
