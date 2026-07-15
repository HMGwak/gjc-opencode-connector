export type SessionStatus = "active" | "stale" | "unknown" | "terminal";
export type CommandState =
  | "accepted"
  | "dispatching"
  | "remote-confirmed"
  | "applied"
  | "failed"
  | "unknown";
export type RemoteMutationState = "confirmed" | "unknown";
export interface RemoteMutationResult {
  /** Unknown is quarantined: callers MUST NOT automatically retry it. */
  readonly state: RemoteMutationState;
  readonly remoteId: string | null;
}
export type PendingActionState = "pending" | "answered" | "cancelled" | "expired" | "unknown";

export interface PendingAction<T = unknown, A = unknown> {
  readonly id: string;
  readonly version: number;
  readonly state: PendingActionState;
  readonly payload: T;
  readonly answer: A | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Session {
  readonly id: string;
  readonly ownerId: string;
  readonly adapter: string;
  readonly remoteId: string;
  readonly status: SessionStatus;
  readonly reconciliationEpoch: number;
  readonly reconciled: boolean;
  readonly remoteRevision: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionEvent<T = unknown> {
  readonly sessionId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: T;
  readonly createdAt: string;
}

export interface Command<T = unknown> {
  readonly id: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly state: CommandState;
  readonly correlationId: string | null;
  readonly attempt: number;
  readonly leaseExpiresAt: string | null;
  readonly payload: T;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditEntry<T = unknown> {
  readonly id: number;
  readonly action: string;
  readonly sessionId: string | null;
  readonly commandId: string | null;
  readonly payload: T;
  readonly createdAt: string;
}
export interface PushSubscription {
  readonly ownerId: string;
  readonly endpointHash: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredPushSubscription extends PushSubscription {
  /** Opaque ciphertext; only the push service's cipher may decrypt it. */
  readonly encryptedMaterial: string;
}

export interface PushPayload {
  readonly title?: string;
  readonly body?: string;
  /** A same-origin, allowlisted path without query or fragment. */
  readonly deepLink?: string;
}

export interface ReconciliationCapabilities {
  readonly stableRemoteId: boolean;
  readonly revision: boolean;
  readonly terminalState: boolean;
  readonly tombstone: boolean;
  readonly watermark: boolean;
  readonly fencing: boolean;
}

export interface ReconciliationSnapshot {
  readonly remoteId: string;
  readonly revision: string;
  readonly terminal: boolean;
  readonly tombstone: boolean;
  readonly watermark: string;
}

export interface ReconciliationResult {
  readonly sessionId: string;
  readonly epoch: number;
  readonly status: SessionStatus;
  readonly reconciled: boolean;
  readonly reason?: string;
}

export interface AgentAdapter {
  readonly name: string;
  readonly reconciliationCapabilities: ReconciliationCapabilities;
  reconcile(session: Session, epoch: number): Promise<ReconciliationSnapshot | null>;
  prompt?(sessionId: string, prompt: string): Promise<void>;
}
