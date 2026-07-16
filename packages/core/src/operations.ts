import { Database } from "bun:sqlite";
import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { assertSecretFree, CoreDatabase, SecretDataError } from "./database";

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const temporaryPath = (path: string): string => `${path}.tmp-${crypto.randomUUID()}`;

export class BackupRestoreError extends Error {
  constructor(message: string) { super(message); this.name = "BackupRestoreError"; }
}

export interface BackupResult { readonly path: string; readonly bytes: number; }
export interface RestoreResult { readonly restoredPath: string; readonly quarantinePath: string; }
export interface AuditSecretFinding { readonly auditId: number; readonly reason: string; }
export interface BackupSource { readonly sqlite: Database; readonly filename: string; }

/** Creates a consistent SQLite snapshot without stopping writers, then publishes it atomically. */
export async function backupDatabase(database: BackupSource, destination: string): Promise<BackupResult> {
  if (database.filename === ":memory:") throw new BackupRestoreError("In-memory databases cannot be backed up to a durable path");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = temporaryPath(destination);
  try {
    database.sqlite.exec(`VACUUM INTO ${sqlString(temporary)}`);
    integrityCheck(temporary);
    await rename(temporary, destination);
    return { path: destination, bytes: (await stat(destination)).size };
  } catch (cause) {
    throw new BackupRestoreError(`Backup failed: ${cause instanceof Error ? cause.message : "unknown error"}`);
  }
}

const integrityCheck = (path: string): void => {
  let candidate: Database | undefined;
  try {
    candidate = new Database(path, { readonly: true, strict: true });
    const result = candidate.query("PRAGMA integrity_check").get() as Record<string, unknown> | null;
    if (!result || Object.values(result)[0] !== "ok") throw new BackupRestoreError("Backup integrity check failed");
  } catch (cause) {
    if (cause instanceof BackupRestoreError) throw cause;
    throw new BackupRestoreError("Backup integrity check failed");
  } finally { candidate?.close(); }
};

/** Validates before touching the live journal; corrupt candidates leave the live database intact. */
export async function restoreDatabase(backupPath: string, databasePath: string): Promise<RestoreResult> {
  if (databasePath === ":memory:") throw new BackupRestoreError("In-memory databases cannot be restored from a durable backup");
  integrityCheck(backupPath);
  const temporary = temporaryPath(databasePath);
  await copyFile(backupPath, temporary);
  try { integrityCheck(temporary); } catch (cause) { throw cause; }
  const quarantinePath = `${databasePath}.quarantine-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  try {
    await rename(databasePath, quarantinePath);
    await rename(temporary, databasePath);
    return { restoredPath: databasePath, quarantinePath };
  } catch (cause) {
    throw new BackupRestoreError(`Restore failed without replacing the live journal: ${cause instanceof Error ? cause.message : "unknown error"}`);
  }
}

export function scanAuditLogForSecrets(database: CoreDatabase): AuditSecretFinding[] {
  const rows = database.sqlite.query("SELECT id, payload_json FROM audit_log ORDER BY id").all() as { id: number; payload_json: string }[];
  return rows.flatMap((row) => {
    try { assertSecretFree(JSON.parse(row.payload_json)); return []; }
    catch (cause) { return [{ auditId: row.id, reason: cause instanceof SecretDataError ? cause.message : "Invalid audit payload" }]; }
  });
}
