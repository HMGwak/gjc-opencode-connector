import { PendingActionError, PendingActionService as CorePendingActionService, type CoreDatabase, type PendingAction as CorePendingAction } from "@planee/core";

export type PendingActionStatus = "pending" | "dispatching" | "answered" | "cancelled" | "expired" | "unknown";

export interface PendingAction {
  readonly id: string;
  readonly ownerId: string;
  readonly sessionId?: string;
  readonly version: number;
  readonly expiresAt: string;
  readonly status: PendingActionStatus;
  readonly type: string;
  readonly payload: unknown;
  /** Exact canonical response choices; empty means no response controls are available. */
  readonly allowedResponses: readonly AllowedResponse[];
  /** Canonical opaque artifact identifiers; never derive paths from these values. */
  readonly artifactIds: readonly string[];
}

export interface ActionResponse {
  readonly action: PendingAction;
  readonly duplicate: boolean;
}

export type AllowedResponse = string | { readonly value: string; readonly label?: string };
export const hubPendingActionService = Symbol("HubPendingActionService");

export interface HubPendingActionPayload {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly artifactIds: readonly string[];
}
const allowedResponses = (payload: unknown): readonly AllowedResponse[] => {
  if (typeof payload !== "object" || payload === null || !("allowedResponses" in payload)) return [];
  const choices = (payload as { allowedResponses?: unknown }).allowedResponses;
  if (!Array.isArray(choices) || !choices.every((choice) => typeof choice === "string" || (typeof choice === "object" && choice !== null && typeof (choice as { value?: unknown }).value === "string" && (!("label" in choice) || typeof (choice as { label?: unknown }).label === "string")))) return [];
  return choices as readonly AllowedResponse[];
};

const allowedResponseValues = (payload: unknown): readonly string[] => allowedResponses(payload).map((choice) => typeof choice === "string" ? choice : choice.value);

const toAction = (action: CorePendingAction<HubPendingActionPayload>): PendingAction => ({
  id: action.id,
  ownerId: action.ownerId,
  sessionId: action.sessionId ?? undefined,
  version: action.version,
  expiresAt: action.expiresAt,
  status: action.state,
  type: action.payload.type,
  payload: action.payload.payload,
  allowedResponses: allowedResponses(action.payload.payload),
  artifactIds: action.payload.artifactIds,
});

/** Hub's durable action adapter. It owns authorization, state transition, audit, and event commit. */
export class HubPendingActionService {
  readonly [hubPendingActionService] = true;

  constructor(private readonly database: CoreDatabase, private readonly actions = new CorePendingActionService(database)) {}

  list(ownerId: string): readonly PendingAction[] {
    return this.database.listPendingActionsForOwner<HubPendingActionPayload>(ownerId).map(toAction);
  }

  respondWithEvent(input: { readonly id: string; readonly ownerId: string; readonly version: number; readonly response: unknown; readonly idempotencyKey: string }): ActionResponse {
    const existing = this.database.getPendingActionForOwner<HubPendingActionPayload>(input.id, input.ownerId);
    if (!existing) throw new ActionApiError("forbidden");
    const allowed = allowedResponseValues(existing.payload.payload);
    if (allowed.length === 0 || typeof input.response !== "string" || !allowed.includes(input.response)) throw new ActionApiError("invalid");
    try {
      const action = this.actions.respondWithEvent<HubPendingActionPayload, string>({
        id: input.id,
        version: input.version,
        answer: input.response,
        sessionId: existing.payload.sessionId,
        eventType: "action.responded",
        eventPayload: { actionId: input.id, version: input.version + 1, ownerId: input.ownerId },
      });
      return { action: toAction(action), duplicate: existing.state === "answered" };
    } catch (cause) {
      if (!(cause instanceof PendingActionError)) throw cause;
      const code = cause.code === "not-found" ? "unknown" : cause.code === "conflict" || cause.code === "cancelled" || cause.code === "unknown" ? "stale" : cause.code;
      throw new ActionApiError(code, cause.message);
    }
  }
}

export interface ArtifactMetadata {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly createdAt: string;
}

export interface ArtifactContent {
  readonly artifact: ArtifactMetadata;
  readonly content: BodyInit;
  readonly range?: { readonly start: number; readonly end: number };
}

export interface ArtifactService {
  getMetadata(id: string, ownerId: string): Promise<ArtifactMetadata> | ArtifactMetadata;
  getContent(id: string, ownerId: string, range?: { readonly start: number; readonly end: number }): Promise<ArtifactContent> | ArtifactContent;
}

/** Expected failures that may safely be exposed as HTTP status classes. */
export class ActionApiError extends Error {
  constructor(readonly code: "unknown" | "expired" | "stale" | "forbidden" | "invalid" | "traversal" | "range", message?: string) {
    super(message ?? code);
  }
}
