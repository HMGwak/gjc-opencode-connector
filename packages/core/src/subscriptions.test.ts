import { describe, expect, test } from "bun:test";
import { CursorExpiredError, SubscriptionHub } from "./subscriptions";
import type { SessionEvent } from "./types";

const event = (seq: number): SessionEvent => ({
  sessionId: "session-1",
  seq,
  type: "changed",
  payload: { seq },
  createdAt: new Date(seq).toISOString(),
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function source(events: readonly SessionEvent[], replay = async (_sessionId: string, after: number, upTo: number) =>
  events.filter((item) => item.seq > after && item.seq <= upTo)) {
  return {
    highWaterMark: () => events.at(-1)?.seq ?? 0,
    replay,
  };
}

describe("SubscriptionHub", () => {
  test("creates one sender and preserves thousands of replay/live events in order", async () => {
    const replayEvents = Array.from({ length: 1_000 }, (_, index) => event(index + 1));
    let releaseReplay!: () => void;
    const replayReady = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const sent: number[] = [];
    const active: number[] = [];
    const hub = new SubscriptionHub(source(replayEvents, async (_sessionId, after, upTo) => {
      await replayReady;
      return replayEvents.filter((item) => item.seq > after && item.seq <= upTo);
    }), { metrics: { onActiveSenders: (count) => { active.push(count); } } });

    const connection = await hub.subscribe("session-1", { send: (item) => { sent.push(item.seq); } });
    for (let seq = 1_001; seq <= 2_000; seq += 1) await hub.publish(event(seq));
    releaseReplay();
    while (sent.length !== 2_000) await tick();

    expect(sent).toEqual(Array.from({ length: 2_000 }, (_, index) => index + 1));
    expect(Math.max(...active)).toBe(1);
    connection.disconnect();
  });

  test("does not lose a wake between empty-queue inspection and publish", async () => {
    const received: number[] = [];
    const hub = new SubscriptionHub(source([]));
    const connection = await hub.subscribe("session-1", { send: (item) => { received.push(item.seq); } });
    for (let seq = 1; seq <= 1_000; seq += 1) {
      await hub.publish(event(seq));
      while (received.length !== seq) await tick();
    }
    expect(received).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
    connection.disconnect();
  });

  test("keeps live publishes behind in-flight replay and never reopens after disconnect", async () => {
    let releaseSend!: () => void;
    const firstSend = new Promise<void>((resolve) => { releaseSend = resolve; });
    const received: number[] = [];
    const hub = new SubscriptionHub(source([event(1)]));
    const connection = await hub.subscribe("session-1", {
      send: async (item) => {
        received.push(item.seq);
        if (item.seq === 1) await firstSend;
      },
    });
    await hub.publish(event(2));
    connection.disconnect();
    releaseSend();
    await tick();
    expect(received).toEqual([1]);
    expect(connection.closed).toBe(true);
  });

  test("cleans up after a send failure without respawning a sender", async () => {
    const failures: unknown[] = [];
    const active: number[] = [];
    const hub = new SubscriptionHub(source([]), { metrics: {
      onFailure: (failure) => { failures.push(failure); },
      onActiveSenders: (count) => { active.push(count); },
    } });
    const connection = await hub.subscribe("session-1", { send: () => { throw new Error("broken socket"); } });
    await hub.publish(event(1));
    while (!connection.closed) await tick();
    await hub.publish(event(2));
    expect(failures).toHaveLength(1);
    expect(Math.max(...active)).toBe(1);
  });

  test("contains throwing application and metrics callbacks", async () => {
    let releaseReplay!: () => void;
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const failures: unknown[] = [];
    const hub = new SubscriptionHub(source([], async () => {
      await replayBlocked;
      return [];
    }), {
      maxQueueSize: 1,
      metrics: {
        onActiveSenders: () => { throw new Error("active metric"); },
        onQueueLength: async () => { throw new Error("queue metric"); },
        onFailure: (failure) => { failures.push(failure); },
      },
    });
    const connection = await hub.subscribe("session-1", {
      send: () => {},
      onSnapshotReset: () => { throw new Error("reset callback"); },
    });
    await hub.publish(event(1));
    await expect(hub.publish(event(2))).resolves.toBeUndefined();
    while (failures.length !== 4) await tick();
    expect(connection.closed).toBe(true);
    releaseReplay();
  });
  test("overflows to a snapshot reset and stops the connection", async () => {
    let releaseReplay!: () => void;
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve; });
    let resets = 0;
    const hub = new SubscriptionHub(source([], async () => {
      await replayBlocked;
      return [];
    }), { maxQueueSize: 3 });
    const connection = await hub.subscribe("session-1", { send: () => {}, onSnapshotReset: () => { resets += 1; } });
    for (let seq = 1; seq <= 4; seq += 1) await hub.publish(event(seq));
    expect(connection.closed).toBe(true);
    expect(connection.snapshotReset).toBe(true);
    expect(resets).toBe(1);
    releaseReplay();
  });

  test("propagates cursor expiry as a reset-worthy replay failure", async () => {
    const hub = new SubscriptionHub(source([], async () => { throw new CursorExpiredError(); }));
    const connection = await hub.subscribe("session-1", { send: () => {} });
    while (!connection.closed) await tick();
    expect(connection.snapshotReset).toBe(true);
  });
  test("proves 2,000 registration/publish schedules have no replay-to-live gap", async () => {
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const journal = [event(1)];
      let releaseReplay!: () => void;
      const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve; });
      const received: number[] = [];
      let complete!: () => void;
      const delivered = new Promise<void>((resolve) => { complete = resolve; });
      const hub = new SubscriptionHub({
        highWaterMark: () => journal.at(-1)?.seq ?? 0,
        replay: async (_sessionId, after, upTo) => {
          await replayBlocked;
          return journal.filter((item) => item.seq > after && item.seq <= upTo);
        },
      });
      const subscription = hub.subscribe("session-1", {
        send: (item) => {
          received.push(item.seq);
          if (received.length === 2) complete();
        },
      });
      journal.push(event(2));
      const publication = hub.publish(event(2));
      const connection = await subscription;
      await publication;
      releaseReplay();
      await delivered;
      expect(received).toEqual([1, 2]);
      connection.disconnect();
    }
  });

  test("serializes 2,000 concurrent publishers through one FIFO sender", async () => {
    const received: number[] = [];
    let complete!: () => void;
    const delivered = new Promise<void>((resolve) => { complete = resolve; });
    const hub = new SubscriptionHub(source([]), { maxQueueSize: 2_000 });
    const connection = await hub.subscribe("session-1", {
      send: (item) => {
        received.push(item.seq);
        if (received.length === 2_000) complete();
      },
    });
    await Promise.all(Array.from({ length: 2_000 }, (_, index) => hub.publish(event(index + 1))));
    await delivered;
    expect(received).toEqual(Array.from({ length: 2_000 }, (_, index) => index + 1));
    connection.disconnect();
  });

  test("records exactly one sender, monotonic gate opening, and disconnect priority", async () => {
    let releaseReplay!: () => void;
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const points: string[] = [];
    let sendWhileLocked = false;
    let mutexDepth = 0;
    const hub = new SubscriptionHub(source([event(1)], async () => {
      await replayBlocked;
      return [event(1)];
    }), {
      protocolHooks: {
        onMutex: (phase) => { mutexDepth += phase === "enter" ? 1 : -1; },
        onSenderStart: () => { points.push("sender"); },
        onGateTransition: (transition) => { points.push(transition); },
        onPoint: (point) => { points.push(point); },
      },
    });
    const connection = await hub.subscribe("session-1", {
      send: () => { sendWhileLocked ||= mutexDepth !== 0; },
    });
    connection.disconnect();
    releaseReplay();
    while (!connection.closed) await tick();
    await tick();

    expect(points.filter((point) => point === "sender")).toHaveLength(1);
    expect(points).not.toContain("CLOSED->OPEN");
    expect(points.filter((point) => point === "disconnected")).toHaveLength(1);
    expect(sendWhileLocked).toBe(false);
  });

  test("disconnect wins over queued backpressure without reopening the gate", async () => {
    let releaseReplay!: () => void;
    const replayBlocked = new Promise<void>((resolve) => { releaseReplay = resolve; });
    const transitions: string[] = [];
    let resets = 0;
    const hub = new SubscriptionHub(source([], async () => {
      await replayBlocked;
      return [];
    }), {
      maxQueueSize: 2,
      protocolHooks: { onGateTransition: (transition) => { transitions.push(transition); } },
    });
    const connection = await hub.subscribe("session-1", {
      send: () => {},
      onSnapshotReset: () => { resets += 1; },
    });
    await Promise.all([hub.publish(event(1)), hub.publish(event(2)), hub.publish(event(3))]);
    expect(connection.closed).toBe(true);
    expect(connection.snapshotReset).toBe(true);
    expect(resets).toBe(1);
    releaseReplay();
    await tick();
    expect(transitions).toEqual([]);
  });
});
