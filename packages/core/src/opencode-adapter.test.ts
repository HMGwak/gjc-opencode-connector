import { describe, expect, test } from "bun:test";
import { openCoreDatabase } from "./database";
import { OpenCodeAdapter } from "./opencode-adapter";

const session = { id: "local", ownerId: "owner-1", adapter: "opencode", remoteId: "remote", status: "active" as const, reconciliationEpoch: 0, reconciled: false, remoteRevision: null, createdAt: "", updatedAt: "" };
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });

describe("OpenCodeAdapter", () => {
  test("sends prompt_async once and accepts only 204", async () => {
    const calls: Request[] = [];
    const adapter = new OpenCodeAdapter({ baseUrl: "http://open.code", fetch: async (input, init) => { calls.push(new Request(input, init)); return response(null, 204); } });
    await adapter.prompt("a/b", "hello");
    expect(calls).toHaveLength(1); expect(calls[0]!.url).toContain("/session/a%2Fb/prompt_async");
    expect(await calls[0]!.json()).toEqual({ parts: [{ type: "text", text: "hello" }] });
    const bad = new OpenCodeAdapter({ baseUrl: "http://open.code", fetch: async () => response({}, 200) });
    await expect(bad.prompt("a", "hello")).rejects.toThrow("expected 204");
  });

  test("times out without retrying an ambiguous prompt", async () => {
    let calls = 0;
    const adapter = new OpenCodeAdapter({ baseUrl: "http://open.code", timeoutMs: 5, fetch: async (_input, init) => new Promise((_resolve, reject) => { calls++; init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); }) });
    await expect(adapter.prompt("a", "hello")).rejects.toThrow(); expect(calls).toBe(1);
  });

  test("fails closed when OpenCode lacks reconciliation evidence", async () => {
    const adapter = new OpenCodeAdapter({ baseUrl: "http://open.code", fetch: async () => response({ remote: { updatedAt: "r1" } }) });
    expect(await adapter.reconcile(session, 1)).toBeNull();
    expect(adapter.reconciliationCapabilities).toMatchObject({ terminalState: false, tombstone: false, watermark: false, fencing: false });

    const database = openCoreDatabase();
    database.createSession({ id: session.id, ownerId: "owner-1", adapter: session.adapter, remoteId: session.remoteId });
    database.setReconciliation(session.id, "unknown", 1, false, null);
    expect(() => database.acceptCommand({ id: "command", sessionId: session.id, idempotencyKey: "key", payload: { prompt: "hello" } })).toThrow("requires reconciliation");
    database.close();
  });

  test("reconnects SSE with snapshot reconciliation instead of cursors", async () => {
    let calls = 0; let reconciles = 0;
    const adapter = new OpenCodeAdapter({ baseUrl: "http://open.code", fetch: async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"x"}\n\n')); controller.close(); } }), { status: 200 }); } });
    const subscription = adapter.subscribe(() => undefined, async () => { reconciles++; if (reconciles === 1) subscription.close(); });
    await Bun.sleep(10); expect(calls).toBeGreaterThanOrEqual(1); expect(reconciles).toBe(1);
  });

  test("ignores malformed SSE JSON but reconnects after an event handler failure", async () => {
    let events = 0; let reconnects = 0;
    const adapter = new OpenCodeAdapter({ baseUrl: "http://open.code", fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: invalid\n\ndata: {"type":"x"}\n\n')); controller.close(); } }), { status: 200 }) });
    let subscription: { close(): void } | undefined;
    subscription = adapter.subscribe(() => { events++; throw new Error("handler failed"); }, async () => { reconnects++; subscription?.close(); });
    await Bun.sleep(10);
    expect(events).toBe(1);
    expect(reconnects).toBe(1);
  });
});
