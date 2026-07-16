import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();

test("restores a persisted default tab at startup and falls back to Inbox for invalid or unavailable storage", async () => {
  class Node {
    children: Node[] = [];
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    className = "";
    id = "";
    textContent: string | null = null;
    append(...nodes: Node[]): void { this.children.push(...nodes); }
    appendChild(node: Node): void { this.children.push(node); }
    after(_node: Node): void {}
    replaceChildren(...nodes: Node[]): void { this.children = nodes; }
    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    addEventListener(_name: string, _listener: unknown): void {}
    remove(): void {}
  }

  async function initialTab(value: string | null, storageUnavailable = false): Promise<string | undefined> {
    const app = new Node();
    Object.assign(globalThis, {
      document: {
        activeElement: null,
        cookie: "",
        querySelector: (selector: string) => selector === "#app" ? app : null,
        createElement: () => new Node(),
        getElementById: () => null,
      },
      navigator: { onLine: true },
      window: {
        addEventListener: () => {},
        clearTimeout: () => {},
        setTimeout,
        location: { href: "https://hub.example/" },
        Capacitor: { Plugins: { SecureCredential: { get: async () => ({ credential: "x".repeat(43) }), set: async () => {}, clear: async () => {} } } },
      },
      localStorage: { getItem: () => {
        if (storageUnavailable) throw new Error("storage unavailable");
        return value;
      }, setItem: () => {} },
      BroadcastChannel: undefined,
      indexedDB: { open: () => ({ result: {}, onupgradeneeded: null, onsuccess: null, onerror: null }) },
      fetch: async () => new Response(JSON.stringify({ sessions: [], work: [], actions: [], history: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });

    await import(`./app.ts?default-tab=${crypto.randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const navigation = app.children[2];
    return navigation?.children.find((button) => button.attributes["aria-current"] === "page")?.dataset.tab;
  }

  expect(await initialTab("work")).toBe("work");
  expect(await initialTab("not-a-tab")).toBe("inbox");
  expect(await initialTab(null, true)).toBe("inbox");
});
test("persists bottom-tab selections across reloads and continues navigating when storage fails", async () => {
  class Node {
    children: Node[] = [];
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    listeners: Record<string, () => void> = {};
    className = "";
    id = "";
    textContent: string | null = null;
    append(...nodes: Node[]): void { this.children.push(...nodes); }
    appendChild(node: Node): void { this.children.push(node); }
    after(_node: Node): void {}
    replaceChildren(...nodes: Node[]): void { this.children = nodes; }
    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    addEventListener(name: string, listener: () => void): void { this.listeners[name] = listener; }
    remove(): void {}
    click(): void { this.listeners.click?.(); }
  }

  const values = new Map<string, string>();
  let storageUnavailable = false;
  const storage = {
    getItem(key: string): string | null {
      if (storageUnavailable) throw new Error("storage unavailable");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (storageUnavailable) throw new Error("storage unavailable");
      values.set(key, value);
    },
  };

  async function boot(): Promise<Node> {
    const app = new Node();
    Object.assign(globalThis, {
      document: {
        activeElement: null,
        cookie: "",
        querySelector: (selector: string) => selector === "#app" ? app : null,
        createElement: () => new Node(),
        getElementById: () => null,
      },
      navigator: { onLine: true },
      window: {
        addEventListener: () => {},
        clearTimeout: () => {},
        setTimeout,
        location: { href: "https://hub.example/" },
        Capacitor: { Plugins: { SecureCredential: { get: async () => ({ credential: "x".repeat(43) }), set: async () => {}, clear: async () => {} } } },
      },
      localStorage: storage,
      BroadcastChannel: undefined,
      indexedDB: { open: () => ({ result: {}, onupgradeneeded: null, onsuccess: null, onerror: null }) },
      fetch: async () => new Response(JSON.stringify({ sessions: [], work: [], actions: [], history: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    await import(`./app.ts?bottom-tab=${crypto.randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return app;
  }

  function tab(app: Node, id: string): Node {
    const navigation = app.children[2];
    const button = navigation?.children.find((candidate) => candidate.dataset.tab === id);
    if (!button) throw new Error(`Missing ${id} tab.`);
    return button;
  }

  tab(await boot(), "work").click();
  expect(values.get("planee-agent-hub:default-tab")).toBe("work");
  expect(tab(await boot(), "work").attributes["aria-current"]).toBe("page");

  tab(await boot(), "history").click();
  expect(values.get("planee-agent-hub:default-tab")).toBe("history");
  expect(tab(await boot(), "history").attributes["aria-current"]).toBe("page");

  storageUnavailable = true;
  const unavailableApp = await boot();
  tab(unavailableApp, "work").click();
  expect(tab(unavailableApp, "work").attributes["aria-current"]).toBe("page");
});
test("changes the Settings default without changing the current navigation state", () => {
  const settings = source.slice(source.indexOf("function renderSessions"), source.indexOf("function renderHistory"));
  expect(source).toContain("let defaultTab: TabId = readDefaultTab();");
  expect(settings).toContain("option.selected = defaultTab === id;");
  expect(settings).toContain('if (isTab(defaultView.value)) selectDefaultTab(defaultView.value);');
  expect(settings).not.toContain("activeTab =");
  expect(settings).not.toContain("render();");
  expect(source).toContain("const tabOptions = [");
  expect(source).toContain("for (const { id, label } of tabOptions)");
});

test("keeps History detail navigation, label, and return destination aligned", () => {
  expect(source).toContain('renderSessionList(panel, archivedSessions, "No completed or archived sessions.", "history");');
  expect(source).toContain('function renderSessionList(panel: HTMLElement, items: Session[], empty: string, origin: SessionOrigin = "sessions"): void');
  expect(source).toContain("button.addEventListener(\"click\", () => selectSession(session, origin));");
  expect(source).toContain('const back = element("button", origin === "history" ? "Back to history" : "Back to sessions");');
  expect(source).toContain("selectedSessionOrigin = null;");
  expect(styles).toContain("select:focus-visible");
  expect(styles).toContain("--color-live: #087a4b;");
});

test("renders the four mobile workflow navigation surfaces with persistent navigation", () => {
  expect(source).toContain('const tabOptions = [');
  expect(source).toContain('if (selectedSessionId) renderSelectedSession(panel);');
  expect(source).toContain('else if (activeTab === "inbox") renderInbox(panel);');
  expect(source).toContain('else if (activeTab === "history") renderHistory(panel);');
  expect(source).toContain('app.append(header, panel, navigation);');
  expect(styles).toContain('#app { height: 100dvh; min-height: 0;');
  expect(styles).toContain('.panel { min-height: 0;');
  expect(styles).toContain('grid-template-rows: auto minmax(0, 1fr) auto;');
  expect(styles).toContain('env(safe-area-inset-bottom)');
  expect(styles).toContain('.tabs button { min-width: 0; min-height: 44px;');
});

test("shows loading and empty states for each session surface", () => {
  expect(source).toContain('panel.append(element("p", "Loading sessions…"));');
  expect(source).toContain('"No open approvals or failures."');
  expect(source).toContain('"No work items."');
  expect(source).toContain('"No completed or archived sessions."');
  expect(source).toContain('error.setAttribute("role", "alert");');
});

test("renders normalized transcript entries as role-based chat bubbles", () => {
  expect(source).toContain('function normalizedMessage(value: unknown)');
  expect(source).toContain('message.className = `message message-${normalized.role}`;');
  expect(source).toContain('messages.setAttribute("aria-label", "Normalized transcript");');
  expect(source).not.toContain('JSON.stringify(value)');
});

test("makes archived sessions read-only and archives active sessions through the API", () => {
  expect(source).toContain('function isArchived(session: Session): boolean');
  expect(source).toContain('detail.append(element("p", "Archived sessions are read-only."));');
  expect(source).toContain('const archive = element("button", "Archive session");');
  expect(source).toContain('`/sessions/${encodeURIComponent(sessionId)}/archive`');
  expect(source).toContain('{ method: "POST" }');
});
test("loads Hub workflow projections, preserves HITL priority, and suppresses empty work groups", () => {
  expect(source).toContain('load("/sessions")');
  expect(source).toContain('load("/work")');
  expect(source).toContain('load("/hitl")');
  expect(source).toContain('load("/history")');
  expect(source).toContain("Promise.allSettled");
  expect(source).toContain("function isWorkItem(value: unknown): value is WorkItem");
  expect(source).toContain("type HitlAction = PendingAction;");
  expect(source).toContain('const pendingActions = hitlActions.filter');
  expect(source).toContain("for (const action of pendingActions)");
  expect(source).toContain("const card = renderAction(action, api);");
  expect(source).toContain("function workGroup(state: string)");
  expect(source).toContain('if (items.length === 0) continue;');
  expect(source).toContain('panel.append(element("h3", `${heading} (${items.length})`));');
  expect(source).not.toContain('`No ${heading.toLowerCase()} items.`');
  expect(source).toContain('"No open approvals or failures."');
  expect(source).toContain('"No work items."');
  expect(source).not.toContain('sessions.filter((session) => !isArchived(session) && (Boolean(session.hitlCount)');
  const inbox = source.slice(source.indexOf("function renderInbox"), source.indexOf("const WORK_STATE_GROUPS"));
  expect(inbox).not.toContain("renderSessionActions");
});
test("groups failed and unsupported work states truthfully", () => {
  expect(source).toContain('const WORK_STATE_GROUPS = {');
  expect(source).toContain('Failed: new Set(["failed", "error", "cancelled", "canceled"])');
  expect(source).toContain('return "Unknown";');
  expect(source).toContain('["Todo", "In progress", "Results", "Failed", "Unknown"]');
  expect(source).not.toContain('return "Results";');
});

test("reports tier-specific projection failures while retaining cached data", () => {
  expect(source).toContain('let projectionErrors: Partial<Record<"inbox" | "work" | "history", string>> = {};');
  expect(source).toContain('renderProjectionError(panel, "inbox");');
  expect(source).toContain('renderProjectionError(panel, "work");');
  expect(source).toContain('renderProjectionError(panel, "history");');
  expect(source).toContain('Showing cached ${tier} data.');
  expect(source).toContain('projectionErrors.work = fetchFailure("Unable to load work", workResult.reason);');
  expect(source).toContain('projectionErrors.inbox = fetchFailure("Unable to load inbox", hitlResult.reason);');
  expect(source).toContain('projectionErrors.history = fetchFailure("Unable to load history", historyResult.reason);');
});

test("keeps view-only and archived session controls read-only", () => {
  expect(source).toContain('if (session.controlMode === "view-only") detail.append(element("p", "This session is view-only. Prompts and session actions are unavailable."));');
  expect(source).toContain("else {\n      renderPromptForm(detail, session.id);\n      renderSessionActions(detail, session.id, api);");
  expect(source).toContain('if (isArchived(session)) {\n    detail.append(element("p", "Archived sessions are read-only."));');
});
test("keeps session detail stable across renders and releases it only on selection lifecycle actions", () => {
  expect(source).toContain("let selectedSession: Session | null = null;");
  expect(source).toContain("let selectedSessionOrigin: SessionOrigin | null = null;");
  expect(source).toContain("selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? selectedSession;");
  expect(source).not.toContain('activeTab = "inbox";\n      fetchError = "The requested session is unavailable to this device."');
  expect(source).toContain('function selectSession(session: Session, origin: SessionOrigin = "sessions"): void');
  expect(source).toContain("selectedSessionOrigin = origin;\n  activeTab = origin;");
  expect(source).toContain('const back = element("button", origin === "history" ? "Back to history" : "Back to sessions");');
  expect(source).toContain('clearSelectedSession();\n    activeTab = origin;');
  expect(source).toContain('clearSelectedSession();\n    fetchError = null;\n    activeTab = "history";');
  const detail = source.slice(source.indexOf("function renderSelectedSession"), source.indexOf("function renderPromptForm"));
  expect(detail).not.toContain("multiTab.requestSession");
  expect(source).toContain("function clearSelectedSession(): void");
  expect(source).toContain("selectedSessionOrigin = null;");
  expect(source).toContain("multiTab.releaseSession(selectedSessionId);");
});

test("isolates cursors, selected-session updates, serialized catch-up, and typed prompt retries", () => {
  expect(source).toContain('/^\\d{6}$/.test(code)');
  expect(source).toContain('"Idempotency-Key": retry.key');
  expect(source).toContain('`cursor:${sessionId}`');
  expect(source).toContain('if (sessionId !== selectedSessionId) return;');
  expect(source).toContain('const previous = catchUpLocks.get(sessionId) ?? Promise.resolve(true);');
  expect(source).toContain('.then(() => catchUpOnce(sessionId, renderMessages));');
  expect(source).toContain('if (catchUpLocks.get(sessionId) === current) catchUpLocks.delete(sessionId);');
  expect(source).toContain('const retry = pendingPrompt?.sessionId === sessionId && pendingPrompt.prompt === prompt');
  expect(source).toContain('if (pendingPrompt?.key === retry.key) pendingPrompt = null;');
  expect(source).toContain('if (sessionId === selectedSessionId) input.value = "";');
  expect(source).toContain('indicator.setAttribute("aria-live", "polite");');
  expect(source).toContain('const focusedId = typeof HTMLElement !== "undefined"');
});

test("keeps push and service-worker setup safe", () => {
  expect(source).toContain('button.disabled = true;');
  expect(source).toContain('finally {\n    button.disabled = false;');
  expect(source).toContain('if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");');
});
test("app network guard prevents catch-up fetches without coordination", async () => {
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
    document: { cookie: "", querySelector: (selector: string) => selector === "#app" ? app : null, createElement: () => new Node(), getElementById: () => null },
    navigator: { onLine: true },
    window: {
      addEventListener: () => {}, clearTimeout: () => {}, setTimeout, location: { href: "https://hub.example/" },
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
  expect(calls).toEqual(["/api/v1/sessions", "/api/v1/work", "/api/v1/hitl", "/api/v1/history"]);
});

test("keeps action controls and settings available without exposing them as primary navigation", () => {
  expect(source).toContain('renderSessionActions(detail, session.id, api);');
  expect(source).toContain('settings.append(element("summary", "Settings"));');
  expect(source).toContain('push.addEventListener("click", () => void configurePush(push));');
});

test("publishes install metadata through the document manifest link", async () => {
  const index = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
});
