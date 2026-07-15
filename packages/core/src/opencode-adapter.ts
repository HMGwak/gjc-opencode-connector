import type { AgentAdapter, ReconciliationSnapshot, Session } from "./types";

export interface OpenCodeSession { readonly id: string; readonly title: string | null; readonly updatedAt: string | null; }
export interface OpenCodeMessage { readonly id: string; readonly role: string; readonly parts: readonly unknown[]; }
export type OpenCodeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface OpenCodeAdapterOptions { readonly baseUrl: string; readonly password?: string; readonly fetch?: OpenCodeFetch; readonly timeoutMs?: number; }
export interface OpenCodeSubscription { close(): void; }

const capabilities = { stableRemoteId: true, revision: true, terminalState: false, tombstone: false, watermark: false, fencing: false } as const;
const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const scalar = (value: unknown): string | null => typeof value === "string" || typeof value === "number" ? String(value) : null;

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode";
  readonly reconciliationCapabilities = capabilities;
  private readonly baseUrl: string;
  private readonly fetcher: OpenCodeFetch;
  private readonly timeoutMs: number;
  private readonly password?: string;

  constructor(options: OpenCodeAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ""); this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000; this.password = options.password;
  }

  async listSessions(): Promise<readonly OpenCodeSession[]> {
    const value = await this.request("/session");
    return asArray(value).map((item) => { const row = asRecord(item); const id = text(row.id); if (!id) throw new Error("OpenCode returned a session without an id"); return { id, title: text(row.title), updatedAt: scalar(row.time && asRecord(row.time).updated) ?? scalar(row.updatedAt) }; });
  }

  async sessionStatus(): Promise<Readonly<Record<string, unknown>>> { return asRecord(await this.request("/session/status")); }
  async messages(sessionId: string): Promise<readonly OpenCodeMessage[]> {
    const value = await this.request(`/session/${encodeURIComponent(sessionId)}/message`);
    return asArray(value).map((item) => { const row = asRecord(item); const id = text(row.id); const role = text(row.role); if (!id || !role) throw new Error("OpenCode returned an invalid message"); return { id, role, parts: asArray(row.parts) }; });
  }
  async prompt(sessionId: string, prompt: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }) }, 204);
  }
  async respondPermission(sessionId: string, permissionId: string, response: string, remember?: boolean): Promise<boolean> {
    const value = await this.request(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, { method: "POST", body: JSON.stringify({ response, ...(remember === undefined ? {} : { remember }) }) });
    if (typeof value !== "boolean") throw new Error("OpenCode returned an invalid permission response"); return value;
  }
  async abort(sessionId: string): Promise<void> { await this.request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, 200); }
  async reconcile(_session: Session, _epoch: number): Promise<ReconciliationSnapshot | null> {
    // OpenCode cannot prove terminality, deletion, cursor progress, or fencing.
    // A partial status response is therefore not reconciliation evidence.
    return null;
  }
  subscribe(onEvent: (event: unknown) => void, onReconnect: () => Promise<void> | void): OpenCodeSubscription {
    let closed = false; let controller: AbortController | undefined;
    const connect = async (): Promise<void> => {
      while (!closed) {
        controller = new AbortController();
        try {
          const response = await this.fetcher(new URL("/event", this.baseUrl), { headers: this.headers(), signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`OpenCode event stream returned ${response.status}`);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader(); let pending = "";
          for (;;) { const next = await reader.read(); if (next.done) break; pending += next.value; const frames = pending.split("\n\n"); pending = frames.pop() ?? ""; for (const frame of frames) { const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"); if (data) { let event: unknown; try { event = JSON.parse(data); } catch { continue; } onEvent(event); } } }
        } catch { if (closed) return; }
        if (!closed) await onReconnect();
      }
    };
    void connect(); return { close: () => { closed = true; controller?.abort(); } };
  }
  private headers(): Headers { const headers = new Headers({ accept: "application/json" }); if (this.password) headers.set("authorization", `Basic ${btoa(`opencode:${this.password}`)}`); return headers; }
  private async request(path: string, init: RequestInit = {}, expected = 200): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try { const headers = this.headers(); if (init.body) headers.set("content-type", "application/json"); const response = await this.fetcher(new URL(path, this.baseUrl), { ...init, headers, signal: controller.signal }); if (response.status !== expected) throw new Error(`OpenCode ${init.method ?? "GET"} ${path} returned ${response.status}, expected ${expected}`); return expected === 204 ? undefined : await response.json(); }
    finally { clearTimeout(timer); }
  }
}
