import { expect, test } from "bun:test";
import { canNavigateBack, denseRowDescriptor, historySections, inboxRowDescriptor, isDeliberateArchiveSwipe, rootSessionSections, SESSION_ARCHIVE_LONG_PRESS_MS, SESSION_ARCHIVE_SWIPE_DISTANCE_PX, sessionSections, workAccordionDescriptor, workSessionGroups } from "./view-model";

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
        history: { state: null, replaceState: () => {}, pushState: () => {}, back: () => {} },
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

  expect(await initialTab("work")).toBe("sessions");
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
        history: { state: null, replaceState: () => {}, pushState: () => {}, back: () => {} },
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

  tab(await boot(), "sessions").click();
  expect(values.get("planee-agent-hub:default-tab")).toBe("sessions");
  expect(tab(await boot(), "sessions").attributes["aria-current"]).toBe("page");

  tab(await boot(), "history").click();
  expect(values.get("planee-agent-hub:default-tab")).toBe("history");
  expect(tab(await boot(), "history").attributes["aria-current"]).toBe("page");

  storageUnavailable = true;
  const unavailableApp = await boot();
  tab(unavailableApp, "sessions").click();
  expect(tab(unavailableApp, "sessions").attributes["aria-current"]).toBe("page");
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

test("groups History into local-date sections and omits empty groups", () => {
  const dates = new Map([
    ["2026-07-17T01:00:00Z", "Friday, July 17, 2026"],
    ["2026-07-16T23:00:00Z", "Thursday, July 16, 2026"],
  ]);
  const sections = historySections(
    [
      { id: "a", updatedAt: "2026-07-17T01:00:00Z" },
      { id: "b", updatedAt: "2026-07-17T01:00:00Z" },
      { id: "c", updatedAt: "2026-07-16T23:00:00Z" },
    ],
    (value) => dates.get(value)!,
  );

  expect(sections.map((section) => [section.heading, section.items.map((item) => item.id)])).toEqual([
    ["Friday, July 17, 2026", ["a", "b"]],
    ["Thursday, July 16, 2026", ["c"]],
  ]);
  expect(historySections([], (value) => value)).toEqual([]);
  expect(source).toContain('back.addEventListener("click", navigateBack);');
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
  expect(source).toContain('const status = element("p", "Loading sessions…");');
  expect(source).toContain('status.className = "surface-state";');
  expect(source).toContain("panel.append(status);");
  expect(source).toContain('"No open approvals or failures."');
  expect(source).toContain('"No active runtime sessions."');
  expect(source).toContain('"No archived sessions."');
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
test("keeps workflow projections separate and renders session-owned work", () => {
  expect(source).toContain('load("/sessions")');
  expect(source).toContain('load("/work?scope=active")');
  expect(source).toContain('load("/hitl")');
  expect(source).toContain('load("/history")');
  expect(source).toContain("Promise.allSettled");
  expect(source).toContain("function isWorkItem(value: unknown): value is WorkItem");
  expect(source).toContain("type HitlAction = PendingAction & { rootSessionId?: string };");
  expect(source).toContain("parseActions({ actions: [action] }, (action as { sessionId: string }).sessionId)");
  expect(source).toContain("return parsed.map((item) => ({ ...item, rootSessionId }));");
  expect(source).toContain("const pendingActions = hitlActions.filter");
  expect(source).toContain("function appendWorkAccordion");
  expect(source).toContain("workSessionGroups(workItems, sessions)");
});
test("describes dense navigation rows as one accessible interactive control", () => {
  expect(denseRowDescriptor("stale", true)).toEqual({
    element: "button",
    type: "button",
    interactiveControls: 1,
    statusText: "Status: Stale",
    pressed: true,
  });
  expect(denseRowDescriptor("active", false).statusText).toBe("Status: active");
});

test("keeps Inbox action and View session controls as siblings", () => {
  const row = inboxRowDescriptor(true);
  expect(row).toEqual({
    element: "li",
    children: [
      { element: "action" },
      { element: "button", type: "button", label: "View session" },
    ],
  });
  expect(row.children[0]).not.toHaveProperty("children");
  expect(inboxRowDescriptor(false).children).toEqual([{ element: "action" }]);
});

test("groups only root Sessions by intervention priority and omits empty sections", () => {
  const sections = rootSessionSections([
    { id: "needs", rootSessionId: "needs", actionableCount: 2 },
    { id: "recent", rootSessionId: "recent", actionableCount: 0 },
    { id: "internal", rootSessionId: "needs", actionableCount: 3 },
  ]);
  expect(sections.map((section) => [section.heading, section.items.map((item) => item.id)])).toEqual([
    ["Needs your input", ["needs"]],
    ["Recently active", ["recent"]],
  ]);
  expect(sessionSections([{ id: "only", actionableCount: 1 }])).toEqual([
    { heading: "Needs your input", items: [{ id: "only", actionableCount: 1 }] },
  ]);
  expect(rootSessionSections([])).toEqual([]);
});

test("keeps Inbox as a bordered list rather than rounded action cards", () => {
  const inboxListStyles = styles.slice(styles.indexOf(".inbox-list"), styles.indexOf(".inbox-action"));
  const inboxActionStyles = styles.slice(styles.indexOf(".inbox-action {"), styles.indexOf(".inbox-action > button"));
  const actionCardStyles = styles.slice(styles.indexOf(".action-card {"), styles.indexOf(".action-card h3"));
  expect(inboxListStyles).toContain(".inbox-list { border-top: 1px solid var(--color-border); }");
  expect(inboxActionStyles).toContain(".inbox-action { display: grid;");
  expect(inboxActionStyles).not.toContain("border-radius");
  expect(actionCardStyles).not.toContain("border");
  expect(actionCardStyles).not.toContain("border-radius");
});

test("consumes additive hierarchy fields and exposes internal activity only as rollups and drill-down", () => {
  expect(source).toContain("rootSessionId?: string;");
  expect(source).toContain("internalCount?: number;");
  expect(source).toContain("actionableCount?: number;");
  expect(source).toContain("lastActivityAt?: string;");
  expect(source).toContain("action.rootSessionId ?? action.sessionId");
  expect(source).toContain("workSessionGroups(workItems, sessions)");
  expect(source).toContain("if (session.internalCount) detail.append(renderInternalDisclosure(session));");
  expect(source).toContain("`/sessions/${encodeURIComponent(sessionId)}/internal`");
  expect(source).toContain('disclosure.className = "internal-disclosure";');
  expect(source).toContain('"Loading internal activity…"');
  expect(source).toContain('"No internal activity details are available."');
  expect(source).toContain('error.setAttribute("role", "alert");');
});
test("groups work under root-session accordions without duplicating server state policy", () => {
  const sessions = [
    { id: "session-a", rootSessionId: "session-a", title: "Planning", adapter: "agent" },
    { id: "internal", rootSessionId: "session-a", title: "Internal", adapter: "agent" },
  ];
  const work = [
    { id: "open", sessionId: "session-a", state: "active" },
    { id: "queued", sessionId: "internal", rootSessionId: "session-a", state: "queued" },
    { id: "lost", sessionId: "missing", state: "failed" },
  ];
  expect(workSessionGroups(work, sessions)).toEqual([
    { rootSessionId: "session-a", title: "Planning", items: [work[0], work[1]], unassigned: false },
    { rootSessionId: null, title: "Unassigned", items: [work[2]], unassigned: true },
  ]);
  expect(workAccordionDescriptor("Planning", 2)).toEqual({ element: "details", summary: "Planning (2)", expanded: false });
});
test("keeps app back navigation in-app until the root tab without a detail", () => {
  expect(canNavigateBack({ index: 2, sessionId: null })).toBe(true);
  expect(canNavigateBack({ index: 0, sessionId: "session-a" })).toBe(true);
  expect(canNavigateBack({ index: 0, sessionId: null })).toBe(false);
  expect(source).toContain('window.addEventListener("popstate", () => {');
  expect(source).toContain('void App.exitApp();');
});
test("creates a Sessions origin for deep links and replaces archived detail history", () => {
  expect(source).toContain('selectedSessionOrigin = "sessions";');
  expect(source).toContain("selectedSessionId = deepLinkedSession;");
  expect(source).toContain("saveNavigation();");
  expect(source).toContain('activeTab = "history";\n    saveNavigation(true);');
  expect(source).toContain("saveNavigation(true, sessionlessUrl());");
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
  expect(source).toContain("function selectSession(session: Session, origin: SessionOrigin = activeTab): void");
  expect(source).toContain("selectedSessionOrigin = origin;\n  activeTab = origin;");
  expect(source).toContain('back.addEventListener("click", navigateBack);');
  expect(source).toContain("function navigateBack(): void");
  expect(source).toContain('activeTab = "history";');
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
  expect(calls).toEqual(["/api/v1/sessions", "/api/v1/work?scope=active", "/api/v1/hitl", "/api/v1/history"]);
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

test("exposes Inbox, Sessions, and Archive only while normalizing legacy Work", () => {
  expect(source).toContain('{ id: "inbox", label: "Inbox" }');
  expect(source).toContain('{ id: "sessions", label: "Sessions" }');
  expect(source).toContain('{ id: "history", label: "Archive" }');
  expect(source).not.toContain('{ id: "work", label: "Work" }');
  expect(source).toContain('return value === "work" ? "sessions"');
  expect(styles).toContain("grid-template-columns: repeat(3, 1fr)");
});

test("fetches only active work and groups it under authorized root sessions", () => {
  const sessions = [
    { id: "root", rootSessionId: "root", title: "Root", adapter: "agent" },
    { id: "internal", rootSessionId: "root", title: "Internal", adapter: "agent" },
  ];
  const open = { id: "open", sessionId: "internal", rootSessionId: "root", state: "active" };
  const unassigned = { id: "lost", sessionId: "missing", state: "failed" };
  expect(workSessionGroups([open, unassigned], sessions)).toEqual([
    { rootSessionId: "root", title: "Root", items: [open], unassigned: false },
    { rootSessionId: null, title: "Unassigned", items: [unassigned], unassigned: true },
  ]);
  expect(source).toContain('load("/work?scope=active")');
  expect(source).toContain('className = "dense-list work-list"');
  expect(source).not.toContain("const completedGroups");
});
test("trusts the active-work API response instead of maintaining a second client allowlist", () => {
  const sessions = [{ id: "root", rootSessionId: "root", title: "Root", adapter: "agent" }];
  const queued = { id: "queued", sessionId: "root", state: "queued" };
  expect(workSessionGroups([queued], sessions)).toEqual([
    { rootSessionId: "root", title: "Root", items: [queued], unassigned: false },
  ]);
  expect(source).not.toContain("ACTIVE_WORK_STATES");
});

test("requires deliberate gestures and explicit confirmation before archive", () => {
  expect(SESSION_ARCHIVE_LONG_PRESS_MS).toBe(550);
  expect(isDeliberateArchiveSwipe(100, 20, 100 - SESSION_ARCHIVE_SWIPE_DISTANCE_PX, 45)).toBe(true);
  expect(isDeliberateArchiveSwipe(100, 20, 37, 20)).toBe(false);
  expect(isDeliberateArchiveSwipe(100, 20, 0, 60)).toBe(false);
  expect(source).toContain("function attachArchiveGestures");
  expect(source).toContain("function renderArchiveConfirmation");
  expect(source).toContain('element("button", "Cancel")');
  expect(source).toContain('element("button", "Archive")');
  expect(source).toContain('element("button", "Open session")');
});
test("uses a modal archive confirmation that back and pointer departure can dismiss", () => {
  expect(source).toContain('document.createElement("dialog")');
  expect(source).toContain("dialog.showModal()");
  expect(source).toContain('dialog.addEventListener("cancel"');
  expect(source).toContain("if (archiveConfirmation)");
  expect(source).toContain('row.addEventListener("pointerleave"');
  expect(styles).toContain(".archive-confirmation::backdrop");
});

test("uses in-app history before explicit Android root-exit confirmation", () => {
  expect(canNavigateBack({ index: 1, sessionId: null })).toBe(true);
  expect(canNavigateBack({ index: 0, sessionId: "session" })).toBe(true);
  expect(canNavigateBack({ index: 0, sessionId: null })).toBe(false);
  expect(source).toContain("if (exitDialogOpen) return;");
  expect(source).toContain("void Dialog.confirm({");
  expect(source).toContain('okButtonTitle: "Exit"');
  expect(source).toContain('cancelButtonTitle: "Cancel"');
  expect(source).toContain("if (value) void App.exitApp();");
});
