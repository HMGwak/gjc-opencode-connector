import { isAbsolute, relative, resolve } from "node:path";
import type { AgentAdapter, ReconciliationSnapshot, Session } from "./types";

export interface GjcCoordinatorMcpClient {
  watchEvents(input: GjcWatchEventsRequest): AsyncIterable<unknown>;
  readTurn(input: GjcReadTurnRequest): Promise<unknown>;
  listQuestions(input: GjcListQuestionsRequest): Promise<unknown>;
  stopSession(input: GjcStopSessionRequest): Promise<unknown>;
}

export interface GjcWatchEventsRequest { readonly session_id: string; }
export interface GjcReadTurnRequest { readonly session_id: string; readonly turn_id: string; }
export interface GjcListQuestionsRequest { readonly session_id: string; readonly status: "pending"; }
export interface GjcStopSessionRequest { readonly session_id: string; readonly owner_proof: string; readonly force: boolean; readonly allow_mutation: true; }
export interface GjcAdapterOptions {
  readonly client: GjcCoordinatorMcpClient;
  readonly workdir: string;
  readonly workdirRoots: readonly string[];
  /** Both this startup opt-in and a per-call opt-in are required for mutations. */
  readonly mutationEnabled?: boolean;
}
export interface GjcTurn { readonly sessionId: string; readonly turnId: string; readonly status: string; readonly updatedAt: string | null; }
export interface GjcQuestion { readonly id: string; readonly sessionId: string; readonly status: string; readonly payload: unknown; }
export interface GjcEvent { readonly sessionId: string; readonly type: string; readonly turnId: string | null; readonly payload: unknown; }
export interface GjcPollResult { readonly turn: GjcTurn; readonly questions: readonly GjcQuestion[]; }
export interface GjcSubscription { close(): void; }

const capabilities = { stableRemoteId: true, revision: true, terminalState: true, tombstone: false, watermark: false, fencing: false } as const;
const terminalStatuses = new Set(["completed", "failed", "cancelled", "superseded", "stopped"]);
const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const asArray = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const field = (row: Record<string, unknown>, snake: string, camel: string): unknown => row[snake] ?? row[camel];

export class GjcAmbiguousMutationError extends Error {
  readonly state = "unknown";
  constructor(operation: string, cause?: unknown) { super(`${operation} outcome is unknown; do not retry automatically`, { cause }); this.name = "GjcAmbiguousMutationError"; }
}

/** Coordinator MCP-only adapter. Notifications and watch events are acceleration hints, never state authority. */
export class GjcAdapter implements AgentAdapter {
  readonly name = "gjc";
  readonly reconciliationCapabilities = capabilities;
  private readonly client: GjcCoordinatorMcpClient;
  private readonly mutationEnabled: boolean;

  constructor(options: GjcAdapterOptions) {
    if (!isAllowedWorkdir(options.workdir, options.workdirRoots)) throw new Error("GJC Coordinator workdir is outside configured roots");
    this.client = options.client;
    this.mutationEnabled = options.mutationEnabled === true;
  }

  async poll(sessionId: string, turnId: string): Promise<GjcPollResult> {
    const [turnValue, questionsValue] = await Promise.all([
      this.client.readTurn({ session_id: sessionId, turn_id: turnId }),
      this.client.listQuestions({ session_id: sessionId, status: "pending" }),
    ]);
    return { turn: normalizeTurn(turnValue, sessionId, turnId), questions: normalizeQuestions(questionsValue, sessionId) };
  }

  async reconcile(session: Session, _epoch: number): Promise<ReconciliationSnapshot | null> {
    const turn = normalizeTurn(await this.client.readTurn({ session_id: session.remoteId, turn_id: session.remoteId }), session.remoteId, session.remoteId);
    if (!turn.updatedAt || !terminalStatuses.has(turn.status) && turn.status !== "active" && turn.status !== "running") return null;
    return { remoteId: turn.sessionId, revision: turn.updatedAt, terminal: terminalStatuses.has(turn.status), tombstone: false, watermark: turn.updatedAt };
  }

  /** Watch transport only wakes the consumer; reconnect always polls authoritative Coordinator snapshots. */
  subscribe(sessionId: string, turnId: string, onHint: (event: GjcEvent) => void, onReconnect: (snapshot: GjcPollResult) => Promise<void> | void): GjcSubscription {
    let closed = false;
    const connect = async (): Promise<void> => {
      while (!closed) {
        try {
          for await (const raw of this.client.watchEvents({ session_id: sessionId })) {
            if (closed) return;
            const event = normalizeEvent(raw, sessionId);
            if (event) onHint(event);
          }
        } catch { /* A watch disconnect is expected; polling below remains authoritative. */ }
        if (!closed) await onReconnect(await this.poll(sessionId, turnId));
      }
    };
    void connect();
    return { close: () => { closed = true; } };
  }

  async stopSession(sessionId: string, ownerProof: string, force = false, allowMutation = false): Promise<void> {
    if (!this.mutationEnabled || !allowMutation) throw new Error("GJC mutation is not enabled");
    if (!ownerProof) throw new Error("GJC stop requires owner proof");
    try {
      const result = asRecord(await this.client.stopSession({ session_id: sessionId, owner_proof: ownerProof, force, allow_mutation: true }));
      if (result.stopped !== true && result.status !== "stopped") throw new GjcAmbiguousMutationError("GJC stop_session");
    } catch (error) {
      if (error instanceof GjcAmbiguousMutationError) throw error;
      throw new GjcAmbiguousMutationError("GJC stop_session", error);
    }
  }
}

export const isAllowedWorkdir = (workdir: string, roots: readonly string[]): boolean => {
  if (!isAbsolute(workdir) || roots.length === 0) return false;
  const candidate = resolve(workdir);
  return roots.some((root) => { if (!isAbsolute(root)) return false; const difference = relative(resolve(root), candidate); return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference)); });
};
export const normalizeTurn = (value: unknown, sessionId: string, turnId: string): GjcTurn => {
  const row = asRecord(value); const nested = asRecord(row.turn); const source = Object.keys(nested).length ? nested : row;
  const status = string(source.status) ?? "unknown";
  return { sessionId: string(field(source, "session_id", "sessionId")) ?? sessionId, turnId: string(field(source, "turn_id", "turnId")) ?? turnId, status, updatedAt: string(field(source, "updated_at", "updatedAt")) };
};
export const normalizeQuestions = (value: unknown, sessionId: string): readonly GjcQuestion[] => asArray(asRecord(value).questions ?? value).flatMap((item) => {
  const row = asRecord(item); const id = string(row.id) ?? string(row.question_id); if (!id) return [];
  return [{ id, sessionId: string(field(row, "session_id", "sessionId")) ?? sessionId, status: string(row.status) ?? "unknown", payload: row.payload ?? row }];
});
export const normalizeEvent = (value: unknown, sessionId: string): GjcEvent | null => {
  const row = asRecord(value); const type = string(row.type) ?? string(row.event_type); if (!type) return null;
  return { sessionId: string(field(row, "session_id", "sessionId")) ?? sessionId, type, turnId: string(field(row, "turn_id", "turnId")), payload: row.payload ?? row };
};
