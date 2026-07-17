import { Database } from "bun:sqlite";
import { backupDatabase, openCoreDatabase, type CoreDatabase } from "@planee/core";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GjcOnDiskDiscovery } from "./gjc-ondisk-discovery";

export interface RuntimeLock { readonly path: string; release(): void; }

const isProcessAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
};

export function acquireRuntimeLock(path: string): RuntimeLock {
  for (;;) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      closeSync(descriptor);
      let owned = true;
      return {
        path,
        release: () => {
          if (!owned) return;
          owned = false;
          try {
            if (Number.parseInt(readFileSync(path, "utf8").trim(), 10) === process.pid) unlinkSync(path);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
        },
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      let pid = Number.NaN;
      try { pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10); }
      catch (readCause) {
        if ((readCause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readCause;
      }
      if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) throw new Error(`Hub runtime lock is held by live process ${pid}`);
      try { unlinkSync(path); }
      catch (unlinkCause) { if ((unlinkCause as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkCause; }
    }
  }
}

const exists = async (path: string): Promise<boolean> => {
  try { return (await stat(path)).isFile(); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
};

export interface DatabaseStartupResult {
  readonly database: CoreDatabase;
  readonly backupPath: string | null;
}

export async function backupThenOpenDatabase(databasePath: string, backupDirectory = join(dirname(databasePath), "backups")): Promise<DatabaseStartupResult> {
  let backupPath: string | null = null;
  if (await exists(databasePath)) {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    backupPath = join(backupDirectory, `pre-migration-${timestamp}.sqlite`);
    const raw = new Database(databasePath, { strict: true });
    try { await backupDatabase({ sqlite: raw, filename: databasePath }, backupPath); }
    finally { raw.close(); }
  }
  const database = openCoreDatabase(databasePath);
  if (backupPath !== null) database.writeAudit({ action: "database.pre_migration_backup", payload: { path: backupPath } });
  return { database, backupPath };
}

export async function initializeHierarchy(database: CoreDatabase, discovery: GjcOnDiskDiscovery, requiredAdapters: readonly string[] = ["gjc"]): Promise<{ readonly epoch: number; readonly cycle: number; readonly projected: boolean }> {
  database.resetHierarchyGenerationLeases();
  return discovery.synchronizeHierarchy(requiredAdapters);
}
