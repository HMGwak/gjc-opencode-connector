import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./app.ts", import.meta.url)).text();

test("consumes the hub sessions envelope", () => {
  expect(source).toContain('(body as { sessions: unknown[] }).sessions.filter(isSession)');
  expect(source).not.toContain("Array.isArray(body) ? body.filter(isSession)");
});

test("uses a six-digit numeric pairing input", () => {
  expect(source).toContain('code.inputMode = "numeric";');
  expect(source).toContain('code.maxLength = 6;');
  expect(source).toContain('/^\\d{6}$/.test(code)');
});

test("reuses an idempotency key when retrying the same prompt", () => {
  expect(source).toContain("let pendingPrompt: { sessionId: string; prompt: string; key: string } | null = null;");
  expect(source).toContain("pendingPrompt?.sessionId === sessionId && pendingPrompt.prompt === prompt");
  expect(source).toContain('"Idempotency-Key": retry.key');
  expect(source).toContain('input.addEventListener("input"');
  expect(source).toContain("input.value.trim() !== pendingPrompt.prompt");
  expect(source).toContain("if (pendingPrompt?.key === retry.key) pendingPrompt = null;");
});

test("catches up each session using its own cursor", () => {
  expect(source).toContain('`cursor:${sessionId}`');
  expect(source).toContain('`/sessions/${encodeURIComponent(sessionId)}/events${cursor === null ? "" : `?after=${encodeURIComponent(String(cursor))}`}`');
  expect(source).toContain("window.setTimeout(() => void pollUpdates(generation), POLL_INTERVAL)");
  expect(source).not.toContain("/events/stream");
});

test("does not render asynchronous events for a newly selected session", () => {
  expect(source).toContain("if (sessionId !== selectedSessionId) return;");
  expect(source).toContain("if (!isHubEvent(value) || value.sessionId !== sessionId) return;");
  expect(source).not.toContain("render(); loadMessages(session.id)");
});
test("polling preserves a typed prompt by updating status without rendering the app", () => {
  const poll = source.slice(source.indexOf("async function pollUpdates"), source.indexOf('window.addEventListener("online"'));
  expect(poll).toContain("multiTab.requestedSessions()");
  expect(poll).toContain("await catchUp(sessionId, sessionId === selectedSessionId)");
  expect(poll).toContain("updateConnectionStatus();");
  expect(poll).not.toContain("render();");
  expect(source).toContain('indicator.setAttribute("aria-live", "polite");');
  expect(source).not.toContain('id="app" aria-live');
});
test("serializes catch-up requests per session", () => {
  expect(source).toContain("const catchUpLocks = new Map<string, Promise<boolean>>();");
  expect(source).toContain("const previous = catchUpLocks.get(sessionId) ?? Promise.resolve(true);");
  expect(source).toContain(".then(() => catchUpOnce(sessionId, renderMessages))");
  expect(source).toContain("if (catchUpLocks.get(sessionId) === current) catchUpLocks.delete(sessionId);");
});

test("publishes install metadata through the document manifest link", async () => {
  const index = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
});
test("renders the selected-session actions surface through the safe actions module", () => {
  expect(source).toContain('import { renderActions as renderSessionActions } from "./actions";');
  expect(source).toContain("renderSessionActions(panel, selectedSessionId, api);");
  expect(source).not.toContain("innerHTML");
});
test("requests notification permission only from the settings button and revokes subscriptions safely", async () => {
  const push = await Bun.file(new URL("./push.ts", import.meta.url)).text();
  expect(source).toContain('push.addEventListener("click", () => void configurePush(push));');
  expect(push).toContain("const permission = await Notification.requestPermission();");
  expect(push).toContain('await revokePush(api);');
  expect(push).toContain('method: "DELETE"');
  expect(push).toContain('cache: "no-store"');
});

test("service worker uses only a safe same-origin deep link and bypasses API cache", async () => {
  const worker = await Bun.file(new URL("../public/sw.js", import.meta.url)).text();
  expect(worker).toContain('url.pathname.startsWith("/api/")');
  expect(worker).toContain('url.origin !== self.location.origin');
  expect(worker).toContain('/^\\/(sessions|actions|settings)(\\/|$)/');
  expect(worker).toContain("data?.deepLink");
  expect(worker).toContain('self.addEventListener("notificationclick"');
  expect(worker).not.toContain("prompt");
  expect(worker).not.toContain("output");
});
test("coordinates polling and event cursors across browser tabs", () => {
  expect(source).toContain('new BroadcastChannel("planee-agent-hub")');
  expect(source).toContain("locks: navigator.locks");
  expect(source).toContain("if (!online || !multiTab.canCoordinate() || !multiTab.isLeader()) return;");
  expect(source).toContain("multiTab.publishEvent(sessionId, value, value.seq);");
  expect(source).toContain("store.put(Math.max(previous, cursor), `cursor:${sessionId}`);");
  expect(source).toContain("multiTab.start();");
});
test("followers do not fetch when rendering a conversation and leaders poll every requested session", () => {
  expect(source).toContain("multiTab.requestSession(selectedSessionId);");
  expect(source).toContain("if (!multiTab.canCoordinate() || !multiTab.isLeader()) return false;");
  expect(source).toContain("for (const sessionId of multiTab.requestedSessions())");
  expect(source).toContain("multiTab.releaseSession(selectedSessionId);");
});
test("app network guard prevents event fetches when coordination has no polling capability", async () => {
  class Node {
    dataset: Record<string, string> = {};
    className = ""; id = ""; textContent: string | null = null;
    append(..._nodes: unknown[]): void {}
    appendChild(_node: unknown): void {}
    after(_node: unknown): void {}
    replaceChildren(..._nodes: unknown[]): void {}
    setAttribute(_name: string, _value: string): void {}
    addEventListener(_name: string, _listener: unknown): void {}
    remove(): void {}
  }
  const app = new Node();
  const calls: string[] = [];
  Object.assign(globalThis, {
    document: { cookie: "", querySelector: (selector: string) => selector === "#app" ? app : null, createElement: () => new Node() },
    navigator: { onLine: true },
    window: {
      addEventListener: () => {}, clearTimeout: () => {}, setTimeout,
      Capacitor: { Plugins: { SecureCredential: { get: async () => ({ credential: "x".repeat(43) }), set: async () => {}, clear: async () => {} } } },
    },
    BroadcastChannel: undefined,
    indexedDB: { open: () => ({ result: {}, onupgradeneeded: null, onsuccess: null, onerror: null }) },
    fetch: async (input: string) => {
      calls.push(input);
      return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await import(`./app.ts?network-guard=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual(["/api/v1/sessions"]);
});
test("shows an explicit manual-refresh status without BroadcastChannel", () => {
  expect(source).toContain('if (!multiTab.canCoordinate()) return "Degraded — single-tab mode; refresh manually";');
  expect(source).toContain("if (!multiTab.canCoordinate() || !multiTab.isLeader()) return false;");
});
