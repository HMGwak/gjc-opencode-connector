export class SecretDataError extends Error {
  constructor(message = "Persistent journals must not contain secrets") {
    super(message);
    this.name = "SecretDataError";
  }
}

const SECRET_KEY = /(?:secret|password|token|api[_-]?key|authorization|credential|private[_-]?key|auth)/i;
const SECRET_VALUE = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/i;

export const REDACTED = "[REDACTED]";
export const MAX_SCAN_INPUT_BYTES = 65_536;
export const SINK_KINDS = [
  "events",
  "work-items",
  "pending-actions",
  "projection-diagnostics",
  "audit",
  "sse-outbox",
  "push",
  "snapshots",
] as const;
export type SinkKind = (typeof SINK_KINDS)[number];
const AUTHORITATIVE_SINK_TABLES = {
  events: { sink: "events", payloadColumns: ["payload_json"], implicitColumns: ["session_id", "seq", "type", "payload_json", "created_at"] },
  work_items: { sink: "work-items", payloadColumns: ["payload_json"] },
  pending_actions: { sink: "pending-actions", payloadColumns: ["payload_json", "answer_json"] },
  session_projection_gaps: { sink: "projection-diagnostics", payloadColumns: ["reason"] },
  projection_failures: { sink: "projection-diagnostics", payloadColumns: ["reason"], implicitColumns: ["session_id", "projector_version", "seq", "reason", "failed_at"] },
  corrupt_payloads: { sink: "projection-diagnostics", payloadColumns: ["payload_json"] },
  audit_log: { sink: "audit", payloadColumns: ["payload_json"] },
  sse_outbox: { sink: "sse-outbox", payloadColumns: ["event_json"] },
  push_subscriptions: { sink: "push", payloadColumns: ["encrypted_material"] },
  snapshot_rows: { sink: "snapshots", payloadColumns: ["payload_json"], implicitColumns: ["token", "row_key", "payload_json"] },
} as const satisfies Record<string, { sink: SinkKind; payloadColumns: readonly string[]; implicitColumns?: readonly string[] }>;

/**
 * Audited legacy copies are the only authoritative writes permitted without a
 * value sanitizer: their source is a retired table, not application input.
 */
const AUDITED_MIGRATION_COPIES: Readonly<Record<string, readonly string[]>> = {
  sse_outbox: ["sse_outbox_legacy"],
  corrupt_payloads: ["backfill_jobs_legacy", "${table}_unsupported_legacy"],
  session_projection_gaps: ["session_projection_gaps_legacy"],
  pending_actions: ["pending_actions_legacy", "pending_actions_owner_legacy"],
  work_items: ["work_items_legacy"],
};

/** Reports executable authoritative writes whose payload parameter is not sanitized in place. */
export function findUnsafeAuthoritativeSinkWrites(source: string): string[] {
  const failures: string[] = [];
  const query = /(?:\b[\w$.]+)\.query\(\s*(?:`([\s\S]*?)`|"([^"]*?)"|'([^']*?)')\s*\)/g;
  const exec = /(?:\b[\w$.]+)\.exec\(\s*(?:`([\s\S]*?)`|"([^"]*?)"|'([^']*?)')\s*\)/g;

  for (const match of source.matchAll(query)) check(match, false);
  for (const match of source.matchAll(exec)) check(match, true);
  return failures;

  function check(match: RegExpMatchArray, isExec: boolean): void {
    const sql = match[1] ?? match[2] ?? match[3] ?? "";
    for (const [table, specification] of Object.entries(AUTHORITATIVE_SINK_TABLES)) {
      if (!new RegExp(`\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE)\\s+${table}\\b`, "i").test(sql)) continue;
      if (isAuditedMigrationCopy(table, sql) || isAuditedMigrationUpdate(table, sql)) continue;

      const statement = source.slice(match.index! + match[0].length);
      if (!isExec && payloadArgumentsAreSanitized(sql, statement, specification)) continue;
      failures.push(`${table} write bypasses ${specification.sink}`);
    }
  }
}
function payloadArgumentsAreSanitized(sql: string, statement: string, specification: { sink: SinkKind; payloadColumns: readonly string[]; implicitColumns?: readonly string[] }): boolean {
  const run = /^\s*\.run\(/.exec(statement);
  if (!run) return false;

  let depth = 1;
  let end = run[0].length;
  for (; end < statement.length && depth > 0; end++) {
    if (statement[end] === "(") depth++;
    if (statement[end] === ")") depth--;
  }
  if (depth !== 0) return false;
  const args = splitTopLevel(statement.slice(run[0].length, end - 1));
  const columns = writeColumns(sql, specification.implicitColumns);
  if (!columns) return false;
  const values = writeValues(sql);
  if (!values || columns.length !== values.length) return false;

  let parameter = 0;
  for (let index = 0; index < columns.length; index++) {
    if (values[index]!.trim() !== "?") continue;
    if (specification.payloadColumns.includes(columns[index]!.toLowerCase()) && !isSanitizer(args[parameter] ?? "", specification.sink)) return false;
    parameter++;
  }
  return true;
}
function writeColumns(sql: string, implicitColumns?: readonly string[]): string[] | null {
  const insert = /\bINSERT(?:\s+OR\s+\w+)?\s+INTO\s+\w+\s*(?:\(([^)]*)\))?/i.exec(sql);
  if (insert) return (insert[1] ? insert[1].split(",") : implicitColumns)?.map((column) => column.trim().toLowerCase()) ?? null;
  const update = /\bUPDATE\s+\w+\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|$)/i.exec(sql);
  return update ? splitTopLevel(update[1]).map((assignment) => assignment.split("=")[0]!.trim().toLowerCase()) : null;
}
function writeValues(sql: string): string[] | null {
  const values = /\bVALUES\s*\(([\s\S]*?)\)/i.exec(sql);
  if (values) return splitTopLevel(values[1]);
  const select = /\bSELECT\s+([\s\S]*?)\s+FROM\b/i.exec(sql);
  if (select) return splitTopLevel(select[1]);
  const update = /\bUPDATE\s+\w+\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|$)/i.exec(sql);
  return update ? splitTopLevel(update[1]).map((assignment) => assignment.slice(assignment.indexOf("=") + 1)) : null;
}
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    else if (value[index] === ")") depth--;
    else if (value[index] === "," && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start));
  return parts;
}
function isSanitizer(argument: string, sink: SinkKind): boolean {
  const escaped = sink.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`(?:^|\\b)(?:json|redactForSink|redactDiagnostic)\\(\\s*["']${escaped}["']`).test(argument.trim()) ||
    (sink === "projection-diagnostics" && /^projectionGapReason\(/.test(argument.trim()));
}
function isAuditedMigrationCopy(table: string, sql: string): boolean {
  if (!/\bINSERT\b[\s\S]*\bSELECT\b/i.test(sql)) return false;
  return (AUDITED_MIGRATION_COPIES[table] ?? []).some((sourceTable) =>
    new RegExp(`\\bFROM\\s+${sourceTable.replace(/[${}]/g, "\\$&")}\\b`, "i").test(sql));
}
function isAuditedMigrationUpdate(table: string, sql: string): boolean {
  const normalized = sql.replace(/\s+/g, " ").trim();
  return (table === "sse_outbox" &&
    /^UPDATE sse_outbox SET owner_id = \(SELECT owner_id FROM sessions WHERE sessions\.id = sse_outbox\.session_id\) WHERE owner_id IS NULL OR trim\(owner_id\) = '';$/i.test(normalized)) ||
    (table === "pending_actions" &&
    /^UPDATE pending_actions SET owner_id = COALESCE\(\(SELECT owner_id FROM sessions WHERE sessions\.id = pending_actions\.session_id\), ''\) WHERE owner_id = ''$/i.test(normalized));
}

const DIAGNOSTIC_SECRET = /\b(?:bearer|basic)\s+\S+|(?:secret|password|token|api[_-]?key|authorization|credential|private[_-]?key|auth)\s*(?:[:=]|\bis\b)\s*\S+/i;
const MAX_DIAGNOSTIC_LENGTH = 16_384;
const REDACTED_DIAGNOSTIC = "[REDACTED DIAGNOSTIC]";

/** Returns a bounded, JSON-safe diagnostic value without secret-bearing fields. */
export function redact(value: unknown, maxDepth = 6, maxEntries = 100): unknown {
  let entries = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return SECRET_VALUE.test(item) ? REDACTED : item;
    if (item === null || typeof item !== "object") return item;
    if (depth >= maxDepth || entries >= maxEntries) return "[TRUNCATED]";
    if (Array.isArray(item)) return item.map((entry) => { entries++; return visit(entry, depth + 1); });
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(item)) {
      if (entries++ >= maxEntries) { result["…"] = "[TRUNCATED]"; break; }
      result[key] = SECRET_KEY.test(key) ? REDACTED : visit(entry, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}
/**
 * Scans the complete bounded input before redaction or truncation, then returns
 * the safe representation for one of the authoritative persistence sinks.
 */
export function redactForSink(sinkKind: SinkKind, value: unknown, options: { maxDepth?: number; maxEntries?: number } = {}): unknown {
  void sinkKind;
  return redactPersistenceValue(value, options);
}

/**
 * Commands are intentionally outside the authoritative sink taxonomy, but are
 * still durable payloads and therefore receive the same complete pre-truncation scan.
 */
export function redactForCommand(value: unknown, options: { maxDepth?: number; maxEntries?: number } = {}): unknown {
  return redactPersistenceValue(value, options);
}

function redactPersistenceValue(value: unknown, options: { maxDepth?: number; maxEntries?: number }): unknown {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new TypeError("Persistent payloads must serialize to JSON values");
  if (new TextEncoder().encode(serialized).byteLength > MAX_SCAN_INPUT_BYTES) {
    throw new SecretDataError(`Sink payload exceeds ${MAX_SCAN_INPUT_BYTES} UTF-8 bytes`);
  }
  const accepted = JSON.parse(serialized);
  assertSecretFree(accepted);
  return redact(accepted, options.maxDepth ?? 16, options.maxEntries ?? 10_000);
}

/** Returns a bounded diagnostic string which cannot persist secret-like text. */
export function redactDiagnostic(_sink: SinkKind, value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
  if (text.length > MAX_DIAGNOSTIC_LENGTH) throw new RangeError("Diagnostic exceeds length limit");
  return DIAGNOSTIC_SECRET.test(text) ? REDACTED_DIAGNOSTIC : text;
}

export function assertSecretFree(value: unknown): void {
  const visit = (item: unknown, path: string): void => {
    if (typeof item === "string") {
      if (SECRET_VALUE.test(item)) throw new SecretDataError(`Secret-like value at ${path}`);
      return;
    }
    if (Array.isArray(item)) { item.forEach((entry, index) => visit(entry, `${path}[${index}]`)); return; }
    if (item !== null && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        if (SECRET_KEY.test(key)) throw new SecretDataError(`Secret-like key at ${path}.${key}`);
        visit(entry, `${path}.${key}`);
      }
    }
  };
  visit(value, "payload");
}
