export type MultiTabMessage =
  | { kind: "event"; sessionId: string; event: unknown; seq: number }
  | { kind: "cursor"; sessionId: string; cursor: number }
  | { kind: "reset"; sessionId: string }
  | { kind: "hello"; tabId: string }
  | { kind: "leader"; tabId: string; epoch: number; leaseUntil: number }
  | { kind: "heartbeat"; tabId: string; epoch: number; leaseUntil: number }
  | { kind: "subscribe"; tabId: string; sessionId: string }
  | { kind: "unsubscribe"; tabId: string; sessionId: string };

export type Channel = {
  postMessage(message: MultiTabMessage): void;
  close(): void;
  onmessage: ((event: MessageEvent<MultiTabMessage>) => void) | null;
};

type LockManager = {
  request(name: string, options: { ifAvailable: true }, callback: (lock: Lock | null) => Promise<void>): Promise<void>;
};

type Options = {
  channel?: Channel;
  tabId: string;
  locks?: LockManager;
  onLeaderChange(leader: boolean): void;
  onEvent(sessionId: string, event: unknown): void;
  onCursor(sessionId: string, cursor: number): void;
  onReset(sessionId: string): void;
  onSessionsChange?(): void;
  now?(): number;
  setTimeout?(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout?(timer: ReturnType<typeof setTimeout>): void;
};

const HEARTBEAT_MS = 1_000;
const PEER_TTL_MS = HEARTBEAT_MS * 3;
const STARTUP_GRACE_MS = 50;

/** Coordinates polling so exactly one elected tab performs network catch-up. */
export class MultiTabCoordinator {
  private readonly peers = new Map<string, number>();
  private readonly requests = new Map<string, Set<string>>();
  private readonly seenEvents = new Map<string, number>();
  private readonly seenCursors = new Map<string, number>();
  private readonly schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly clock: () => number;
  private leader = false;
  private stopped = false;
  private epoch = 0;
  private startupComplete = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseLock: (() => void) | undefined;
  private leaderTabId: string | undefined;
  private leaseUntil = 0;

  constructor(private readonly options: Options) {
    this.schedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.clock = options.now ?? Date.now;
  }

  start(): void {
    if (!this.options.channel) return;
    this.options.channel.onmessage = (event) => this.receive(event.data);
    if (this.options.locks) this.acquireLock();
    else this.startFallback();
  }

  stop(): void {
    if (this.stopped) return;
    this.replayLocalRequests(false);
    this.stopped = true;
    for (const timer of [this.heartbeatTimer, this.retryTimer, this.startupTimer]) if (timer) this.cancel(timer);
    this.releaseLock?.();
    this.setLeader(false);
    this.options.channel?.close();
  }

  isLeader(): boolean { return this.leader; }
  canCoordinate(): boolean { return this.options.channel !== undefined; }

  requestedSessions(): string[] {
    return [...this.requests.values()].flatMap((sessions) => [...sessions]).filter((id, index, all) => all.indexOf(id) === index);
  }

  requestSession(sessionId: string): void {
    const local = this.requests.get(this.options.tabId) ?? new Set<string>();
    if (local.has(sessionId)) return;
    local.add(sessionId); this.requests.set(this.options.tabId, local);
    this.options.channel?.postMessage({ kind: "subscribe", tabId: this.options.tabId, sessionId });
    this.sessionsChanged();
  }

  releaseSession(sessionId: string): void {
    const local = this.requests.get(this.options.tabId);
    if (!local?.delete(sessionId)) return;
    this.options.channel?.postMessage({ kind: "unsubscribe", tabId: this.options.tabId, sessionId });
    this.sessionsChanged();
  }

  publishEvent(sessionId: string, event: unknown, seq: number): void {
    if (!this.leader || !this.accept(this.seenEvents, sessionId, seq)) return;
    this.invoke(() => this.options.onEvent(sessionId, event));
    this.options.channel?.postMessage({ kind: "event", sessionId, event, seq });
  }

  publishCursor(sessionId: string, cursor: number): void {
    if (!this.leader || !this.accept(this.seenCursors, sessionId, cursor)) return;
    this.invoke(() => this.options.onCursor(sessionId, cursor));
    this.options.channel?.postMessage({ kind: "cursor", sessionId, cursor });
  }

  publishReset(sessionId: string): void {
    if (!this.leader) return;
    this.seenEvents.delete(sessionId); this.seenCursors.delete(sessionId);
    this.invoke(() => this.options.onReset(sessionId));
    this.options.channel?.postMessage({ kind: "reset", sessionId });
  }

  private receive(message: MultiTabMessage): void {
    if (this.stopped) return;
    if (message.kind === "event") { if (this.accept(this.seenEvents, message.sessionId, message.seq)) this.invoke(() => this.options.onEvent(message.sessionId, message.event)); return; }
    if (message.kind === "cursor") { if (this.accept(this.seenCursors, message.sessionId, message.cursor)) this.invoke(() => this.options.onCursor(message.sessionId, message.cursor)); return; }
    if (message.kind === "reset") { this.seenEvents.delete(message.sessionId); this.seenCursors.delete(message.sessionId); this.invoke(() => this.options.onReset(message.sessionId)); return; }
    if (message.kind === "subscribe") { this.changeRequest(message.tabId, message.sessionId, true); return; }
    if (message.kind === "unsubscribe") { this.changeRequest(message.tabId, message.sessionId, false); return; }
    if (message.tabId === this.options.tabId) return;
    if (message.kind === "hello") {
      this.peers.set(message.tabId, this.clock());
      this.replayLocalRequests();
      if (this.leader) this.announceLeader();
      this.electFallback();
      return;
    }
    if (!Number.isSafeInteger(message.epoch) || message.epoch < 0 || !Number.isFinite(message.leaseUntil) || message.leaseUntil <= this.clock()) return;
    if (message.epoch < this.epoch) return;
    if (message.epoch === this.epoch && this.leaderTabId && this.leaderTabId !== message.tabId) return;
    this.peers.set(message.tabId, this.clock());
    this.epoch = message.epoch;
    this.leaderTabId = message.tabId;
    this.leaseUntil = message.leaseUntil;
    this.setLeader(message.tabId === this.options.tabId);
    if (message.kind === "leader") this.replayLocalRequests();
  }

  private changeRequest(tabId: string, sessionId: string, add: boolean): void {
    const sessions = this.requests.get(tabId) ?? new Set<string>();
    if (add) sessions.add(sessionId); else sessions.delete(sessionId);
    if (sessions.size) this.requests.set(tabId, sessions); else this.requests.delete(tabId);
    this.sessionsChanged();
  }

  private sessionsChanged(): void { if (this.leader) this.invoke(() => this.options.onSessionsChange?.()); }
  private invoke(callback: () => void): void { try { callback(); } catch { /* External callbacks cannot compromise coordination. */ } }
  private accept(seen: Map<string, number>, sessionId: string, seq: number): boolean { const previous = seen.get(sessionId) ?? -1; if (seq <= previous) return false; seen.set(sessionId, seq); return true; }
  private replayLocalRequests(subscribe = true): void {
    for (const sessionId of this.requests.get(this.options.tabId) ?? []) {
      this.options.channel?.postMessage({ kind: subscribe ? "subscribe" : "unsubscribe", tabId: this.options.tabId, sessionId });
    }
  }

  private cleanStalePeers(): void {
    const now = this.clock();
    for (const [tabId, seenAt] of this.peers) {
      if (tabId !== this.options.tabId && now - seenAt > PEER_TTL_MS) {
        this.peers.delete(tabId);
        this.requests.delete(tabId);
      }
    }
  }

  private acquireLock(): void {
    if (this.options.channel) {
      this.peers.set(this.options.tabId, this.clock());
      this.options.channel.postMessage({ kind: "hello", tabId: this.options.tabId });
    }
    void this.options.locks!.request("planee-agent-hub-poller", { ifAvailable: true }, async (lock) => {
      if (!lock || this.stopped) { this.retryTimer = this.schedule(() => this.acquireLock(), HEARTBEAT_MS); return; }
      this.epoch++;
      this.leaderTabId = this.options.tabId;
      this.leaseUntil = this.clock() + PEER_TTL_MS;
      this.setLeader(true);
      this.startLockHeartbeat();
      this.replayLocalRequests();
      if (this.options.channel) this.announceLeader();
      await new Promise<void>((resolve) => { this.releaseLock = resolve; });
      this.releaseLock = undefined; this.setLeader(false);
    });
  }
  private startLockHeartbeat(): void {
    if (!this.options.channel || this.heartbeatTimer) return;
    const heartbeat = (): void => {
      if (this.stopped) return;
      this.cleanStalePeers();
      if (this.leader) this.announceLeader();
      this.heartbeatTimer = this.schedule(heartbeat, HEARTBEAT_MS);
    };
    this.heartbeatTimer = this.schedule(heartbeat, HEARTBEAT_MS);
  }

  private startFallback(): void {
    this.peers.set(this.options.tabId, this.clock());
    this.options.channel!.postMessage({ kind: "hello", tabId: this.options.tabId });
    // No tab may poll during this grace period; hello/leader replies close startup races.
    this.startupTimer = this.schedule(() => { this.startupComplete = true; this.electFallback(); }, STARTUP_GRACE_MS);
    const heartbeat = (): void => {
      if (this.stopped) return;
      this.peers.set(this.options.tabId, this.clock());
      this.cleanStalePeers();
      if (this.leader) this.announceLeader();
      this.electFallback(); this.heartbeatTimer = this.schedule(heartbeat, HEARTBEAT_MS);
    };
    this.heartbeatTimer = this.schedule(heartbeat, HEARTBEAT_MS);
  }

  private announceLeader(): void {
    const leaseUntil = this.clock() + PEER_TTL_MS;
    this.leaderTabId = this.options.tabId;
    this.leaseUntil = leaseUntil;
    this.options.channel?.postMessage({ kind: "leader", tabId: this.options.tabId, epoch: this.epoch, leaseUntil });
    this.options.channel?.postMessage({ kind: "heartbeat", tabId: this.options.tabId, epoch: this.epoch, leaseUntil });
  }

  private electFallback(): void {
    if (this.stopped || this.options.locks || !this.startupComplete) return;
    if (this.leaderTabId && this.leaderTabId !== this.options.tabId && this.leaseUntil > this.clock()) {
      this.setLeader(false);
      return;
    }
    const winner = [...this.peers.keys()].sort()[0];
    const becomesLeader = winner === this.options.tabId;
    if (becomesLeader && !this.leader) {
      this.epoch++;
      this.leaderTabId = this.options.tabId;
      this.setLeader(true);
      this.replayLocalRequests();
      this.announceLeader();
    } else this.setLeader(becomesLeader);
  }

  private setLeader(leader: boolean): void { if (this.leader === leader) return; this.leader = leader; this.invoke(() => this.options.onLeaderChange(leader)); }
}
