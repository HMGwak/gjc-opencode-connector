import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCoreDatabase } from "./database";
import { backupDatabase, BackupRestoreError, restoreDatabase, scanAuditLogForSecrets } from "./operations";

describe("database operations", () => {
  test("online backup is a consistent snapshot while later writes continue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planee-operations-")); const path = join(dir, "journal.db"); const backup = join(dir, "backup.db");
    const database = openCoreDatabase(path); database.createSession({ id: "before", ownerId: "owner-1", adapter: "a", remoteId: "r" });
    await backupDatabase(database, backup);
    database.createSession({ id: "after", ownerId: "owner-1", adapter: "a", remoteId: "r2" }); database.close();
    const snapshot = openCoreDatabase(backup);
    expect(snapshot.getSession("before")).not.toBeNull(); expect(snapshot.getSession("after")).toBeNull(); snapshot.close();
  });

  test("corrupt restore is rejected and leaves the live database unmodified", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planee-operations-")); const path = join(dir, "journal.db"); const bad = join(dir, "bad.db");
    const database = openCoreDatabase(path); database.createSession({ id: "live", ownerId: "owner-1", adapter: "a", remoteId: "r" }); database.close(); await writeFile(bad, "not sqlite");
    await expect(restoreDatabase(bad, path)).rejects.toBeInstanceOf(BackupRestoreError);
    const live = openCoreDatabase(path); expect(live.getSession("live")).not.toBeNull(); live.close();
  });

  test("audit secret scan reports malformed secret-bearing legacy rows", () => {
    const database = openCoreDatabase(); database.sqlite.query("INSERT INTO audit_log (action, payload_json, created_at) VALUES (?, ?, ?)").run("legacy", '{"apiKey":"secret"}', new Date().toISOString());
    expect(scanAuditLogForSecrets(database)).toEqual([{ auditId: 1, reason: "Secret-like key at payload.apiKey" }]); database.close();
  });
});
