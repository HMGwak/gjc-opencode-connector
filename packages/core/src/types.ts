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
  readonly continuationParentId?: string | null;
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
export type SessionHierarchyKind = "root" | "internal" | "unknown";
export type SessionHierarchyUnknownReason =
  | "missing-human-evidence" | "self-parent" | "cycle" | "cross-owner-parent"
  | "duplicate-header-id" | "missing-parent" | "depth-limit" | "invalid-evidence";
export type SessionHierarchyObservationState = "valid" | "unreadable" | "missing-parent" | "conflict";
export type SessionHierarchyLineageKind = "direct" | "continuation" | "subagent" | "tool" | "review" | null;

export interface SessionHierarchyEvidence {
  readonly ownerId: string;
  readonly adapter: string;
  readonly sourceKey: string;
  readonly sessionId: string;
  readonly identityNamespace: string;
  readonly observedParentSessionId: string | null;
  readonly observedParentOwnerId: string | null;
  readonly directHumanEvidence: boolean;
  readonly structuralKind: Exclude<SessionHierarchyLineageKind, null>;
  readonly observationState: SessionHierarchyObservationState;
  readonly capturedEpoch: number;
  readonly deletedAt: string | null;
}

export interface SessionHierarchyProjection {
  readonly ownerId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly kind: SessionHierarchyKind;
  readonly rootSessionId: string | null;
  readonly parentSessionId: string | null;
  readonly unknownReason: SessionHierarchyUnknownReason | null;
  readonly lineageKind: SessionHierarchyLineageKind;
  readonly internalKind: string | null;
  readonly subagentIdentity: string | null;
}

export interface SessionHierarchyRollup {
  readonly rootSessionId: string;
  readonly internalCount: number;
  readonly actionableCount: number;
  readonly failureCount: number;
  readonly lastActivityAt: string | null;
}
export interface HierarchyGeneration {
  readonly ownerId: string;
  readonly activeGeneration: number;
  readonly evidenceRevision: number;
  readonly evidenceSchemaEpoch: number;
  readonly updatedAt: string;
}

export interface HierarchyBackfillCycle {
  readonly ownerId: string;
  readonly epoch: number;
  readonly cycle: number;
  readonly requiredAdapters: readonly string[];
  readonly frozenAt: string | null;
}

export interface HierarchyReadiness {
  readonly ownerId: string;
  readonly evidenceSchemaEpoch: number;
  readonly requiredEpoch: number;
  readonly coverageGapCount: number;
  readonly ready: boolean;
}
