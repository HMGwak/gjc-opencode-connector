import { afterEach, describe, expect, test } from "bun:test";
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
    expect(state.projected[0]).toMatchObject({ mode: "view", source: "gjc-ondisk", cursor: "2", events: [{ sourceEventId: "entry-1", sourcePosition: 2 }] });
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
});
