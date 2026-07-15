import { describe, expect, test } from "bun:test";
import { GjcAdapter, GjcAmbiguousMutationError } from "./gjc-adapter";

const session = { id: "local", ownerId: "owner-1", adapter: "gjc", remoteId: "s1", status: "active" as const, reconciliationEpoch: 0, reconciled: false, remoteRevision: null, createdAt: "", updatedAt: "" };
const events = (items: readonly unknown[]): AsyncIterable<unknown> => ({ async *[Symbol.asyncIterator]() { yield* items; } });
const client = (overrides: Partial<ConstructorParameters<typeof GjcAdapter>[0]["client"]> = {}) => ({
  watchEvents: (_input: unknown) => events([]),
  readTurn: async (_input: unknown) => ({ session_id: "s1", turn_id: "t1", status: "completed", updated_at: "2026-07-15T00:00:00Z" }),
  listQuestions: async (_input: unknown) => ({ questions: [] }),
  stopSession: async (_input: unknown) => ({ stopped: true }),
  ...overrides,
});
const adapter = (overrides: Partial<ConstructorParameters<typeof GjcAdapter>[0]> = {}) => new GjcAdapter({ client: client(), workdir: "/workspace/project", workdirRoots: ["/workspace"], ...overrides });

describe("GjcAdapter", () => {
  test("reconnects watch acceleration through authoritative turn and question polling", async () => {
    const calls: string[] = []; let subscription: { close(): void } | undefined;
    const instance = adapter({ client: client({ watchEvents: () => events([{ type: "turn_end", status: "completed" }]), readTurn: async () => { calls.push("turn"); return { session_id: "s1", turn_id: "t1", status: "completed", updated_at: "r1" }; }, listQuestions: async () => { calls.push("questions"); return { questions: [{ id: "q1", status: "pending" }] }; } }) });
    subscription = instance.subscribe("s1", "t1", (event) => calls.push(`hint:${event.type}`), async (snapshot) => { calls.push(`snapshot:${snapshot.turn.status}:${snapshot.questions.length}`); subscription?.close(); });
    await Bun.sleep(10);
    expect(calls).toEqual(["hint:turn_end", "turn", "questions", "snapshot:completed:1"]);
  });

  test("does not let event hints overwrite Coordinator reconciliation", async () => {
    const instance = adapter({ client: client({ readTurn: async () => ({ session_id: "s1", turn_id: "t1", status: "active", updated_at: "r2" }) }) });
    expect(await instance.reconcile(session, 1)).toMatchObject({ terminal: false, revision: "r2" });
  });

  test("rejects workdirs outside an absolute configured root", () => {
    expect(() => adapter({ workdir: "/other/project" })).toThrow("outside configured roots");
    expect(() => adapter({ workdir: "relative" })).toThrow("outside configured roots");
  });

  test("requires both mutation gates and owner proof before stopping", async () => {
    let calls = 0;
    const disabled = adapter({ client: client({ stopSession: async () => { calls++; return { stopped: true }; } }) });
    await expect(disabled.stopSession("s1", "proof", false, true)).rejects.toThrow("not enabled");
    const enabled = adapter({ mutationEnabled: true, client: client({ stopSession: async () => { calls++; return { stopped: true }; } }) });
    await expect(enabled.stopSession("s1", "", false, true)).rejects.toThrow("owner proof");
    await expect(enabled.stopSession("s1", "proof", false, false)).rejects.toThrow("not enabled");
    await enabled.stopSession("s1", "proof", true, true);
    expect(calls).toBe(1);
  });

  test("maps ambiguous stop outcomes to unknown without retrying", async () => {
    let calls = 0;
    const instance = adapter({ mutationEnabled: true, client: client({ stopSession: async () => { calls++; throw new Error("connection lost"); } }) });
    await expect(instance.stopSession("s1", "proof", false, true)).rejects.toBeInstanceOf(GjcAmbiguousMutationError);
    expect(calls).toBe(1);
  });
});
