export type CoordinatorSession = {
  readonly remoteId: string;
};

export type McpToolCaller = {
  callTool(name: string, arguments_: Record<string, never>): Promise<unknown>;
  close(): void;
};

export type GjcMcpClientOptions = {
  readonly executable?: string;
  readonly workdirRoots: string;
  readonly spawn?: (command: string[], environment: Record<string, string | undefined>) => McpToolCaller;
};

const PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 10_000;

class JsonRpcStdioClient implements McpToolCaller {
  private readonly process: ReturnType<typeof Bun.spawn>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private closed = false;

  constructor(command: string[], environment: Record<string, string | undefined>) {
    this.process = Bun.spawn({ cmd: command, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: environment });
    void this.readResponses();
  }
  private async readResponses(): Promise<void> {
    const stdout = this.process.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const message of lines) {
          if (!message.trim()) continue;
          let response: { id?: number; result?: unknown; error?: { message?: string } };
          try { response = JSON.parse(message) as typeof response; } catch { continue; }
          if (typeof response.id !== "number") continue;
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id);
          clearTimeout(pending.timer);
          if (response.error) pending.reject(new Error("Coordinator MCP request failed")); else pending.resolve(response.result);
        }
      }
    } catch {
      // Individual requests are rejected below when the process exits or times out.
    } finally {
      reader.releaseLock();
    }
  }

  private send(message: string): boolean {
    const stdin = this.process.stdin;
    if (!stdin || typeof stdin === "number") return false;
    try {
      stdin.write(message);
      return true;
    } catch {
      return false;
    }
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Coordinator MCP client is closed"));
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Coordinator MCP request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send(message)) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Coordinator MCP transport unavailable"));
      }
    });
  }

  async callTool(name: string, arguments_: Record<string, never>): Promise<unknown> {
    await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "planee-agent-hub", version: "1" } });
    this.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return this.request("tools/call", { name, arguments: arguments_ });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.process.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Coordinator MCP client closed"));
    }
    this.pending.clear();
  }
}

const defaultSpawn = (command: string[], environment: Record<string, string | undefined>): McpToolCaller => new JsonRpcStdioClient(command, environment);

function sessionIds(value: unknown): string[] {
  const result = new Set<string>();
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const id = record.session_id ?? record.sessionId;
    if (typeof id === "string" && id.length > 0) result.add(id);
    for (const child of Object.values(record)) visit(child);
  };
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    for (const content of (value as { content: Array<{ type?: unknown; text?: unknown }> }).content) {
      if (content.type !== "text" || typeof content.text !== "string") continue;
      try { visit(JSON.parse(content.text)); } catch { /* Tool text that is not JSON is not a session list. */ }
    }
  } else visit(value);
  return [...result];
}

export class GjcCoordinatorClient {
  constructor(private readonly options: GjcMcpClientOptions) {}

  async listSessions(): Promise<CoordinatorSession[]> {
    const spawn = this.options.spawn ?? defaultSpawn;
    const transport = spawn([this.options.executable ?? "gjc", "mcp-serve", "coordinator"], { ...process.env, GJC_COORDINATOR_MCP_WORKDIR_ROOTS: this.options.workdirRoots });
    try {
      return sessionIds(await transport.callTool("gjc_coordinator_list_sessions", {})).map((remoteId) => ({ remoteId }));
    } finally {
      transport.close();
    }
  }
}

export type SessionDatabase = {
  listSessionsForOwner(ownerId: string): Array<{ id: string; adapter: string; remoteId: string }>;
  createSession(input: { id: string; ownerId: string; adapter: string; remoteId: string }): unknown;
};

export class GjcSessionSynchronizer {
  constructor(private readonly database: SessionDatabase, private readonly ownerId: string, private readonly client: Pick<GjcCoordinatorClient, "listSessions">, private readonly id: () => string = () => crypto.randomUUID()) {}

  async synchronize(): Promise<number> {
    const existing = new Set(this.database.listSessionsForOwner(this.ownerId).filter((session) => session.adapter === "gjc").map((session) => session.remoteId));
    let created = 0;
    for (const session of await this.client.listSessions()) {
      if (existing.has(session.remoteId)) continue;
      try {
        this.database.createSession({ id: this.id(), ownerId: this.ownerId, adapter: "gjc", remoteId: session.remoteId });
        created++;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed: sessions.adapter, sessions.remote_id")) throw error;
      }
      existing.add(session.remoteId);
    }
    return created;
  }
}
