import { randomUUID } from "node:crypto";
import { CoreDatabase } from "./database";
import type { PendingAction, PendingActionState } from "./types";

export class PendingActionError extends Error {
  constructor(readonly code: "not-found" | "stale" | "conflict" | "cancelled" | "expired" | "unknown", message: string) {
    super(message);
    this.name = "PendingActionError";
  }
}

export interface CreatePendingAction<T> {
  readonly id?: string;
  readonly payload: T;
  readonly expiresAt: string;
}

export interface RespondToPendingAction<A> {
  readonly id: string;
  readonly version: number;
  readonly answer: A;
}

export interface PendingActionServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export class PendingActionService {
  private readonly clock: () => Date;
  private readonly createId: () => string;

  constructor(private readonly database: CoreDatabase, options: PendingActionServiceOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  create<T>(input: CreatePendingAction<T>): PendingAction<T> {
    const id = input.id ?? this.createId();
    if (!id) throw new Error("Pending action ID must not be empty");
    const expiry = new Date(input.expiresAt);
    if (Number.isNaN(expiry.getTime())) throw new Error("Pending action expiry must be an ISO timestamp");
    return this.database.transaction(() => {
      const action = this.database.createPendingAction({ id, payload: input.payload, expiresAt: expiry.toISOString() });
      this.database.writeAudit({ action: "pending-action.created", payload: { id: action.id, version: action.version, expiresAt: action.expiresAt } });
      return action;
    });
  }

  get<T, A = unknown>(id: string): PendingAction<T, A> | null {
    return this.database.getPendingAction<T, A>(id);
  }

  respond<T, A>(input: RespondToPendingAction<A>): PendingAction<T, A> {
    return this.transition<T, A>(input.id, input.version, "answered", input.answer);
  }
  /**
   * Commits the answer, its audit record, and the session event together.
   * An append failure rolls back the answer so the original request can retry.
   */
  respondWithEvent<T, A>(input: RespondToPendingAction<A> & { readonly sessionId: string; readonly eventType?: string; readonly eventPayload?: unknown }): PendingAction<T, A> {
    return this.transition<T, A>(input.id, input.version, "answered", input.answer, {
      sessionId: input.sessionId,
      eventType: input.eventType ?? "action.responded",
      eventPayload: input.eventPayload,
    });
  }

  cancel<T>(id: string, version: number): PendingAction<T> {
    return this.transition<T, never>(id, version, "cancelled");
  }

  markUnknown<T>(id: string, version: number): PendingAction<T> {
    return this.transition<T, never>(id, version, "unknown");
  }

  expire<T>(id: string, version: number): PendingAction<T> {
    return this.transition<T, never>(id, version, "expired");
  }

  private transition<T, A>(id: string, version: number, target: Exclude<PendingActionState, "pending">, answer?: A, event?: { readonly sessionId: string; readonly eventType: string; readonly eventPayload?: unknown }): PendingAction<T, A> {
    if (!Number.isSafeInteger(version) || version < 1) throw new PendingActionError("stale", "Pending action version is invalid");
    const result = this.database.transaction(() => {
      const existing = this.database.getPendingAction<T, A>(id);
      if (!existing) throw new PendingActionError("not-found", "Pending action does not exist");
      const timestamp = this.clock().toISOString();
      const isExpired = timestamp >= existing.expiresAt;
      const effectiveTarget = existing.state === "pending" && isExpired ? "expired" : target;

      if (existing.state !== "pending") {
        const action = this.resolveTerminal(existing, version, target, answer);
        if (event && action.state === "answered") {
          const eventPayload = event.eventPayload ?? { actionId: action.id, version: action.version };
          const present = this.database.sqlite.query("SELECT 1 FROM events WHERE session_id = ? AND type = ? AND payload_json = ?").get(event.sessionId, event.eventType, JSON.stringify(eventPayload));
          if (!present) this.database.appendEvent(event.sessionId, event.eventType, event.eventPayload ?? { actionId: action.id, version: action.version });
        }
        return { action, expired: false };
      }
      if (version !== existing.version) throw new PendingActionError("stale", "Pending action version is stale");
      const action = this.database.updatePendingAction<T, A>({ id, expectedVersion: version, state: effectiveTarget, answer: effectiveTarget === "answered" ? answer : undefined, updatedAt: timestamp });
      if (!action) throw new PendingActionError("stale", "Pending action changed concurrently");
      this.database.writeAudit({ action: `pending-action.${effectiveTarget}`, sessionId: event?.sessionId, payload: { id, version: action.version, expiresAt: action.expiresAt } });
      if (event) this.database.appendEvent(event.sessionId, event.eventType, event.eventPayload ?? { actionId: action.id, version: action.version });
      return { action, expired: effectiveTarget !== target };
    });
    if (result.expired) throw new PendingActionError("expired", "Pending action has expired");
    return result.action;
  }

  private resolveTerminal<T, A>(existing: PendingAction<T, A>, version: number, target: Exclude<PendingActionState, "pending">, answer?: A): PendingAction<T, A> {
    if (existing.state === "answered" && target === "answered" && version === existing.version - 1 && sameValue(existing.answer, answer)) return existing;
    if (existing.state === "unknown") throw new PendingActionError("unknown", "Pending action outcome is unknown and cannot be retried");
    if (existing.state === "expired") throw new PendingActionError("expired", "Pending action has expired");
    if (existing.state === "cancelled") throw new PendingActionError("cancelled", "Pending action has been cancelled");
    throw new PendingActionError("conflict", "Pending action already has a different terminal response");
  }
}
