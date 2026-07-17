import type { Session, SessionHierarchyEvidence } from "@planee/core";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_FILE = /^(\d{4}-\d{2}-\d{2}T[^_]+)_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i;
const SESSION_DIRECTORY = /_([0-9a-f]{8}-[0-9a-f-]{27,})$/i;
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
  upsertSessionHierarchyEvidence(evidence: SessionHierarchyEvidence): void;
  listSessionHierarchyEvidence(ownerId: string): SessionHierarchyEvidence[];
  beginHierarchyBackfillCycle(ownerId: string, input: { readonly epoch: number; readonly requiredAdapters: readonly string[] }): { readonly ownerId: string; readonly epoch: number; readonly cycle: number; readonly requiredAdapters: readonly string[]; readonly frozenAt: string | null };
  upsertHierarchyBackfillRun(input: { readonly ownerId: string; readonly adapter: string; readonly epoch: number; readonly cycle: number; readonly state: "enumerating" | "reconciling" | "complete"; readonly expectedSourceKeys: number; readonly observedSourceKeys: number; readonly frozenAt: string | null }): void;
  addHierarchyBackfillManifestEntry(ownerId: string, adapter: string, epoch: number, cycle: number, sourceKey: string): void;
  freezeHierarchyBackfillSnapshot(ownerId: string, epoch: number, cycle: number): void;
  hierarchyCoverageGapCount(ownerId: string, epoch: number, cycle: number): number;
  getHierarchyGeneration(ownerId: string): { readonly activeGeneration: number; readonly evidenceRevision: number; readonly evidenceSchemaEpoch: number } | null;
  classifyAndProjectSessionHierarchy(ownerId: string, generation: number, backfill: { readonly epoch: number; readonly cycle: number }): void;
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
  readonly hasUserTitleSource: boolean;
  readonly hasSubagentOrigin: boolean;
};
type HierarchyTranscript = {
  readonly path: string;
  readonly filenameId: string;
  readonly nested: boolean;
  readonly parentRemoteId: string | null;
  readonly remoteId: string;
  readonly observationState: SessionHierarchyEvidence["observationState"];
  readonly hasUserTitleSource: boolean;
  readonly hasSubagentOrigin: boolean;
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

function parseTranscript(text: string, filenameId: string, fallbackUpdatedAt: string, requireFilenameId = true): ParsedTranscript {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error("Empty GJC transcript");

  const parsed = lines.map((line) => JSON.parse(line) as unknown);
  const header = record(parsed[0]);
  if (!header || header.type !== "session" || typeof header.id !== "string" || (requireFilenameId && header.id !== filenameId)) {
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
  const hasSubagentOrigin = parsed.some((entry) => {
    const value = record(entry);
    return (value?.type === "configured_model_chain" || value?.type === "configured-model-chain") && value.origin === "subagent";
  });
  return {
    remoteId: requireFilenameId ? filenameId : header.id,
    updatedAt: lastTimestamp ?? fallbackUpdatedAt,
    sourceRevision: String(version),
    events,
    title: sessionTitle(header, header.cwd, header.id),
    workdir: header.cwd,
    sourceCreatedAt: sourceCreatedAt.toISOString(),
    hasUserTitleSource: header.titleSource === "user",
    hasSubagentOrigin,
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
    const walk = async (directory: string, nested: boolean): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path, true);
          continue;
        }
        const match = entry.isFile() ? SESSION_FILE.exec(entry.name) : null;
        if (!match) continue;
        await this.discoverFile(path, match[2]!, nested);
        discovered++;
      }
    };
    for (const cwdDirectory of cwdDirectories) {
      if (cwdDirectory.isDirectory()) await walk(join(this.root, cwdDirectory.name), false);
    }
    return discovered;
  }
  /**
   * Captures a fresh hierarchy observation for every transcript independently of
   * the projection mtime cache. Backfill orchestration owns the epoch/cycle and
   * calls this only while its manifest is still mutable.
   */
  async captureHierarchyEvidence(capturedEpoch: number): Promise<readonly string[]> {
    const transcripts: Array<Omit<HierarchyTranscript, "remoteId" | "observationState" | "hasUserTitleSource" | "hasSubagentOrigin">> = [];
    const walk = async (directory: string, relative: readonly string[]): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path, [...relative, entry.name]);
          continue;
        }
        const match = entry.isFile() ? SESSION_FILE.exec(entry.name) : null;
        if (!match) continue;
        const parentDirectory = relative.find((name) => SESSION_DIRECTORY.exec(name));
        transcripts.push({
          path,
          filenameId: match[2]!,
          nested: relative.length > 0,
          parentRemoteId: parentDirectory ? SESSION_DIRECTORY.exec(parentDirectory)?.[1] ?? null : null,
        });
      }
    };
    let directories;
    try { directories = await readdir(this.root, { withFileTypes: true }); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    for (const directory of directories) if (directory.isDirectory()) await walk(join(this.root, directory.name), []);

    const materialized: HierarchyTranscript[] = [];
    const internalIdsByRemoteId = new Map<string, string>();
    for (const transcript of transcripts) {
      let remoteId = transcript.filenameId;
      let observationState: SessionHierarchyEvidence["observationState"] = transcript.nested && transcript.parentRemoteId === null ? "missing-parent" : "valid";
      let hasUserTitleSource = false;
      let hasSubagentOrigin = false;
      try {
        const parsed = parseTranscript(await readFile(transcript.path, "utf8"), transcript.filenameId, this.now().toISOString(), !transcript.nested);
        remoteId = parsed.remoteId;
        hasUserTitleSource = parsed.hasUserTitleSource;
        hasSubagentOrigin = parsed.hasSubagentOrigin;
      } catch {
        observationState = "unreadable";
      }
      await this.discoverFile(transcript.path, transcript.filenameId, transcript.nested);
      const session = this.options.database.getSessionByRemoteIdForOwner(this.options.ownerId, "gjc", remoteId);
      if (!session) throw new Error(`GJC hierarchy transcript was not materialized: ${transcript.path}`);
      internalIdsByRemoteId.set(transcript.filenameId, session.id);
      internalIdsByRemoteId.set(remoteId, session.id);
      materialized.push({ ...transcript, remoteId, observationState, hasUserTitleSource, hasSubagentOrigin });
    }

    const sourceKeys: string[] = [];
    const seenRemoteIds = new Set<string>();
    for (const transcript of materialized) {
      let observationState = transcript.observationState;
      if (observationState === "valid" && seenRemoteIds.has(transcript.remoteId)) observationState = "conflict";
      seenRemoteIds.add(transcript.remoteId);
      const parentSessionId = transcript.parentRemoteId === null ? null : internalIdsByRemoteId.get(transcript.parentRemoteId) ?? null;
      if (observationState === "valid" && transcript.parentRemoteId !== null && parentSessionId === null) observationState = "missing-parent";
      const sessionId = internalIdsByRemoteId.get(transcript.remoteId);
      if (!sessionId) throw new Error(`GJC hierarchy session ID was not resolved: ${transcript.path}`);
      this.options.database.upsertSessionHierarchyEvidence({
        ownerId: this.options.ownerId,
        adapter: "gjc",
        sourceKey: transcript.path,
        sessionId,
        identityNamespace: "gjc-transcript",
        observedParentSessionId: parentSessionId,
        observedParentOwnerId: parentSessionId === null ? null : this.options.ownerId,
        directHumanEvidence: !transcript.nested && transcript.hasUserTitleSource && !transcript.hasSubagentOrigin,
        structuralKind: transcript.nested || transcript.hasSubagentOrigin ? "subagent" : "direct",
        observationState,
        capturedEpoch,
        deletedAt: null,
      });
      sourceKeys.push(transcript.path);
    }
    return sourceKeys.sort();
  }
  /**
   * Executes one immutable GJC enumeration cycle. Callers supply the canonical
   * enabled-adapter snapshot; this discovery source can only complete its own
   * `gjc` run and refuses to manufacture completeness for another adapter.
   */
  async synchronizeHierarchy(requiredAdapters: readonly string[] = ["gjc"]): Promise<{ readonly epoch: number; readonly cycle: number; readonly projected: boolean }> {
    const adapters = [...new Set(requiredAdapters)].sort();
    if (adapters.length !== 1 || adapters[0] !== "gjc") throw new Error("GJC discovery cannot enumerate a non-GJC hierarchy adapter");
    const current = this.options.database.getHierarchyGeneration(this.options.ownerId);
    const epoch = (current?.evidenceSchemaEpoch ?? 0) + 1;
    const cycle = this.options.database.beginHierarchyBackfillCycle(this.options.ownerId, { epoch, requiredAdapters: adapters });
    this.options.database.upsertHierarchyBackfillRun({
      ownerId: this.options.ownerId, adapter: "gjc", epoch, cycle: cycle.cycle,
      state: "enumerating", expectedSourceKeys: 0, observedSourceKeys: 0, frozenAt: null,
    });
    const sourceKeys = await this.captureHierarchyEvidence(epoch);
    for (const sourceKey of sourceKeys) this.options.database.addHierarchyBackfillManifestEntry(this.options.ownerId, "gjc", epoch, cycle.cycle, sourceKey);
    this.options.database.upsertHierarchyBackfillRun({
      ownerId: this.options.ownerId, adapter: "gjc", epoch, cycle: cycle.cycle,
      state: "complete", expectedSourceKeys: sourceKeys.length, observedSourceKeys: sourceKeys.length, frozenAt: this.now().toISOString(),
    });
    this.options.database.freezeHierarchyBackfillSnapshot(this.options.ownerId, epoch, cycle.cycle);
    if (this.options.database.hierarchyCoverageGapCount(this.options.ownerId, epoch, cycle.cycle) !== 0) return { epoch, cycle: cycle.cycle, projected: false };
    this.options.database.classifyAndProjectSessionHierarchy(this.options.ownerId, (current?.activeGeneration ?? 0) + 1, { epoch, cycle: cycle.cycle });
    return { epoch, cycle: cycle.cycle, projected: true };
  }

  private async discoverFile(path: string, filenameId: string, nested = false): Promise<void> {
    if (!nested) {
      const existing = this.options.database.getSessionByRemoteIdForOwner(this.options.ownerId, "gjc", filenameId);
      if (existing?.archivedAt) return;
    }
    let mtimeMs: number | null = null;
    let parsed: ParsedTranscript | null = null;
    let updatedAt = this.now().toISOString();
    try {
      const metadata = await stat(path);
      mtimeMs = metadata.mtimeMs;
      if (this.lastMtimeMs.get(path) === mtimeMs) return;
      updatedAt = metadata.mtime.toISOString();
      parsed = parseTranscript(await readFile(path, "utf8"), filenameId, updatedAt, !nested);
      updatedAt = parsed.updatedAt;
    } catch {
      // Fail closed: retain the listing but never project a partially parsed transcript.
    }

    const session = this.options.database.upsertDiscoveredSession({
      id: crypto.randomUUID(), ownerId: this.options.ownerId, adapter: "gjc", remoteId: parsed?.remoteId ?? filenameId,
      controlMode: "view-only", origin: "ondisk-discovery",
      transcriptStatus: parsed ? "available" : "unreadable", updatedAt,
      ...(parsed ? { title: parsed.title, workdir: parsed.workdir, sourceCreatedAt: parsed.sourceCreatedAt } : {}),
    });
    if (!parsed) {
      if (mtimeMs !== null) this.lastMtimeMs.set(path, mtimeMs);
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
      if (mtimeMs !== null) this.lastMtimeMs.set(path, mtimeMs);
    } catch {
      this.options.database.upsertDiscoveredSession({
        id: crypto.randomUUID(), ownerId: this.options.ownerId, adapter: "gjc", remoteId: parsed?.remoteId ?? filenameId,
        controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "unreadable", updatedAt,
      });
    }
  }
}
