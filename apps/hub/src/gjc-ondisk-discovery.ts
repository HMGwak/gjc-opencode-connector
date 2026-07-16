import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_FILE = /^(\d{4}-\d{2}-\d{2}T[^_]+)_([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i;
const VIEW_LEASE_MS = 45_000;

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
  }): { readonly id: string };
  claimView(input: { readonly sessionId: string; readonly owner: string; readonly claimedAt: string; readonly staleBefore: string }): boolean;
  projectRemoteBatch(input: {
    readonly mode: "view";
    readonly sessionId: string;
    readonly adapter: "gjc";
    readonly source: "gjc-ondisk";
    readonly cursorScope: "transcript";
    readonly owner: string;
    readonly cursor: string;
    readonly events: readonly RemoteProjectionEvent[];
  }): unknown;
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
};

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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

  const events: RemoteProjectionEvent[] = [];
  for (let index = 1; index < parsed.length; index++) {
    const entry = record(parsed[index]);
    if (!entry || typeof entry.type !== "string" || typeof entry.id !== "string" || typeof entry.timestamp !== "string") {
      throw new Error(`Unrecognized GJC transcript entry at line ${index + 1}`);
    }
    events.push({
      sourceEventId: entry.id,
      sourceRevision: String(version),
      sourcePosition: index + 1,
      contentHash: sha256(lines[index]!),
      type: `gjc.${entry.type}`,
      payload: entry,
      createdAt: entry.timestamp,
    });
  }
  const lastTimestamp = events.at(-1)?.createdAt;
  return { remoteId: filenameId, updatedAt: lastTimestamp ?? fallbackUpdatedAt, sourceRevision: String(version), events };
}

export class GjcOnDiskDiscovery {
  private readonly root: string;
  private readonly viewOwner: string;
  private readonly now: () => Date;

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
    let parsed: ParsedTranscript | null = null;
    let updatedAt = this.now().toISOString();
    try {
      const metadata = await stat(path);
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
    });
    if (!parsed) return;

    const claimedAt = this.now();
    if (!this.options.database.claimView({
      sessionId: session.id,
      owner: this.viewOwner,
      claimedAt: claimedAt.toISOString(),
      staleBefore: new Date(claimedAt.getTime() - VIEW_LEASE_MS).toISOString(),
    })) return;
    this.options.database.projectRemoteBatch({
      mode: "view", sessionId: session.id, adapter: "gjc", source: "gjc-ondisk",
      cursorScope: "transcript", owner: this.viewOwner,
      cursor: String(parsed.events.length + 1), events: parsed.events,
    });
  }
}
