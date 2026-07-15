import type { SessionEvent } from "./types";

export class CursorExpiredError extends Error {
  readonly status = 410;
  readonly snapshotReset = true;

  constructor(message = "The requested event cursor has expired; fetch a snapshot and reconnect.") {
    super(message);
    this.name = "CursorExpiredError";
  }
}

export interface SubscriptionMetrics {
  readonly onActiveSenders?: (count: number) => void | Promise<void>;
  readonly onQueueLength?: (length: number) => void | Promise<void>;
  readonly onWakeLatency?: (milliseconds: number) => void | Promise<void>;
  readonly onFailure?: (error: unknown) => void | Promise<void>;
}
/**
 * Synchronous observability points for deterministic protocol tests. Hooks are
 * best-effort and never participate in subscription control flow.
 */
export interface SubscriptionProtocolHooks {
  readonly onMutex?: (phase: "enter" | "exit") => void | Promise<void>;
  readonly onSenderStart?: () => void | Promise<void>;
  readonly onGateTransition?: (transition: "CLOSED->OPEN") => void | Promise<void>;
  readonly onPoint?: (
    point: "registered" | "replay-complete" | "live-wait" | "wake" | "disconnected",
  ) => void | Promise<void>;
}

export interface SubscriptionSource {
  /** Returns events in ascending sequence order, inclusively bounded by `upTo`. */
  readonly replay: (
    sessionId: string,
    after: number,
    upTo: number,
  ) => Promise<readonly SessionEvent[]>;
  /** Must be a cheap, synchronous read of the journal's current high-water mark. */
  readonly highWaterMark: (sessionId: string) => number;
}

export interface SubscriptionOptions {
  readonly maxQueueSize?: number;
  readonly metrics?: SubscriptionMetrics;
  /** Test and diagnostic instrumentation; hooks cannot alter hub control flow. */
  readonly protocolHooks?: SubscriptionProtocolHooks;
}

export interface SubscribeOptions {
  readonly after?: number;
  readonly send: (event: SessionEvent) => Promise<void> | void;
  readonly onSnapshotReset?: () => void | Promise<void>;
}

export interface SubscriptionConnection {
  readonly sessionId: string;
  readonly closed: boolean;
  readonly snapshotReset: boolean;
  disconnect(): void;
}

type Gate = "CLOSED" | "OPEN";

interface Listener {
  readonly sessionId: string;
  readonly after: number;
  readonly highWaterMark: number;
  readonly send: (event: SessionEvent) => Promise<void> | void;
  readonly onSnapshotReset?: () => void;
  queue: SessionEvent[];
  gate: Gate;
  disconnected: boolean;
  snapshotReset: boolean;
  wake?: Deferred;
}

interface Deferred {
  readonly createdAt: number;
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { createdAt: performance.now(), promise, resolve };
}

/**
 * Per-process replay/live fan-out.  A connection owns exactly one sender task;
 * producers only append to that sender's FIFO while holding this hub's mutex.
 */
export class SubscriptionHub {
  private readonly listeners = new Set<Listener>();
  private readonly maxQueueSize: number;
  private mutex = Promise.resolve();
  private activeSenders = 0;

  constructor(
    private readonly source: SubscriptionSource,
    private readonly options: SubscriptionOptions = {},
  ) {
    this.maxQueueSize = options.maxQueueSize ?? 1_000;
    if (!Number.isSafeInteger(this.maxQueueSize) || this.maxQueueSize < 1) {
      throw new RangeError("maxQueueSize must be a positive safe integer");
    }
  }

  async subscribe(sessionId: string, options: SubscribeOptions): Promise<SubscriptionConnection> {
    const after = options.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError("after must be a non-negative safe integer");
    }

    let listener!: Listener;
    await this.withMutex(() => {
      listener = {
        sessionId,
        after,
        highWaterMark: this.source.highWaterMark(sessionId),
        send: options.send,
        onSnapshotReset: options.onSnapshotReset,
        queue: [],
        gate: "CLOSED",
        disconnected: false,
        snapshotReset: false,
      };
      this.listeners.add(listener);
      this.hook("registered");
    });

    // This is deliberately the only sender creation site.
    this.activeSenders += 1;
    this.callback(this.options.metrics?.onActiveSenders, this.activeSenders);
    this.hook("sender-start");
    void this.sender(listener);

    return {
      sessionId,
      get closed() {
        return listener.disconnected;
      },
      get snapshotReset() {
        return listener.snapshotReset;
      },
      disconnect: () => this.disconnect(listener),
    };
  }

  async publish(event: SessionEvent): Promise<void> {
    const snapshotResets: Array<() => void | Promise<void>> = [];
    await this.withMutex(() => {
      for (const listener of this.listeners) {
        if (listener.sessionId !== event.sessionId || listener.disconnected) continue;
        listener.queue.push(event);
        this.reportQueueLength(listener.queue.length);
        if (listener.queue.length > this.maxQueueSize) {
          const onSnapshotReset = this.closeLocked(listener, true);
          if (onSnapshotReset !== undefined) snapshotResets.push(onSnapshotReset);
          continue;
        }
        this.wakeLocked(listener);
      }
    });
    for (const onSnapshotReset of snapshotResets) this.callback(onSnapshotReset);
  }

  private async sender(listener: Listener): Promise<void> {
    try {
      // Replay never consumes the live queue. Both replay and live sends are FIFO.
      const replay = await this.source.replay(listener.sessionId, listener.after, listener.highWaterMark);
      for (const event of replay) {
        if (await this.isDisconnected(listener)) return;
        await listener.send(event);
      }
      this.hook("replay-complete");

      await this.withMutex(() => {
        // Disconnect wins over the one-way CLOSED -> OPEN transition.
        if (!listener.disconnected) {
          listener.gate = "OPEN";
          this.hook("gate-transition");
        }
      });

      for (;;) {
        const event = await this.nextLive(listener);
        if (event === undefined) return;
        await listener.send(event);
      }
    } catch (error) {
      this.reportFailure(error);
      const onSnapshotReset = await this.withMutex(() =>
        this.closeLocked(listener, error instanceof CursorExpiredError),
      );
      this.callback(onSnapshotReset);
    } finally {
      await this.withMutex(() => this.closeLocked(listener, false));
      this.activeSenders -= 1;
      this.callback(this.options.metrics?.onActiveSenders, this.activeSenders);
    }
  }

  private async nextLive(listener: Listener): Promise<SessionEvent | undefined> {
    for (;;) {
      let wait: Deferred | undefined;
      const event = await this.withMutex(() => {
        if (listener.disconnected) return undefined;
        if (listener.gate !== "OPEN") throw new Error("sender consumed a live queue before opening");
        const next = listener.queue.shift();
        if (next !== undefined) {
          this.reportQueueLength(listener.queue.length);
          return next;
        }
        listener.wake ??= deferred();
        this.hook("live-wait");
        wait = listener.wake;
        return null;
      });
      if (event !== null) return event;
      await wait!.promise;
      this.hook("wake");
      this.callback(this.options.metrics?.onWakeLatency, performance.now() - wait!.createdAt);
    }
  }

  private async isDisconnected(listener: Listener): Promise<boolean> {
    return this.withMutex(() => listener.disconnected);
  }

  private disconnect(listener: Listener): void {
    void this.withMutex(() => this.closeLocked(listener, false));
  }

  private wakeLocked(listener: Listener): void {
    const wake = listener.wake;
    if (wake === undefined) return;
    listener.wake = undefined;
    wake.resolve();
  }

  private reportQueueLength(length: number): void {
    const report = this.options.metrics?.onQueueLength;
    if (report !== undefined) queueMicrotask(() => this.callback(report, length));
  }
  private closeLocked(listener: Listener, snapshotReset: boolean): (() => void | Promise<void>) | undefined {
    if (listener.disconnected) return undefined;
    listener.disconnected = true;
    this.hook("disconnected");
    listener.snapshotReset = snapshotReset;
    listener.queue = [];
    this.listeners.delete(listener);
    this.wakeLocked(listener);
    return snapshotReset ? listener.onSnapshotReset : undefined;
  }

  private callback<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): void;
  private callback(callback: (() => void | Promise<void>) | undefined): void;
  private callback<T>(callback: ((value: T) => void | Promise<void>) | (() => void | Promise<void>) | undefined, value?: T): void {
    if (callback === undefined) return;
    try {
      Promise.resolve((callback as (value?: T) => void | Promise<void>)(value)).catch((error) => this.reportFailure(error));
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private reportFailure(error: unknown): void {
    const report = this.options.metrics?.onFailure;
    if (report === undefined) return;
    try {
      Promise.resolve(report(error)).catch(() => {});
    } catch {
      // Failure reporting must not recursively report its own failures.
    }
  }

  private hook(point: "registered" | "sender-start" | "replay-complete" | "gate-transition" | "live-wait" | "wake" | "disconnected"): void {
    switch (point) {
      case "sender-start":
        this.callback(this.options.protocolHooks?.onSenderStart);
        return;
      case "gate-transition":
        this.callback(this.options.protocolHooks?.onGateTransition, "CLOSED->OPEN");
        return;
      default:
        this.callback(this.options.protocolHooks?.onPoint, point);
    }
  }

  private withMutex<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() => {
      this.callback(this.options.protocolHooks?.onMutex, "enter");
      return operation();
    }).finally(() => {
      this.callback(this.options.protocolHooks?.onMutex, "exit");
      release();
    });
  }
}
