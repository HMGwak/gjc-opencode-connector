export type SessionStatus = "active" | "stale" | "unknown" | "terminal";
export type SessionControlMode = "view-only" | "controlled";
export type SessionOrigin = "ondisk-discovery" | "coordinator-start" | "coordinator-resume" | "coordinator-continuation" | "opencode-discovery";
export type TranscriptStatus = "available" | "unreadable";
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
export type BackfillJobState = "pending" | "running" | "paused" | "complete" | "failed";
export interface BackfillJob {
  readonly name: string;
  readonly cursor: unknown;
  readonly state: BackfillJobState;
  readonly attempts: number;
  readonly startedAt: string | null;
  readonly pausedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly error: string | null;
  readonly updatedAt: string;
}
export type PendingActionState = "pending" | "dispatching" | "answered" | "cancelled" | "expired" | "unknown";

export interface PendingAction<T = unknown, A = unknown> {
  readonly id: string;
  readonly sessionId: string | null;
  readonly ownerId: string;
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
  readonly controlMode: SessionControlMode;
  readonly origin: SessionOrigin;
  readonly transcriptStatus: TranscriptStatus;
  readonly activeProjectorVersion: string | null;
  readonly archivedAt?: string | null;
  readonly title: string | null;
  readonly workdir: string | null;
  readonly sourceCreatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface WorkItem<T = unknown> {
  readonly id: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly remoteId: string;
  readonly state: string;
  readonly projectorVersion: string;
  readonly payload: T;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectionCheckpoint {
  readonly sessionId: string;
  readonly projectorVersion: string;
  readonly nextExpectedSeq: number;
  readonly updatedAt: string;
}

export interface ProjectionGap {
  readonly sessionId: string;
  readonly projectorVersion: string;
  readonly seq: number;
  readonly reason: string;
  readonly resolvedAt: string | null;
  readonly detectedAt: string;
}

export interface ProjectionFailure {
  readonly sessionId: string;
  readonly projectorVersion: string;
  readonly seq: number;
  readonly reason: string;
  readonly failedAt: string;
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
  readonly actorId: string | null;
  readonly deviceId: string | null;
  readonly correlationId: string | null;
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
