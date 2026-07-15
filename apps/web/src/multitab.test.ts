import { expect, test } from "bun:test";
import { MultiTabCoordinator, type Channel, type MultiTabMessage } from "./multitab";

class Bus {
  channels: Channel[] = [];
  open(): Channel {
    const channel: Channel = { onmessage: null, close: () => { this.channels = this.channels.filter((item) => item !== channel); }, postMessage: (message) => {
      for (const target of this.channels) if (target !== channel) target.onmessage?.({ data: message } as MessageEvent<MultiTabMessage>);
    } };
    this.channels.push(channel);
    return channel;
  }
}

class Locks {
  held = false;
  requests = 0;
  async request(_name: string, _options: { ifAvailable: true }, callback: (lock: Lock | null) => Promise<void>): Promise<void> {
    this.requests++;
    if (this.held) return callback(null);
    this.held = true;
    await callback({} as Lock);
    this.held = false;
  }
}

const scheduled: (() => void)[] = [];
function tab(bus: Bus, locks: Locks, id: string, events: string[], cursors: number[]): MultiTabCoordinator {
  return new MultiTabCoordinator({ channel: bus.open(), tabId: id, locks, onLeaderChange: () => {}, onEvent: (_session, event) => events.push(String(event)), onCursor: (_session, cursor) => cursors.push(cursor), onReset: () => {}, setTimeout: (callback) => { scheduled.push(callback); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimeout: () => {} });
}

test("Web Locks elects one poller and hands leadership over after close", async () => {
  const bus = new Bus(); const locks = new Locks(); const first = tab(bus, locks, "a", [], []); const second = tab(bus, locks, "b", [], []);
  first.start(); second.start();
  expect(first.isLeader()).toBe(true); expect(second.isLeader()).toBe(false);
  first.stop();
  await Promise.resolve(); await Promise.resolve();
  scheduled.shift()?.(); scheduled.shift()?.();
  await Promise.resolve(); await Promise.resolve();
  expect(second.isLeader()).toBe(true);
  second.stop();
});

test("leader broadcasts ordered events while followers deduplicate and keep cursors monotonic", () => {
  const bus = new Bus(); const locks = new Locks(); const leaderEvents: string[] = []; const followerEvents: string[] = []; const leaderCursors: number[] = []; const followerCursors: number[] = [];
  const leader = tab(bus, locks, "a", leaderEvents, leaderCursors); const follower = tab(bus, locks, "b", followerEvents, followerCursors);
  leader.start(); follower.start();
  leader.publishEvent("s", "one", 1); leader.publishEvent("s", "duplicate", 1); leader.publishEvent("s", "two", 2);
  leader.publishCursor("s", 1); leader.publishCursor("s", 1); leader.publishCursor("s", 2);
  expect(leaderEvents).toEqual(["one", "two"]); expect(followerEvents).toEqual(["one", "two"]);
  expect(leaderCursors).toEqual([1, 2]); expect(followerCursors).toEqual([1, 2]);
  expect(follower.isLeader()).toBe(false);
  leader.stop(); follower.stop();
});

class FakeClock {
  now = 0;
  private timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  setTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const timer = { at: this.now + delay, callback, cancelled: false };
    this.timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>): void => { (timer as unknown as { cancelled: boolean }).cancelled = true; };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const timer = this.timers.filter((item) => !item.cancelled && item.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!timer) break;
      timer.cancelled = true; this.now = timer.at; timer.callback();
    }
    this.now = end;
  }
}

function fallback(bus: Bus, clock: FakeClock, id: string, changes: boolean[] = []): MultiTabCoordinator {
  return new MultiTabCoordinator({
    channel: bus.open(), tabId: id, now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onLeaderChange: (leader) => changes.push(leader), onEvent: () => {}, onCursor: () => {}, onReset: () => {},
  });
}

test("fallback startup grace elects exactly one poller and TTL failover preserves requested sessions", () => {
  const bus = new Bus(); const clock = new FakeClock();
  const later = fallback(bus, clock, "z"); const first = fallback(bus, clock, "a");
  later.start(); first.start();
  expect(first.isLeader()).toBe(false); expect(later.isLeader()).toBe(false);
  later.requestSession("z-session"); first.requestSession("a-session");
  clock.advance(50);
  expect(first.isLeader()).toBe(true); expect(later.isLeader()).toBe(false);
  expect(first.requestedSessions().sort()).toEqual(["a-session", "z-session"]);
  first.stop();
  clock.advance(4_000);
  expect(later.isLeader()).toBe(true);
  expect(later.requestedSessions()).toEqual(["z-session"]);
  later.stop();
});

test("callback failures do not prevent ordered broadcasts or reset recovery", () => {
  const bus = new Bus(); const clock = new FakeClock(); const received: string[] = []; const resets: string[] = [];
  const leader = fallback(bus, clock, "a");
  const follower = new MultiTabCoordinator({
    channel: bus.open(), tabId: "b", now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onLeaderChange: () => { throw new Error("external callback"); },
    onEvent: (_session, event) => received.push(String(event)), onCursor: () => { throw new Error("external callback"); },
    onReset: (session) => resets.push(session),
  });
  leader.start(); follower.start(); clock.advance(50);
  leader.publishEvent("s", "one", 1); leader.publishEvent("s", "stale", 1); leader.publishEvent("s", "two", 2);
  leader.publishReset("s"); leader.publishEvent("s", "after-reset", 1);
  expect(received).toEqual(["one", "two", "after-reset"]);
  expect(resets).toEqual(["s"]);
  leader.stop(); follower.stop();
});
test("late join replays local requests so the leader reconstructs their union", () => {
  const bus = new Bus(); const clock = new FakeClock();
  const leader = fallback(bus, clock, "a"); leader.requestSession("a-session"); leader.start(); clock.advance(50);
  const joiner = fallback(bus, clock, "b"); joiner.requestSession("b-session"); joiner.start();
  expect(leader.requestedSessions().sort()).toEqual(["a-session", "b-session"]);
  leader.stop(); joiner.stop();
});

test("stop publishes unsubscribe for every local request", () => {
  const bus = new Bus(); const clock = new FakeClock();
  const leader = fallback(bus, clock, "a"); const follower = fallback(bus, clock, "b");
  leader.start(); follower.start(); leader.requestSession("a-one"); leader.requestSession("a-two");
  expect(follower.requestedSessions().sort()).toEqual(["a-one", "a-two"]);
  leader.stop();
  expect(follower.requestedSessions()).toEqual([]);
  follower.stop();
});

test("stale leadership messages cannot demote a current leader", () => {
  const bus = new Bus(); const clock = new FakeClock();
  const coordinator = fallback(bus, clock, "a"); coordinator.start(); clock.advance(50);
  expect(coordinator.isLeader()).toBe(true);
  const sender = bus.open();
  sender.postMessage({ kind: "leader", tabId: "z", epoch: 0, leaseUntil: 10_000 });
  sender.postMessage({ kind: "heartbeat", tabId: "z", epoch: 99, leaseUntil: 0 });
  expect(coordinator.isLeader()).toBe(true);
  coordinator.stop(); sender.close();
});
test("expired leadership traffic does not add a lexical peer that delays failover", () => {
  const bus = new Bus(); const clock = new FakeClock();
  const coordinator = fallback(bus, clock, "z"); const sender = bus.open();
  coordinator.start();
  sender.postMessage({ kind: "leader", tabId: "a", epoch: 1, leaseUntil: 0 });
  sender.postMessage({ kind: "heartbeat", tabId: "a", epoch: 2, leaseUntil: -1 });
  clock.advance(50);
  expect(coordinator.isLeader()).toBe(true);
  coordinator.stop(); sender.close();
});

test("without a channel Web Locks cannot start a background poller", async () => {
  const locks = new Locks(); const first = new MultiTabCoordinator({ tabId: "a", locks, onLeaderChange: () => {}, onEvent: () => {}, onCursor: () => {}, onReset: () => {} });
  const second = new MultiTabCoordinator({ tabId: "b", locks, onLeaderChange: () => {}, onEvent: () => {}, onCursor: () => {}, onReset: () => {} });
  first.requestSession("a"); second.requestSession("b"); first.start(); second.start();
  expect(first.canCoordinate()).toBe(false); expect(second.canCoordinate()).toBe(false);
  expect(first.isLeader()).toBe(false); expect(second.isLeader()).toBe(false);
  expect(locks.requests).toBe(0);
  first.stop(); await Promise.resolve(); second.stop();
});

test("without BroadcastChannel or Web Locks no tab polls", () => {
  const coordinator = new MultiTabCoordinator({ tabId: "a", onLeaderChange: () => {}, onEvent: () => {}, onCursor: () => {}, onReset: () => {} });
  coordinator.requestSession("a"); coordinator.start();
  expect(coordinator.canCoordinate()).toBe(false);
  expect(coordinator.isLeader()).toBe(false);
  coordinator.stop();
});

test("Web Locks hello cannot elect before delayed lock acquisition", async () => {
  const bus = new Bus();
  let acquire!: () => Promise<void>;
  const locks = {
    request: async (_name: string, _options: { ifAvailable: true }, callback: (lock: Lock | null) => Promise<void>): Promise<void> => {
      acquire = async () => callback({} as Lock);
    },
  };
  const coordinator = new MultiTabCoordinator({ channel: bus.open(), tabId: "a", locks, onLeaderChange: () => {}, onEvent: () => {}, onCursor: () => {}, onReset: () => {} });
  coordinator.start();
  bus.open().postMessage({ kind: "hello", tabId: "b" });
  expect(coordinator.isLeader()).toBe(false);
  void acquire();
  await Promise.resolve();
  expect(coordinator.isLeader()).toBe(true);
  coordinator.stop();
});
