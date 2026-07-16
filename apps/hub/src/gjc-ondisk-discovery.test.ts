import { afterEach, describe, expect, test } from "bun:test";
import { openCoreDatabase } from "@planee/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GjcOnDiskDiscovery, type OnDiskDiscoveryDatabase } from "./gjc-ondisk-discovery";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function fakeDatabase() {
  const sessions = new Map<string, { id: string; controlMode: string; origin: string; transcriptStatus: string }>();
  const projected: unknown[] = [];
  const database: OnDiskDiscoveryDatabase = {
    upsertDiscoveredSession(input) {
      const existing = sessions.get(input.remoteId);
      if (existing) {
        existing.transcriptStatus = input.transcriptStatus;
        return existing;
      }
      const row = { id: input.id, controlMode: input.controlMode, origin: input.origin, transcriptStatus: input.transcriptStatus };
      sessions.set(input.remoteId, row);
      return row;
    },
    claimView: () => true,
    projectRemoteBatch(input) { projected.push(input); },
  };
  return { database, sessions, projected };
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
    expect(state.sessions.get(id)).toMatchObject({ controlMode: "view-only", origin: "ondisk-discovery", transcriptStatus: "available" });
    expect(state.projected).toHaveLength(1);
    expect(state.projected[0]).toMatchObject({ mode: "view", source: "gjc-ondisk", cursor: "2", events: [{ sourceEventId: "entry-1#2", sourcePosition: 2 }] });
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
      expect(message?.payload).toEqual({ type: "message", role: "assistant", text: "done\n[tool: bash]" });
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

  test("rediscovery does not request control-mode or origin updates", async () => {
    const { root, id } = await storeFile(JSON.stringify({ type: "session", version: 3, id: "12345678-1234-1234-1234-123456789abc", timestamp: "2026-07-16T10:00:00.000Z", cwd: "/repo" }) + "\n");
    const state = fakeDatabase();
    state.sessions.set(id, { id: "local", controlMode: "controlled", origin: "coordinator-resume", transcriptStatus: "available" });
    await new GjcOnDiskDiscovery({ database: state.database, ownerId: "owner", codingAgentDir: root }).synchronize();
    expect(state.sessions.get(id)).toMatchObject({ controlMode: "controlled", origin: "coordinator-resume" });
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
