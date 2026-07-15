# SQLite Backup and Isolated Restore Drill

## Safety boundary

- Back up the live SQLite database with SQLite's online backup API only. Do **not** copy the database, `-wal`, or `-shm` files while the service is running.
- Run restore drills against a new, access-restricted directory. Never point a drill at the production database or start the production service with a drill database.
- Backup creation is non-destructive. Promotion of a restored database is a separate, operator-approved change; there is no automatic rollback.
- Keep backup paths, logs, audit exports, and metrics free of credentials and access tokens. Store no secret in a command line, shell history, or this runbook.

## Online backup

Set paths to non-secret local locations. The backup directory must not be served by the hub, mounted into NanoClaw, or shared with any container.

```sh
umask 077
export HUB_DB=/absolute/path/to/hub.sqlite
export BACKUP_ROOT=/absolute/path/to/private-backups
export BACKUP_DB="$BACKUP_ROOT/hub-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
mkdir -p "$BACKUP_ROOT"
sqlite3 "$HUB_DB" ".backup '$BACKUP_DB'"
sqlite3 "$BACKUP_DB" 'PRAGMA quick_check;'
sqlite3 "$BACKUP_DB" 'PRAGMA integrity_check;'
```

Record the UTC timestamp, database filename, `integrity_check` result, SQLite version, backup size, retention class, and operator in an access-controlled operational record. A result other than `ok`, an unreadable backup, or insufficient backup filesystem space is a failed backup; preserve the failure evidence and investigate before claiming a recovery point.

Apply retention only after a newly created backup passes both checks. Deletion is an approved retention operation, not part of the backup command above.

## WAL growth and checkpointing

Measure before deciding to checkpoint:

```sh
sqlite3 "$HUB_DB" 'PRAGMA journal_mode;'
sqlite3 "$HUB_DB" 'PRAGMA wal_checkpoint(PASSIVE);'
du -h "$HUB_DB" "$HUB_DB-wal" "$HUB_DB-shm"
```

`wal_checkpoint(PASSIVE)` does not force active readers to stop. Track WAL size and growth rate, checkpoint result (`busy`, `log`, `checkpointed`), disk free space, and long-lived reader duration. Alert on sustained growth, checkpoint `busy` results that do not clear, or disk pressure; choose thresholds from observed workload rather than this runbook.

A truncating checkpoint can affect writers/readers. It requires a maintenance decision and a quiet window:

```sh
# Operator-approved maintenance only; do not run as an automatic repair.
sqlite3 "$HUB_DB" 'PRAGMA wal_checkpoint(TRUNCATE);'
```

If the checkpoint remains busy, do not delete `-wal` or `-shm` files and do not copy raw files as a substitute. Identify and drain the long-lived reader through its normal lifecycle, then retry the approved checkpoint.

## Isolated restore drill

1. Select a backup that passed integrity checks. Create a new private drill directory; do not reuse a production path.
2. Restore by copying the **closed backup artifact** into that isolated directory, then verify it. This copies a backup file, not a live SQLite database.

```sh
export DRILL_ROOT=/absolute/path/to/private-restore-drill
export RESTORE_DB="$DRILL_ROOT/hub.sqlite"
mkdir -p "$DRILL_ROOT"
cp "$BACKUP_DB" "$RESTORE_DB"
sqlite3 "$RESTORE_DB" 'PRAGMA integrity_check;'
sqlite3 "$RESTORE_DB" 'PRAGMA foreign_key_check;'
sqlite3 "$RESTORE_DB" 'SELECT count(*) AS events FROM events;'
```

3. Compare expected non-secret invariants (for example, schema migration version, event count range, and newest event timestamp) with the recorded backup metadata. Do not print event payloads, audit payloads, JWTs, push endpoints, or configuration values to the drill log.
4. Start only an isolated verification process configured with the restored file and isolated network/storage. Do not expose it through Cloudflare Tunnel and do not start NanoClaw on the host. Exercise read-only health/session inspection and confirm no mutation is accepted until the isolated environment's authorization and adapters have been deliberately configured.
5. Record pass/fail, commands, timestamps, backup ID, integrity results, invariant results, isolation proof, and operator. Delete the isolated drill directory only under the approved retention procedure.

## Production restore decision

A production restore requires an incident record, a tested restore point, an isolated-drill result, a maintenance window, and explicit operator approval. Stop writers through the service's normal lifecycle; preserve the original database and WAL state for forensics; restore into a new candidate location; validate it in isolation; then perform the approved cutover. Never overwrite the only original copy and never perform an automatic rollback.
