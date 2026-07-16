import type { Session } from "@planee/core";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_FILE = /^(\d{4}-\d{2}-\d{2}T[^_]+)_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i;
const VIEW_LEASE_MS = 45_000;
const GJC_PROJECTOR_VERSION = "gjc-ondisk-v1";

export type RemoteProjectionEvent = {
  readonly sourceEventId: string;
  readonly sourceRevision: string;
  readonly sourcePosition: number;
  readonly contentHash: string;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: string;
};

export type OnDiskDiscoveryDatabase = {
  upsertDiscoveredSession(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly adapter: "gjc";
    readonly remoteId: string;
    readonly controlMode: "view-only";
    readonly origin: "ondisk-discovery";
    readonly transcriptStatus: "available" | "unreadable";
    readonly updatedAt: string;
    readonly title?: string | null;
    readonly workdir?: string | null;
    readonly sourceCreatedAt?: string | null;
  }): Session;
  getSessionByRemoteIdForOwner(ownerId: string, adapter: string, remoteId: string): Session | null;
  claimView(input: { readonly sessionId: string; readonly owner: string; readonly claimedAt: string; readonly staleBefore: string }): boolean;
  projectRemoteBatch(input: {
    readonly mode: "view";
    readonly sessionId: string;
    readonly adapter: string;
    readonly source: "gjc-ondisk";
    readonly cursorScope: string;
    readonly owner: string;
    readonly cursor: string;
    readonly events: ReadonlyArray<RemoteProjectionEvent>;
  }): number;
  applyProjection(input: {
    readonly sessionId: string;
    readonly ownerId: string;
    readonly projectorVersion: string;
    readonly effectKey: string;
    readonly apply: (event: { readonly type: string; readonly payload: unknown }) => void;
  }): number;
  upsertWorkItem(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly sessionId: string;
    readonly remoteId: string;
    readonly state: string;
    readonly payload: unknown;
    readonly projectorVersion: string;
  }): unknown;
  listProjectionFailures(sessionId: string, projectorVersion: string): ReadonlyArray<unknown>;
  cutoverProjectorVersion(input: {
    readonly sessionId: string;
    readonly ownerId: string;
    readonly projectorVersion: string;
    readonly expectedCurrentVersion: string | null;
    readonly expectedReconciliationEpoch: number;
    readonly workItems: ReadonlyArray<{
      readonly id: string;
      readonly remoteId: string;
      readonly state: string;
      readonly payload: unknown;
    }>;
  }): boolean;
};

export type GjcOnDiskDiscoveryOptions = {
  readonly database: OnDiskDiscoveryDatabase;
  readonly ownerId: string;
  readonly codingAgentDir?: string;
  readonly viewOwner?: string;
  readonly now?: () => Date;
};

type ParsedTranscript = {
  readonly remoteId: string;
  readonly updatedAt: string;
  readonly sourceRevision: string;
  readonly events: readonly RemoteProjectionEvent[];
  readonly title: string;
  readonly workdir: string;
  readonly sourceCreatedAt: string;
};

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const AUTH_TOKEN = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.replace(AUTH_TOKEN, "[redacted]");
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const p = record(part);
    if (!p) continue;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    else if (p.type === "toolCall" && typeof p.name === "string") parts.push(`[tool: ${p.name}]`);
    else if (p.type === "thinking") parts.push("[thinking]");
  }
  return parts.join("\n").replace(AUTH_TOKEN, "[redacted]");
}

// The journal forbids secret-like keys/values, so project a minimal display shape
// (type/role/text) instead of the raw GJC entry, which carries usage.totalTokens etc.
function sanitizeEntry(entry: Record<string, unknown>, sourceEventId: string, requestSourceEventId?: string): Record<string, unknown> {
  const message = record(entry.message);
  if (!message) return { type: entry.type };
  const role = typeof message.role === "string" ? message.role : undefined;
  const text = textFromContent(message.content);
  return {
    type: entry.type,
    ...(role ? { role } : {}),
    ...(text ? { text } : {}),
    sourceEventId,
    ...(requestSourceEventId ? { requestSourceEventId } : {}),
  };
}

function sessionTitle(header: Record<string, unknown>, cwd: string, id: string): string {
  if (typeof header.title === "string") {
    const title = header.title.replace(/\s+/g, " ").trim();
    if (title.length > 0 && title.length <= 160 && !/[\u0000-\u001f\u007f]/.test(title)) return title;
  }
  const project = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "Session";
  return `${project} · ${id.slice(0, 8)}`;
}
function workItemForEvent(sessionId: string, event: { type: string; payload: unknown }): { id: string; remoteId: string; state: string; payload: unknown } | null {
  if (event.type !== "gjc.message") return null;
  const payload = record(event.payload);
  const role = payload?.role;
  const text = payload?.text;
  if ((role !== "user" && role !== "assistant") || typeof text !== "string" || !text.trim() || /^\[(?:thinking|tool:)/i.test(text.trim())) return null;

  if (role === "user") {
    const sourceEventId = typeof payload?.sourceEventId === "string" ? payload.sourceEventId : null;
    if (!sourceEventId) return null;
    const remoteId = `gjc-user:${sourceEventId}`;
    return { id: sha256(`${sessionId}:${remoteId}`), remoteId, state: "in-progress", payload: { title: text.trim() } };
  }

  const requestSourceEventId = typeof payload?.requestSourceEventId === "string" ? payload.requestSourceEventId : null;
  if (!requestSourceEventId) return null;
  const remoteId = `gjc-user:${requestSourceEventId}`;
  return { id: sha256(`${sessionId}:${remoteId}`), remoteId, state: "done", payload: { result: text.trim() } };
}

function parseTranscript(text: string, filenameId: string, fallbackUpdatedAt: string): ParsedTranscript {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error("Empty GJC transcript");

  const parsed = lines.map((line) => JSON.parse(line) as unknown);
  const header = record(parsed[0]);
  if (!header || header.type !== "session" || typeof header.id !== "string" || header.id !== filenameId) {
    throw new Error("Unrecognized GJC session header");
  }
  const version = header.version === undefined ? 1 : header.version;
  if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > 3) throw new Error("Unsupported GJC session version");
  if (typeof header.timestamp !== "string" || typeof header.cwd !== "string") throw new Error("Incomplete GJC session header");
  const sourceCreatedAt = new Date(header.timestamp);
  if (Number.isNaN(sourceCreatedAt.getTime())) throw new Error("Invalid GJC session timestamp");

  const events: RemoteProjectionEvent[] = [];
  const sourceEventIds = new Map<string, string>();
  for (let index = 1; index < parsed.length; index++) {
    const entry = record(parsed[index]);
    if (!entry || typeof entry.type !== "string") continue;
    const nativeId = typeof entry.id === "string" && entry.id.length > 0 ? `${entry.id}#${index + 1}` : `pos:${index + 1}`;
    const parentId = typeof entry.parentId === "string" ? sourceEventIds.get(entry.parentId) : undefined;
    const createdAt = typeof entry.timestamp === "string" ? entry.timestamp : fallbackUpdatedAt;
    events.push({
      sourceEventId: nativeId,
      sourceRevision: String(version),
      sourcePosition: index + 1,
      contentHash: sha256(lines[index]!),
      type: `gjc.${entry.type}`,
payload: sanitizeEntry(entry, nativeId, parentId),
      createdAt,
    });
    if (typeof entry.id === "string" && entry.id.length > 0) sourceEventIds.set(entry.id, nativeId);
  }
  const lastTimestamp = events.at(-1)?.createdAt;
  return {
    remoteId: filenameId,
    updatedAt: lastTimestamp ?? fallbackUpdatedAt,
    sourceRevision: String(version),
    events,
    title: sessionTitle(header, header.cwd, filenameId),
    workdir: header.cwd,
    sourceCreatedAt: sourceCreatedAt.toISOString(),
  };
}

export class GjcOnDiskDiscovery {
  private readonly root: string;
  private readonly viewOwner: string;
  private readonly now: () => Date;
  // Skip re-reading/re-parsing session files whose mtime has not advanced since the last sync,
  // so an always-on daemon does full work once and near-zero per interval tick.
  private readonly lastMtimeMs = new Map<string, number>();

  constructor(private readonly options: GjcOnDiskDiscoveryOptions) {
    this.root = join(options.codingAgentDir ?? join(homedir(), ".gjc", "agent"), "sessions");
    this.viewOwner = options.viewOwner ?? `gjc-ondisk:${process.pid}:${crypto.randomUUID()}`;
    this.now = options.now ?? (() => new Date());
  }

  async synchronize(): Promise<number> {
    let cwdDirectories;
    try {
      cwdDirectories = await readdir(this.root, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw cause;
    }

    let discovered = 0;
    for (const cwdDirectory of cwdDirectories) {
      if (!cwdDirectory.isDirectory()) continue;
      const cwdPath = join(this.root, cwdDirectory.name);
      let files;
      try { files = await readdir(cwdPath, { withFileTypes: true }); } catch { continue; }
      for (const file of files) {
        if (!file.isFile()) continue;
        const match = SESSION_FILE.exec(file.name);
        if (!match) continue;
        await this.discoverFile(join(cwdPath, file.name), match[2]!);
        discovered++;
      }
    }
    return discovered;
  }

  private async discoverFile(path: string, filenameId: string): Promise<void> {
    const existing = this.options.database.getSessionByRemoteIdForOwner(this.options.ownerId, "gjc", filenameId);
    if (existing?.archivedAt) return;
    let mtimeMs: number | null = null;
    let parsed: ParsedTranscript | null = null;
    let updatedAt = this.now().toISOString();
    try {
      const metadata = await stat(path);
      mtimeMs = metadata.mtimeMs;
      if (this.lastMtimeMs.get(filenameId) === mtimeMs) return;
      updatedAt = metadata.mtime.toISOString();
      parsed = parseTranscript(await readFile(path, "utf8"), filenameId, updatedAt);
      updatedAt = parsed.updatedAt;
    } catch {
      // Fail closed: retain the listing but never project a partially parsed transcript.
    }

    const session = this.options.database.upsertDiscoveredSession({
      id: crypto.randomUUID(), ownerId: this.options.ownerId, adapter: "gjc", remoteId: filenameId,
      controlMode: "view-only", origin: "ondisk-discovery",
      transcriptStatus: parsed ? "available" : "unreadable", updatedAt,
      ...(parsed ? { title: parsed.title, workdir: parsed.workdir, sourceCreatedAt: parsed.sourceCreatedAt } : {}),
    });
    if (!parsed) {
      if (mtimeMs !== null) this.lastMtimeMs.set(filenameId, mtimeMs);
      return;
    }

    const claimedAt = this.now();
    if (!this.options.database.claimView({
      sessionId: session.id,
      owner: this.viewOwner,
      claimedAt: claimedAt.toISOString(),
      staleBefore: new Date(claimedAt.getTime() - VIEW_LEASE_MS).toISOString(),
    })) return;
    try {
      this.options.database.projectRemoteBatch({
        mode: "view", sessionId: session.id, adapter: "gjc", source: "gjc-ondisk",
        cursorScope: "transcript", owner: this.viewOwner,
        cursor: String(parsed.events.length + 1), events: parsed.events,
      });
      if (!session.activeProjectorVersion || session.activeProjectorVersion === "legacy") {
        this.options.database.applyProjection({
          sessionId: session.id,
          ownerId: this.options.ownerId,
          projectorVersion: GJC_PROJECTOR_VERSION,
          effectKey: "gjc-ondisk-work-fold",
          apply: (event) => {
            const item = workItemForEvent(session.id, event);
            if (!item) return;
            this.options.database.upsertWorkItem({
              ...item,
              ownerId: this.options.ownerId,
              sessionId: session.id,
              projectorVersion: GJC_PROJECTOR_VERSION,
            });
          },
        });
        if (this.options.database.listProjectionFailures(session.id, GJC_PROJECTOR_VERSION).length > 0) {
          throw new Error("GJC transcript projection fold failed");
        }
        const workItems = new Map<string, { id: string; remoteId: string; state: string; payload: unknown }>();
        for (const event of parsed.events) {
          const item = workItemForEvent(session.id, event);
          if (item) workItems.set(item.remoteId, item);
        }
        if (!this.options.database.cutoverProjectorVersion({
          sessionId: session.id,
          ownerId: this.options.ownerId,
          projectorVersion: GJC_PROJECTOR_VERSION,
          expectedCurrentVersion: session.activeProjectorVersion ?? null,
          expectedReconciliationEpoch: session.reconciliationEpoch,
          workItems: [...workItems.values()],
        })) return;
      }
      if (mtimeMs !== null) this.lastMtimeMs.set(filenameId, mtimeMs);
    } catch {
      this.options.database.upsertDiscoveredSession({
        id: crypto.randomUUID(), ownerId: this.options.ownerId, adapter: "gjc", remoteId: filenameId,
        controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "unreadable", updatedAt,
      });
    }
  }
}
