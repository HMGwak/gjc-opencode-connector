import { PendingActionError, PendingActionService as CorePendingActionService, type CoreDatabase, type PendingAction as CorePendingAction } from "@planee/core";

export type PendingActionStatus = "pending" | "answered" | "cancelled" | "expired" | "unknown";

export interface PendingAction {
  readonly id: string;
  readonly ownerId: string;
  readonly sessionId?: string;
  readonly version: number;
  readonly expiresAt: string;
  readonly status: PendingActionStatus;
  readonly type: string;
  readonly payload: unknown;
  /** Canonical opaque artifact identifiers; never derive paths from these values. */
  readonly artifactIds: readonly string[];
}

export interface ActionResponse {
  readonly action: PendingAction;
  readonly duplicate: boolean;
}

export const hubPendingActionService = Symbol("HubPendingActionService");

export interface HubPendingActionPayload {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly artifactIds: readonly string[];
}

const toAction = (action: CorePendingAction<HubPendingActionPayload>): PendingAction => ({
  id: action.id,
  ownerId: action.payload.ownerId,
  sessionId: action.payload.sessionId,
  version: action.version,
  expiresAt: action.expiresAt,
  status: action.state,
  type: action.payload.type,
  payload: action.payload.payload,
  artifactIds: action.payload.artifactIds,
});

/** Hub's durable action adapter. It owns authorization, state transition, audit, and event commit. */
export class HubPendingActionService {
  readonly [hubPendingActionService] = true;

  constructor(private readonly database: CoreDatabase, private readonly actions = new CorePendingActionService(database)) {}

  list(ownerId: string): readonly PendingAction[] {
    return this.database.listPendingActions<HubPendingActionPayload>()
      .filter((action) => action.payload.ownerId === ownerId)
      .map(toAction);
  }

  respondWithEvent(input: { readonly id: string; readonly ownerId: string; readonly version: number; readonly response: unknown; readonly idempotencyKey: string }): ActionResponse {
    const existing = this.actions.get<HubPendingActionPayload>(input.id);
    if (!existing) throw new ActionApiError("unknown");
    if (existing.payload.ownerId !== input.ownerId) throw new ActionApiError("forbidden");
    try {
      const action = this.actions.respondWithEvent<HubPendingActionPayload, unknown>({
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
