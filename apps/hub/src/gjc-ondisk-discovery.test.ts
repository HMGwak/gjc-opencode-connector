import { afterEach, describe, expect, test } from "bun:test";
import { openCoreDatabase } from "@planee/core";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GjcOnDiskDiscovery, type OnDiskDiscoveryDatabase } from "./gjc-ondisk-discovery";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function fakeDatabase() {
  const sessions = new Map<string, { id: string; controlMode: string; origin: string; transcriptStatus: string; activeProjectorVersion?: string | null; reconciliationEpoch?: number; title?: string | null; workdir?: string | null; sourceCreatedAt?: string | null; archivedAt?: string | null }>();
  const projected: unknown[] = [];
  const work: unknown[] = [];
  const events = new Map<string, Array<{ type: string; payload: unknown }>>();
  const database: OnDiskDiscoveryDatabase = {
    upsertDiscoveredSession(input) {
      const existing = sessions.get(input.remoteId);
      if (existing) {
        existing.transcriptStatus = input.transcriptStatus;
        if (input.title !== undefined) existing.title = input.title;
        if (input.workdir !== undefined) existing.workdir = input.workdir;
        if (input.sourceCreatedAt !== undefined) existing.sourceCreatedAt = input.sourceCreatedAt;
        return existing as ReturnType<OnDiskDiscoveryDatabase["upsertDiscoveredSession"]>;
      }
      const row = { id: input.id, controlMode: input.controlMode, origin: input.origin, transcriptStatus: input.transcriptStatus, title: input.title, workdir: input.workdir, sourceCreatedAt: input.sourceCreatedAt };
      sessions.set(input.remoteId, row);
      return row as ReturnType<OnDiskDiscoveryDatabase["upsertDiscoveredSession"]>;
    },
    getSessionByRemoteIdForOwner(_ownerId, _adapter, remoteId) {
      return (sessions.get(remoteId) as ReturnType<OnDiskDiscoveryDatabase["getSessionByRemoteIdForOwner"]>) ?? null;
    },
    claimView: () => true,
    projectRemoteBatch(input) {
      projected.push(input);
      events.set(input.sessionId, [...(events.get(input.sessionId) ?? []), ...input.events]);
      return input.events.length;
    },
    applyProjection(input) {
      for (const event of events.get(input.sessionId) ?? []) input.apply(event);
      return (events.get(input.sessionId) ?? []).length;
    },
    upsertWorkItem(input) { work.push(input); },
    listProjectionFailures: () => [],
    cutoverProjectorVersion(input) {
      const session = [...sessions.values()].find((value) => value.id === input.sessionId);
      if (!session || session.archivedAt || (session.activeProjectorVersion ?? null) !== input.expectedCurrentVersion || (session.reconciliationEpoch ?? 0) !== (input.expectedReconciliationEpoch ?? 0)) return false;
      work.push(...input.workItems);
      session.activeProjectorVersion = input.projectorVersion;
      session.reconciliationEpoch = (session.reconciliationEpoch ?? 0) + 1;
      return true;
    },
  };
  return { database, sessions, projected, work };
}

async function storeFile(content: string): Promise<{ root: string; id: string }> {
  const root = await mkdtemp(join(tmpdir(), "gjc-discovery-"));
  roots.push(root);
  const directory = join(root, "sessions", "-repo");
  await mkdir(directory, { recursive: true });
  const id = "12345678-1234-1234-1234-123456789abc";
  await writeFile(join(directory, `2026-07-16T10:00:00.000Z_${id}.jsonl`), content);
  return { root, id };
}

describe("GjcOnDiskDiscovery", () => {
  test("lists and projects top-level GJC transcript entries as view-only", async () => {
    const { root, id } = await storeFile([
      JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: "2026-07-16T10:00:01.000Z", message: { role: "user", content: "hello" } }),
      "",
    ].join("\n"));
    const state = fakeDatabase();
    expect(await new GjcOnDiskDiscovery({ database: state.database, ownerId: "owner", codingAgentDir: root }).synchronize()).toBe(1);
    expect(state.sessions.get(id)).toMatchObject({ controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "available", title: "repo · 12345678", workdir: "/repo", sourceCreatedAt: "2026-07-16T10:00:00.000Z" });
    expect(state.projected).toHaveLength(1);
    expect(state.projected[0]).toMatchObject({ mode: "view", source: "gjc-ondisk", cursor: "2", events: [{ sourceEventId: "entry-1#2", sourcePosition: 2 }] });
  });
  test("uses a safe header title and falls back when it is unsafe", async () => {
    const titled = await storeFile(JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/workspace/project", title: "  Fix   mobile sessions  " }) + "\n");
    const titledState = fakeDatabase();
    await new GjcOnDiskDiscovery({ database: titledState.database, ownerId: "owner", codingAgentDir: titled.root }).synchronize();
    expect(titledState.sessions.get(titled.id)).toMatchObject({ title: "Fix mobile sessions" });

    const fallback = await storeFile(JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/workspace/project", title: "\u0000unsafe" }) + "\n");
    const fallbackState = fakeDatabase();
    await new GjcOnDiskDiscovery({ database: fallbackState.database, ownerId: "owner", codingAgentDir: fallback.root }).synchronize();
    expect(fallbackState.sessions.get(fallback.id)).toMatchObject({ title: "project · 12345678" });
  });

  test("projects a sanitized transcript carrying token/usage metadata without tripping the secret guard", async () => {
    const { root } = await storeFile([
      JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-07-16T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }, { type: "toolCall", name: "bash", arguments: { cmd: "ls" } }], usage: { totalTokens: 42, inputTokens: 10 } } }),
      "",
    ].join("\n"));
    const database = openCoreDatabase(join(root, "hub.sqlite"));
    try {
      expect(await new GjcOnDiskDiscovery({ database, ownerId: "owner", codingAgentDir: root }).synchronize()).toBe(1);
      const session = database.listSessionsForOwner("owner")[0]!;
      expect(session.transcriptStatus).toBe("available");
      const message = (database.listEvents(session.id) as Array<{ type: string; payload: unknown }>).find((event) => event.type === "gjc.message");
      expect(message?.payload).toEqual({ type: "message", role: "assistant", text: "done\n[tool: bash]", sourceEventId: "m1#2" });
    } finally {
      database.close();
    }
  });
  test("replays recognized requests and completions into work and an owner outbox without projecting noise", async () => {
    const { root, id } = await storeFile([
      JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "request", timestamp: "2026-07-16T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Fix discovery replay" }] } }),
      JSON.stringify({ type: "message", id: "noise", parentId: "request", timestamp: "2026-07-16T10:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", text: "working" }] } }),
      JSON.stringify({ type: "message", id: "result", parentId: "request", timestamp: "2026-07-16T10:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "Replay fixed." }] } }),
      "",
    ].join("\n"));
    const database = openCoreDatabase(join(root, "hub.sqlite"));
    try {
      const discovery = new GjcOnDiskDiscovery({ database, ownerId: "owner", codingAgentDir: root });
      await discovery.synchronize();
      const work = database.listWorkItemsForOwner<{ result: string }>("owner");
      expect(work).toHaveLength(1);
      expect(work[0]).toMatchObject({ state: "done", remoteId: "gjc-user:request#2", projectorVersion: "gjc-ondisk-v1", payload: { result: "Replay fixed." } });
      expect(database.listSessionsForOwner("owner")[0]?.activeProjectorVersion).toBe("gjc-ondisk-v1");
      expect((database.listSseAfter("owner", 0) as Array<{ event: { type: string } }>).filter((entry) => entry.event.type === "work-item.upserted")).toHaveLength(2);
      expect(database.getProjectionCheckpoint(work[0]!.sessionId, "gjc-ondisk-v1").nextExpectedSeq).toBe(4);
      expect(database.sqlite.query("SELECT COUNT(*) AS count FROM projection_effects WHERE session_id = ? AND projector_version = ?").get(work[0]!.sessionId, "gjc-ondisk-v1")).toEqual({ count: 3 });
      await discovery.synchronize();
      expect(database.getProjectionCheckpoint(work[0]!.sessionId, "gjc-ondisk-v1").nextExpectedSeq).toBe(4);
      expect(database.sqlite.query("SELECT COUNT(*) AS count FROM projection_effects WHERE session_id = ? AND projector_version = ?").get(work[0]!.sessionId, "gjc-ondisk-v1")).toEqual({ count: 3 });
      await appendFile(join(root, "sessions", "-repo", `2026-07-16T10:00:00.000Z_${id}.jsonl`), `${JSON.stringify({ type: "message", id: "later-noise", timestamp: "2026-07-16T10:00:04.000Z", message: { role: "assistant", content: [{ type: "thinking", text: "still working" }] } })}\n`);
      await discovery.synchronize();
      expect((database.listSseAfter("owner", 0) as Array<{ event: { type: string } }>).filter((entry) => entry.event.type === "work-item.upserted")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  test("keeps an unreadable transcript listed and projects nothing", async () => {
    const { root, id } = await storeFile("{not-json}\n");
    const state = fakeDatabase();
    expect(await new GjcOnDiskDiscovery({ database: state.database, ownerId: "owner", codingAgentDir: root }).synchronize()).toBe(1);
    expect(state.sessions.get(id)).toMatchObject({ controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "unreadable" });
    expect(state.projected).toHaveLength(0);
  });
  test("fails closed when the work fold throws", async () => {
    const { root, id } = await storeFile([
      JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "request", timestamp: "2026-07-16T10:00:01.000Z", message: { role: "user", content: "Fail closed" } }),
      "",
    ].join("\n"));
    const core = openCoreDatabase(join(root, "hub.sqlite"));
    const database: OnDiskDiscoveryDatabase = {
      upsertDiscoveredSession: core.upsertDiscoveredSession.bind(core),
      getSessionByRemoteIdForOwner: core.getSessionByRemoteIdForOwner.bind(core),
      claimView: core.claimView.bind(core),
      projectRemoteBatch: core.projectRemoteBatch.bind(core),
      applyProjection: core.applyProjection.bind(core),
      upsertWorkItem: () => { throw new Error("work fold failed"); },
      listProjectionFailures: core.listProjectionFailures.bind(core),
      cutoverProjectorVersion: core.cutoverProjectorVersion.bind(core),
    };
    try {
      await new GjcOnDiskDiscovery({ database, ownerId: "owner", codingAgentDir: root }).synchronize();
      const session = core.getSessionByRemoteIdForOwner("owner", "gjc", id)!;
      expect(session).toMatchObject({ transcriptStatus: "unreadable", activeProjectorVersion: null });
      expect(core.getProjectionCheckpoint(session.id, "gjc-ondisk-v1").nextExpectedSeq).toBe(1);
      expect(core.sqlite.query("SELECT COUNT(*) AS count FROM projection_effects WHERE session_id = ? AND projector_version = ?").get(session.id, "gjc-ondisk-v1")).toEqual({ count: 0 });
      expect(core.sqlite.query("SELECT COUNT(*) AS count FROM work_items WHERE session_id = ? AND projector_version = ?").get(session.id, "gjc-ondisk-v1")).toEqual({ count: 0 });
    } finally {
      core.close();
    }
  });
  test("does not downgrade a newer active projector version", async () => {
    const { root, id } = await storeFile([
      JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "request", timestamp: "2026-07-16T10:00:01.000Z", message: { role: "user", content: "Keep newer projector" } }),
      "",
    ].join("\n"));
    const state = fakeDatabase();
    state.sessions.set(id, {
      id: "local",
      controlMode: "view-only",
      origin: "ondisk-discovery",
      transcriptStatus: "available",
      activeProjectorVersion: "gjc-ondisk-v2",
    });

    await new GjcOnDiskDiscovery({ database: state.database, ownerId: "owner", codingAgentDir: root }).synchronize();

    expect(state.sessions.get(id)?.activeProjectorVersion).toBe("gjc-ondisk-v2");
    expect(state.work).toHaveLength(0);
  });

  test("rediscovery does not request control-mode or origin updates", async () => {
    const { root, id } = await storeFile(JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }) + "\n");
    const state = fakeDatabase();
    state.sessions.set(id, { id: "local", controlMode: "controlled", origin: "coordinator-resume", transcriptStatus: "available" });
    await new GjcOnDiskDiscovery({ database: state.database, ownerId: "owner", codingAgentDir: root }).synchronize();
    expect(state.sessions.get(id)).toMatchObject({ controlMode: "controlled", origin: "coordinator-resume" });
  });
  test("skips archived remote sessions before transcript work", async () => {
    const { root, id } = await storeFile("{not-json}\n");
    const state = fakeDatabase();
    state.sessions.set(id, { id: "archived", controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "available", archivedAt: "2026-07-16T10:00:00.000Z" });
    expect(await new GjcOnDiskDiscovery({ database: state.database, ownerId: "owner", codingAgentDir: root }).synchronize()).toBe(1);
    expect(state.sessions.get(id)).toMatchObject({ transcriptStatus: "available", archivedAt: "2026-07-16T10:00:00.000Z" });
    expect(state.projected).toHaveLength(0);
  });

  test("retries an unchanged transcript after a projector cutover CAS miss", async () => {
    const { root, id } = await storeFile([
      JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "request", timestamp: "2026-07-16T10:00:01.000Z", message: { role: "user", content: "Retry cutover" } }),
      "",
    ].join("\n"));
    const state = fakeDatabase();
    const cutover = state.database.cutoverProjectorVersion;
    let cutoverCalls = 0;
    state.database.cutoverProjectorVersion = (input) => {
      cutoverCalls++;
      if (cutoverCalls === 1) {
        const session = state.sessions.get(id)!;
        session.activeProjectorVersion = "legacy";
        session.reconciliationEpoch = 7;
        return false;
      }
      return cutover(input);
    };
    const discovery = new GjcOnDiskDiscovery({ database: state.database, ownerId: "owner", codingAgentDir: root });

    await discovery.synchronize();
    expect(cutoverCalls).toBe(1);
    expect(state.sessions.get(id)?.transcriptStatus).toBe("available");
    expect(state.projected).toHaveLength(1);

    await discovery.synchronize();
    expect(cutoverCalls).toBe(2);
    expect(state.sessions.get(id)?.activeProjectorVersion).toBe("gjc-ondisk-v1");
    expect(state.projected).toHaveLength(2);

    await discovery.synchronize();
    expect(cutoverCalls).toBe(2);
    expect(state.projected).toHaveLength(2);
  });
  test("skips re-parsing and re-projecting unchanged session files on resync", async () => {
    const { root } = await storeFile([
      JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "entry-1", timestamp: "2026-07-16T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      "",
    ].join("\n"));
    const state = fakeDatabase();
    const discovery = new GjcOnDiskDiscovery({ database: state.database, ownerId: "owner", codingAgentDir: root });
    await discovery.synchronize();
    await discovery.synchronize();
    expect(state.projected).toHaveLength(1);
  });
  test("deduplicates projection and preserves a promoted session", async () => {
    const { root, id } = await storeFile([
      JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: "2026-07-16T10:00:01.000Z", message: { role: "user", content: "hello" } }),
      "",
    ].join("\n"));
    const database = openCoreDatabase();
    const discovery = new GjcOnDiskDiscovery({ database, ownerId: "owner", codingAgentDir: root, viewOwner: "view-1" });
    await discovery.synchronize();
    await discovery.synchronize();
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
    database.sqlite.query("UPDATE sessions SET control_mode = 'controlled', origin = 'coordinator-resume' WHERE remote_id = ?").run(id);
    await discovery.synchronize();
    expect(database.listSessionsForOwner("owner")[0]).toMatchObject({
      controlMode: "controlled",
      origin: "coordinator-resume",
      transcriptStatus: "available",
    });
    database.close();
  });
});
