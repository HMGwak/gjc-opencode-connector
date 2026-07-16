import { expect, test } from "bun:test";
import { openCoreDatabase } from "@planee/core";
import { GjcCoordinatorClient, GjcSessionSynchronizer, type McpToolCaller } from "./gjc-mcp-client";

test("discovers coordinator sessions from MCP tool content and syncs only new remote ids", async () => {
  let command: string[] | undefined;
  let roots: string | undefined;
  const transport: McpToolCaller = {
    async callTool(name) {
      expect(name).toBe("gjc_coordinator_list_sessions");
      return { content: [{ type: "text", text: JSON.stringify({ sessions: [{ session_id: "remote-1" }, { session_id: "remote-2" }] }) }] };
    },
    close() {},
  };
  const client = new GjcCoordinatorClient({
    executable: "/opt/gjc/bin/gjc",
    workdirRoots: "/work/a:/work/b",
    spawn: (args, env) => { command = args; roots = env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS; return transport; },
  });
  const database = openCoreDatabase();
  database.createSession({ id: "existing", ownerId: "owner", adapter: "gjc", remoteId: "remote-1" });
  const synchronizer = new GjcSessionSynchronizer(database, "owner", client, (() => "new-session") as () => string);

  expect(await synchronizer.synchronize()).toBe(1);
  expect(command).toEqual(["/opt/gjc/bin/gjc", "mcp-serve", "coordinator"]);
  expect(roots).toBe("/work/a:/work/b");
  const sessions = database.listSessionsForOwner("owner");
  expect(sessions).toHaveLength(2);
  expect(sessions.find((session) => session.remoteId === "remote-2")).toMatchObject({ id: "new-session", adapter: "gjc", status: "active", reconciled: false });
  expect(await synchronizer.synchronize()).toBe(0);
  expect(database.listSessionsForOwner("owner")).toHaveLength(2);
  database.close();
});

test("ignores non-JSON coordinator text rather than creating guessed sessions", async () => {
  const client = new GjcCoordinatorClient({
    workdirRoots: "/work",
    spawn: () => ({ callTool: async () => ({ content: [{ type: "text", text: "coordinator unavailable" }] }), close() {} }),
  });
  const database = openCoreDatabase();
  const synchronizer = new GjcSessionSynchronizer(database, "owner", client);
  expect(await synchronizer.synchronize()).toBe(0);
  expect(database.listSessionsForOwner("owner")).toEqual([]);
  database.close();
});
