import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupThenOpenDatabase, initializeHierarchy } from "./startup";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hub database startup", () => {
  test("creates and integrity-checks a WAL-safe snapshot before migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-startup-"));
    roots.push(root);
    const databasePath = join(root, "hub.sqlite");
    const legacy = new Database(databasePath, { strict: true });
    legacy.exec("PRAGMA journal_mode = WAL");
    legacy.exec("PRAGMA wal_autocheckpoint = 0");
    legacy.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL)");
    legacy.query("INSERT INTO legacy_marker (value) VALUES (?)").run("from-wal");
    legacy.close();

    const result = await backupThenOpenDatabase(databasePath, join(root, "backups"));
    try {
      expect(result.backupPath).not.toBeNull();
      const backup = new Database(result.backupPath!, { readonly: true, strict: true });
      try {
        expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(backup.query("SELECT value FROM legacy_marker").get()).toEqual({ value: "from-wal" });
        expect(backup.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()).toBeNull();
      } finally {
        backup.close();
      }
      expect(result.database.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(result.database.sqlite.query("SELECT action FROM audit_log WHERE action = 'database.pre_migration_backup'").get()).toEqual({ action: "database.pre_migration_backup" });
    } finally {
      result.database.close();
    }
  });

  test("does not create a backup for a brand-new database", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-startup-new-"));
    roots.push(root);
    const result = await backupThenOpenDatabase(join(root, "hub.sqlite"), join(root, "backups"));
    try { expect(result.backupPath).toBeNull(); }
    finally { result.database.close(); }
  });
  test("resets hierarchy generation leases before hierarchy initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-startup-hierarchy-"));
    roots.push(root);
    const result = await backupThenOpenDatabase(join(root, "hub.sqlite"));
    try {
      const generation = result.database.acquireGenerationLease("owner");
      await initializeHierarchy(result.database, { synchronizeHierarchy: async () => ({ epoch: 1, cycle: 1, projected: false }) } as never);
      expect(() => result.database.releaseGenerationLease("owner", generation)).toThrow("not acquired");
    } finally {
      result.database.close();
    }
  });
});
