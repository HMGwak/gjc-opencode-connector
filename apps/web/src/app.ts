import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { parseActions, renderAction, renderActions as renderSessionActions, type PendingAction } from "./actions";
import { clearCredential, saveCredential, SecureCredentialUnavailableError, storedCredential } from "./credential";
import { enablePush, revokePush, revokePushWhenPermissionLost } from "./push";
import { MultiTabCoordinator } from "./multitab";
import { ACTIVE_WORK_STATES, COMPLETED_WORK_STATES, canNavigateBack, denseRowDescriptor, historySections, inboxRowDescriptor, rootSessionSections, sessionSections, workAccordionDescriptor, workSessionGroups } from "./view-model";
type SessionRollups = {
  internalCount?: number;
  actionableCount?: number;
  failureCount?: number;
  lastActivityAt?: string;
};

type Session = SessionRollups & {
  id: string;
  rootSessionId?: string;
  adapter: string;
  status: "active" | "stale" | "unknown" | "terminal";
  updatedAt: string;
  title?: string;
  workdir?: string;
  sourceCreatedAt?: string;
  archivedAt?: string | null;
  controlMode?: "view-only" | "controlled";
  hitlCount?: number;
  failureCount?: number;
  workState?: "todo" | "in-progress" | "result";
};

type WorkItem = SessionRollups & {
  id: string;
  sessionId: string;
  rootSessionId?: string;
  remoteId: string;
  state: string;
  payload: unknown;
  updatedAt: string;
};

type HitlAction = PendingAction & { rootSessionId?: string };
type InternalSessionSummary = {
  id: string;
  adapter?: string;
  kind?: string;
  status?: string;
  title?: string;
  updatedAt?: string;
};

type InternalDisclosureState = {
  status: "idle" | "loading" | "loaded" | "error";
  items: InternalSessionSummary[];
  error?: string;
};


type HubEvent = {
  seq: number;
  type: string;
  sessionId: string;
  payload: unknown;
  createdAt: string;
};

const API = "/api/v1";
const POLL_INTERVAL = 3_000;

function requiredElement(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Required element is unavailable: ${selector}`);
  return node;
}

const app = requiredElement("#app");
const DEFAULT_TAB_KEY = "planee-agent-hub:default-tab";
const tabOptions = [
  { id: "inbox", label: "Inbox" },
  { id: "work", label: "Work" },
  { id: "sessions", label: "Sessions" },
  { id: "history", label: "Archive" },
] as const;
type TabId = typeof tabOptions[number]["id"];
type SessionOrigin = TabId;
let sessions: Session[] = [];
let workItems: WorkItem[] = [];
let hitlActions: HitlAction[] = [];
let selectedSessionId: string | null = null;
let selectedSession: Session | null = null;
let selectedSessionOrigin: SessionOrigin | null = null;
let defaultTab: TabId = readDefaultTab();
let activeTab: TabId = defaultTab;
let reconnectTimer: number | undefined;
let online = navigator.onLine;
let streamConnected = false;
let loadingSessions = false;
let fetchError: string | null = null;
let projectionErrors: Partial<Record<"inbox" | "work" | "history", string>> = {};
const internalDisclosures = new Map<string, InternalDisclosureState>();
const openInternalDisclosures = new Set<string>();
let appHistoryIndex = 0;
let androidBackRegistered = false;

function isTab(value: string | null): value is TabId {
  return value !== null && tabOptions.some((option) => option.id === value);
}

function readDefaultTab(): TabId {
  let configured: string | null;
  try {
    configured = localStorage.getItem(DEFAULT_TAB_KEY);
  } catch {
    return "inbox";
  }
  return isTab(configured) ? configured : "inbox";
}

function selectDefaultTab(tab: TabId): void {
  defaultTab = tab;
  try { localStorage.setItem(DEFAULT_TAB_KEY, tab); } catch { /* Local settings are optional. */ }
}

function requestedSessionId(): string | null {
  const id = new URL(window.location.href).searchParams.get("session");
  return id?.trim() || null;
}
let pollGeneration = 0;
let pendingPrompt: { sessionId: string; prompt: string; key: string } | null = null;
let credential: string | null = null;
let pairingRequired = true;
let pairingStatus: string | null = null;
let pairingAvailable = true;
let pairingValidation: "code" | "name" | null = null;
const catchUpLocks = new Map<string, Promise<boolean>>();
const crossTabSupported = typeof BroadcastChannel !== "undefined";
const multiTab = new MultiTabCoordinator({
  channel: crossTabSupported ? new BroadcastChannel("planee-agent-hub") : undefined,
  tabId: crypto.randomUUID(),
  locks: navigator.locks,
  onLeaderChange: (leader) => {
    if (leader) reconnectUpdates();
    else {
      ++pollGeneration;
      window.clearTimeout(reconnectTimer);
      streamConnected = false;
      updateConnectionStatus();
    }
  },
  onSessionsChange: () => reconnectUpdates(),
  onEvent: (sessionId, event) => void applyBroadcastEvent(sessionId, event),
  onCursor: (sessionId, cursor) => void saveCursor(sessionId, cursor),
  onReset: (sessionId) => void saveCursor(sessionId, null),
});

const dbReady = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("planee-agent-hub", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("state");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function storedCursor(sessionId: string): Promise<number | null> {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const request = db.transaction("state", "readonly").objectStore("state").get(`cursor:${sessionId}`);
    request.onsuccess = () => resolve(typeof request.result === "number" ? request.result : null);
    request.onerror = () => reject(request.error);
  });
}

async function saveCursor(sessionId: string, cursor: number | null): Promise<void> {
  const db = await dbReady;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("state", "readwrite");
    const store = transaction.objectStore("state");
    if (cursor === null) store.put(null, `cursor:${sessionId}`);
    else {
      const request = store.get(`cursor:${sessionId}`);
      request.onsuccess = () => {
        const previous = typeof request.result === "number" ? request.result : -1;
        store.put(Math.max(previous, cursor), `cursor:${sessionId}`);
      };
      request.onerror = () => transaction.abort();
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function csrfToken(): string | null {
  return document.cookie.split("; ").find((item) => item.startsWith("csrf="))?.slice(5) ?? null;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  if (!credential) throw new Error("This device is not paired.");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${credential}`);
  const csrf = csrfToken();
  if (init.method && init.method !== "GET" && csrf) headers.set("X-CSRF-Token", decodeURIComponent(csrf));
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) void requirePairing();
  return response;
}

function fetchFailure(action: string, error: unknown): string {
  return error instanceof TypeError ? `${action}: network error.` : `${action}: ${error instanceof Error ? error.message : "unexpected error."}`;
}

function statusText(): string {
  if (!online) return "Offline — showing cached state";
  if (!multiTab.canCoordinate()) return "Degraded — single-tab mode; refresh manually";
  return streamConnected ? "Live updates connected" : "Degraded — reconnecting updates";
}
function updateConnectionStatus(): void {
  const indicator = document.querySelector<HTMLElement>("#connection-status");
  if (!indicator) return;
  indicator.textContent = statusText();
  indicator.dataset.state = online && streamConnected ? "live" : "degraded";
  const error = document.querySelector<HTMLElement>("#connection-error");
  if (fetchError) {
    if (error) error.textContent = fetchError;
    else {
      const message = element("p", fetchError);
      message.id = "connection-error";
      indicator.after(message);
    }
  } else {
    error?.remove();
  }
}

type NavigationState = { planee: true; tab: TabId; sessionId: string | null; index: number };

function navigationState(): NavigationState | null {
  const history = window.history;
  if (!history) return null;
  const state = history.state as Partial<NavigationState> | null;
  const tab = state?.tab;
  if (state?.planee !== true || !isTab(tab ?? null) || typeof state.index !== "number") return null;
  return {
    planee: true,
    tab: tab as TabId,
    sessionId: typeof state.sessionId === "string" ? state.sessionId : null,
    index: state.index,
  };
}

function saveNavigation(replace = false, url = window.location.href): void {
  const history = window.history;
  if (!history) return;
  const state: NavigationState = { planee: true, tab: activeTab, sessionId: selectedSessionId, index: replace ? appHistoryIndex : appHistoryIndex + 1 };
  appHistoryIndex = state.index;
  history[replace ? "replaceState" : "pushState"](state, "", url);
}

function sessionlessUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("session");
  return `${url.pathname}${url.search}${url.hash}`;
}

function navigateToTab(tab: TabId): void {
  clearSelectedSession();
  activeTab = tab;
  selectDefaultTab(tab);
  saveNavigation();
  render();
}

function restoreNavigation(state: NavigationState | null): void {
  clearSelectedSession();
  activeTab = state?.tab ?? defaultTab;
  appHistoryIndex = state?.index ?? 0;
  if (state?.sessionId) {
    selectedSessionId = state.sessionId;
    selectedSession = sessions.find((session) => session.id === state.sessionId) ?? null;
    selectedSessionOrigin = state.tab;
    multiTab.requestSession(state.sessionId);
  }
  render();
}

function navigateBack(): void {
  if (canNavigateBack({ sessionId: selectedSessionId, index: appHistoryIndex })) window.history.back();
}

function registerAndroidBackButton(): void {
  if (androidBackRegistered || !Capacitor.isNativePlatform()) return;
  androidBackRegistered = true;
  void App.addListener("backButton", () => {
    if (canNavigateBack({ sessionId: selectedSessionId, index: appHistoryIndex })) {
      navigateBack();
      return;
    }
    void App.exitApp();
  });
}

function render(): void {
  const focusedId = typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
  app.replaceChildren();
  if (pairingRequired) {
    renderPairing();
    return;
  }
  const header = element("header");
  header.className = "topbar";
  header.append(element("h1", "Planee Agent Hub"));
  const indicator = element("p", statusText());
  indicator.id = "connection-status";
  indicator.dataset.state = online && streamConnected ? "live" : "degraded";
  indicator.setAttribute("aria-live", "polite");
  indicator.setAttribute("aria-atomic", "true");
  header.append(indicator);
  if (fetchError) {
    const error = element("p", fetchError);
    error.id = "connection-error";
    error.setAttribute("role", "alert");
    header.append(error);
  }

  const panel = element("section");
  panel.className = "panel";
  panel.setAttribute("aria-label", `${activeTab} panel`);
  if (selectedSessionId) renderSelectedSession(panel);
  else if (activeTab === "inbox") renderInbox(panel);
  else if (activeTab === "work") renderWork(panel);
  else if (activeTab === "sessions") renderSessions(panel);
  else if (activeTab === "history") renderHistory(panel);

  const navigation = element("nav");
  navigation.className = "tabs";
  navigation.setAttribute("aria-label", "Main navigation");
  for (const { id, label } of tabOptions) {
    const button = element("button", label);
    button.type = "button";
    button.dataset.tab = id;
    button.setAttribute("aria-current", id === activeTab ? "page" : "false");
    button.addEventListener("click", () => navigateToTab(id));
    navigation.append(button);
  }
  app.append(header, panel, navigation);
  if (focusedId) document.getElementById(focusedId)?.focus();
}

function renderPairing(): void {
  const panel = element("section");
  panel.className = "pairing-screen";
  panel.append(element("h1", "Connect this device"), element("p", "Create a one-time pairing code on your Hub, then enter it here. You only need to do this once."));
  const form = element("form");
  form.className = "pairing-form";
  const codeLabel = element("label", "Pairing code");
  codeLabel.htmlFor = "pairing-code";
  const code = element("input") as HTMLInputElement;
  code.id = "pairing-code";
  code.name = "pairing-code";
  code.autocomplete = "one-time-code";
  code.inputMode = "numeric";
  code.maxLength = 6;
  code.required = true;
  code.disabled = !pairingAvailable;
  if (pairingValidation === "code") {
    code.setAttribute("aria-invalid", "true");
    code.setAttribute("aria-describedby", "pairing-status");
  }
  const nameLabel = element("label", "Device name");
  nameLabel.htmlFor = "device-name";
  const name = element("input") as HTMLInputElement;
  name.id = "device-name";
  name.name = "device-name";
  name.autocomplete = "off";
  name.maxLength = 80;
  name.required = true;
  name.value = "Personal Android";
  name.disabled = !pairingAvailable;
  if (pairingValidation === "name") {
    name.setAttribute("aria-invalid", "true");
    name.setAttribute("aria-describedby", "pairing-status");
  }
  form.noValidate = true;
  const submit = element("button", "Pair device");
  submit.type = "submit";
  submit.disabled = !pairingAvailable;
  const status = element("p", pairingStatus ?? "");
  status.id = "pairing-status";
  status.className = "pairing-status";
  status.setAttribute("aria-live", "polite");
  form.append(codeLabel, code, nameLabel, name, submit, status);
  form.addEventListener("submit", (event) => void submitPairing(event, code, name, submit));
  panel.append(form);
  app.append(panel);
  if (typeof code.focus === "function") code.focus();
}

async function submitPairing(event: SubmitEvent, codeInput: HTMLInputElement, nameInput: HTMLInputElement, submit: HTMLButtonElement): Promise<void> {
  event.preventDefault();
  const code = codeInput.value.trim();
  const deviceName = nameInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    pairingValidation = "code";
    pairingStatus = "Enter the 6-digit pairing code.";
    render();
    return;
  }
  if (!deviceName) {
    pairingValidation = "name";
    pairingStatus = "Enter a name for this device.";
    render();
    return;
  }
  pairingValidation = null;
  submit.disabled = true;
  pairingStatus = "Pairing this device…";
  try {
    const response = await fetch(`${API}/pairings/redeem`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ code, deviceName }), cache: "no-store" });
    if (response.status === 401) {
      pairingStatus = "That code is invalid, expired, or has already been used.";
      render();
      return;
    }
    if (!response.ok) throw new Error(`pairing request failed (${response.status})`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || typeof (body as { credential?: unknown }).credential !== "string") throw new Error("invalid pairing response");
    credential = (body as { credential: string }).credential;
    await saveCredential(credential);
    pairingRequired = false;
    pairingStatus = null;
    render();
    multiTab.start();
    reconnectUpdates();
  } catch (error) {
    if (error instanceof SecureCredentialUnavailableError) {
      pairingAvailable = false;
      pairingStatus = "This app requires Android secure storage to keep its device credential.";
    } else pairingStatus = error instanceof TypeError ? "Network error. Check your connection and try again." : "Unable to pair this device. Try a new pairing code.";
    render();
  }
}

async function requirePairing(): Promise<void> {
  if (pairingRequired) return;
  clearSelectedSession();
  credential = null;
  pairingRequired = true;
  pairingStatus = "This device is no longer authorized. Create a new pairing code to reconnect.";
  ++pollGeneration;
  window.clearTimeout(reconnectTimer);
  await clearCredential();
  render();
}

function isArchived(session: Session): boolean {
  return Boolean(session.archivedAt) || session.status === "terminal";
}

function selectSession(session: Session, origin: SessionOrigin = activeTab): void {
  if (selectedSessionId && selectedSessionId !== session.id) multiTab.releaseSession(selectedSessionId);
  selectedSessionId = session.id;
  selectedSession = session;
  selectedSessionOrigin = origin;
  activeTab = origin;
  multiTab.requestSession(session.id);
  saveNavigation();
  render();
}

function clearSelectedSession(): void {
  if (selectedSessionId) multiTab.releaseSession(selectedSessionId);
  selectedSessionId = null;
  selectedSession = null;
  selectedSessionOrigin = null;
  pendingPrompt = null;
}

function appendRollupBadges(container: HTMLElement, rollups: SessionRollups): void {
  const badges = element("span");
  badges.className = "dense-row-badges";
  const values: [number | undefined, string][] = [
    [rollups.internalCount, "internal"],
    [rollups.actionableCount, "needs input"],
    [rollups.failureCount, "failed"],
  ];
  for (const [count, label] of values) {
    if (!count) continue;
    const badge = element("span", `${count} ${label}`);
    badge.className = label === "failed" ? "badge badge-failure" : "badge";
    badges.append(badge);
  }
  if (badges.children.length) container.append(badges);
}

function denseRow(title: string, state: string, updatedAt: string, rollups: SessionRollups, pressed?: boolean): HTMLButtonElement {
  const descriptor = denseRowDescriptor(state, pressed);
  const button = element(descriptor.element);
  button.type = descriptor.type;
  button.className = "dense-row";
  if (descriptor.pressed !== undefined) button.setAttribute("aria-pressed", String(descriptor.pressed));
  const copy = element("span");
  copy.className = "dense-row-copy";
  copy.append(element("strong", title), element("small", `Updated ${new Date(rollups.lastActivityAt ?? updatedAt).toLocaleString()}`));
  const status = element("span", descriptor.statusText);
  status.className = "dense-row-state";
  button.append(copy, status);
  appendRollupBadges(button, rollups);
  return button;
}

function appendSessionGroup(panel: HTMLElement, heading: string, items: Session[], origin: SessionOrigin): void {
  if (items.length === 0) return;
  const headingId = `${origin}-section-${panel.children.length}`;
  const title = element("h3", `${heading} (${items.length})`);
  title.id = headingId;
  const list = element("ul");
  list.className = "dense-list";
  list.setAttribute("aria-labelledby", headingId);
  for (const session of items) {
    const item = element("li");
    const button = denseRow(session.title || session.adapter, session.status, session.updatedAt, session, session.id === selectedSessionId);
    button.addEventListener("click", () => selectSession(session, origin));
    item.append(button);
    list.append(item);
  }
  panel.append(title, list);
}

function renderSessionList(panel: HTMLElement, items: Session[], empty: string, origin: SessionOrigin = "sessions"): void {
  if (loadingSessions) {
    const status = element("p", "Loading sessions…");
    status.className = "surface-state";
    panel.append(status);
    return;
  }
  if (items.length === 0) {
    const status = element("p", empty);
    status.className = "surface-state";
    panel.append(status);
    return;
  }
  for (const section of sessionSections(items)) appendSessionGroup(panel, section.heading, section.items, origin);
}

function renderInbox(panel: HTMLElement): void {
  const pendingActions = hitlActions.filter((action) => action.status === "pending" || action.status === "dispatching" || action.status === "unknown");
  panel.append(element("h2", `Inbox (${pendingActions.length})`));
  renderProjectionError(panel, "inbox");
  if (loadingSessions) panel.append(element("p", "Loading inbox…"));
  else if (pendingActions.length === 0) panel.append(element("p", "No open approvals or failures."));
  else {
    const list = element("ul");
    list.className = "inbox-list";
    for (const action of pendingActions) {
      const rootId = action.rootSessionId ?? action.sessionId;
      const session = sessions.find((candidate) => candidate.id === rootId);
      const descriptor = inboxRowDescriptor(Boolean(session));
      const item = element(descriptor.element);
      item.className = "inbox-action";
      const card = renderAction(action, api);
      item.append(card);
      if (session) {
        const control = descriptor.children[1];
        if (control?.element !== "button") throw new Error("Inbox session control descriptor is invalid.");
        const open = element(control.element, control.label);
        open.type = control.type;
        open.addEventListener("click", () => selectSession(session));
        item.append(open);
      } else {
        card.append(element("p", "The authorized session is unavailable."));
      }
      list.append(item);
    }
    panel.append(list);
  }
}


function workTitle(work: WorkItem): string {
  if (typeof work.payload === "object" && work.payload !== null) {
    const payload = work.payload as { title?: unknown; name?: unknown; summary?: unknown };
    for (const value of [payload.title, payload.name, payload.summary]) if (typeof value === "string" && value.trim()) return value;
  }
  return work.remoteId;
}

function renderProjectionError(panel: HTMLElement, tier: "inbox" | "work" | "history"): void {
  const error = projectionErrors[tier];
  if (!error) return;
  const status = element("p", `${error} Showing cached ${tier} data.`);
  status.setAttribute("role", "alert");
  panel.append(status);
}

function appendWorkAccordion(panel: HTMLElement, group: ReturnType<typeof workSessionGroups<WorkItem, Session>>[number], origin: SessionOrigin): void {
  const descriptor = workAccordionDescriptor(group.title, group.items.length);
  const disclosure = element(descriptor.element);
  disclosure.open = descriptor.expanded;
  disclosure.append(element("summary", descriptor.summary));
  const list = element("ul");
  list.className = "dense-list";
  for (const work of group.items) {
    const item = element("li");
    const button = denseRow(workTitle(work), work.state, work.updatedAt, work);
    const session = group.rootSessionId ? sessions.find((candidate) => candidate.id === group.rootSessionId) : undefined;
    if (session) button.addEventListener("click", () => selectSession(session, origin));
    else button.disabled = true;
    item.append(button);
    list.append(item);
  }
  disclosure.append(list);
  panel.append(disclosure);
}

function renderWork(panel: HTMLElement): void {
  const groups = workSessionGroups(workItems, sessions, ACTIVE_WORK_STATES);
  const count = groups.reduce((total, group) => total + group.items.length, 0);
  panel.append(element("h2", `Work (${count})`), element("p", "Sessions are conversation and control boundaries; work belongs to a root session."));
  renderProjectionError(panel, "work");
  if (loadingSessions) panel.append(element("p", "Loading work…"));
  else if (count === 0) panel.append(element("p", "No active work items."));
  else for (const group of groups) appendWorkAccordion(panel, group, "work");
}

function rootSessions(items: Session[]): Session[] {
  return items.filter((session) => session.rootSessionId === session.id);
}

function renderSessions(panel: HTMLElement): void {
  const activeSessions = sessions.filter((session) => !isArchived(session));
  const sections = rootSessionSections(activeSessions);
  const activeCount = sections.reduce((count, section) => count + section.items.length, 0);
  panel.append(element("h2", `Sessions (${activeCount})`));
  if (loadingSessions || activeCount === 0) {
    renderSessionList(panel, [], "No active runtime sessions.");
  } else {
    for (const section of sections) appendSessionGroup(panel, section.heading, section.items, "sessions");
  }
  const settings = element("details");
  settings.append(element("summary", "Settings"));
  const defaultViewLabel = element("label", "Default view");
  defaultViewLabel.htmlFor = "default-view";
  const defaultView = element("select") as HTMLSelectElement;
  defaultView.id = "default-view";
  for (const { id, label } of tabOptions) {
    const option = element("option", label) as HTMLOptionElement;
    option.value = id;
    option.selected = defaultTab === id;
    defaultView.append(option);
  }
  defaultView.addEventListener("change", () => {
    if (isTab(defaultView.value)) selectDefaultTab(defaultView.value);
  });
  const reconnect = element("button", "Reconnect updates");
  reconnect.type = "button";
  reconnect.addEventListener("click", reconnectUpdates);
  const push = element("button", "Enable push notifications");
  push.type = "button";
  push.addEventListener("click", () => void configurePush(push));
  settings.append(defaultViewLabel, defaultView, element("p", "Updates reconnect automatically when network access returns."), reconnect, push);
  panel.append(settings);
}

function localDateHeading(updatedAt: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(updatedAt));
}

function renderHistory(panel: HTMLElement): void {
  const completedGroups = workSessionGroups(workItems, sessions, COMPLETED_WORK_STATES);
  const completedCount = completedGroups.reduce((total, group) => total + group.items.length, 0);
  const archivedSessions = rootSessions(sessions.filter(isArchived));
  panel.append(element("h2", `Archive (${completedCount + archivedSessions.length})`));
  renderProjectionError(panel, "history");
  renderProjectionError(panel, "work");
  if (loadingSessions) {
    const status = element("p", "Loading archive…");
    status.className = "surface-state";
    panel.append(status);
    return;
  }
  if (completedCount === 0 && archivedSessions.length === 0) {
    const status = element("p", "No completed work or archived sessions.");
    status.className = "surface-state";
    panel.append(status);
    return;
  }
  for (const group of completedGroups) appendWorkAccordion(panel, group, "history");
  if (archivedSessions.length) {
    panel.append(element("h3", `Archived sessions (${archivedSessions.length})`));
    for (const section of historySections(archivedSessions, localDateHeading)) appendSessionGroup(panel, section.heading, section.items, "history");
  }
}

function renderInternalDisclosure(session: Session): HTMLDetailsElement {
  const disclosure = element("details");
  disclosure.className = "internal-disclosure";
  disclosure.open = openInternalDisclosures.has(session.id);
  const summary = element("summary", `Internal activity (${session.internalCount ?? 0})`);
  disclosure.append(summary);
  const content = element("div");
  content.className = "internal-disclosure-content";
  const current = internalDisclosures.get(session.id) ?? { status: "idle", items: [] };
  if (current.status === "loading" || current.status === "idle") content.append(element("p", "Loading internal activity…"));
  else if (current.status === "error") {
    const error = element("p", current.error ?? "Internal activity is unavailable.");
    error.setAttribute("role", "alert");
    content.append(error);
  } else if (current.items.length === 0) content.append(element("p", "No internal activity details are available."));
  else {
    const list = element("ul");
    list.className = "internal-list";
    for (const internal of current.items) {
      const item = element("li");
      item.append(element("strong", internal.title || internal.kind || internal.adapter || "Internal execution"));
      if (internal.status || internal.updatedAt) item.append(element("small", [internal.status, internal.updatedAt ? new Date(internal.updatedAt).toLocaleString() : ""].filter(Boolean).join(" · ")));
      list.append(item);
    }
    content.append(list);
  }
  disclosure.append(content);
  disclosure.addEventListener("toggle", () => {
    if (disclosure.open) {
      openInternalDisclosures.add(session.id);
      if (current.status === "idle") void loadInternalSessions(session.id);
    } else openInternalDisclosures.delete(session.id);
  });
  return disclosure;
}

async function loadInternalSessions(sessionId: string): Promise<void> {
  internalDisclosures.set(sessionId, { status: "loading", items: [] });
  render();
  try {
    const response = await api(`/sessions/${encodeURIComponent(sessionId)}/internal`);
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    const body: unknown = await response.json();
    const candidates = typeof body === "object" && body !== null
      ? ((body as { sessions?: unknown; internal?: unknown }).sessions ?? (body as { internal?: unknown }).internal)
      : undefined;
    if (!Array.isArray(candidates)) throw new Error("invalid response");
    const items = candidates.filter((item): item is InternalSessionSummary =>
      typeof item === "object" && item !== null && typeof (item as InternalSessionSummary).id === "string");
    internalDisclosures.set(sessionId, { status: "loaded", items });
  } catch (error) {
    internalDisclosures.set(sessionId, { status: "error", items: [], error: fetchFailure("Unable to load internal activity", error) });
  }
  render();
}

function renderSelectedSession(panel: HTMLElement): void {
  const session = selectedSession;
  const heading = element("h2", "Session details");
  const origin = selectedSessionOrigin ?? "sessions";
  const back = element("button", `Back to ${tabOptions.find((option) => option.id === origin)?.label.toLowerCase() ?? "sessions"}`);
  back.type = "button";
  back.className = "back-to-sessions";
  back.addEventListener("click", navigateBack);
  panel.append(back, heading);
  if (!session) {
    panel.append(element("p", "Loading selected session…"));
    return;
  }
  const detail = element("section");
  detail.className = "session-detail";
  detail.setAttribute("aria-label", `${session.title || session.adapter} details`);
  detail.append(element("h3", session.title || session.adapter));
  detail.append(element("p", `${session.workdir || "No working directory"} · ${session.controlMode || "controlled"} · Started ${session.sourceCreatedAt ? new Date(session.sourceCreatedAt).toLocaleString() : "unknown"}`));
  const activity = element("details");
  activity.open = true;
  activity.append(element("summary", "Activity"));
  const messages = element("ol");
  messages.id = "messages";
  messages.className = "messages";
  messages.setAttribute("aria-label", "Normalized transcript");
  activity.append(messages);
  detail.append(activity);
  if (session.internalCount) detail.append(renderInternalDisclosure(session));
  if (isArchived(session)) {
    detail.append(element("p", "Archived sessions are read-only."));
  } else {
    const archive = element("button", "Archive session");
    archive.type = "button";
    archive.addEventListener("click", () => void archiveSession(session.id, archive));
    detail.append(archive);
    if (session.controlMode === "view-only") detail.append(element("p", "This session is view-only. Prompts and session actions are unavailable."));
    else {
      renderPromptForm(detail, session.id);
      renderSessionActions(detail, session.id, api);
    }
  }
  panel.append(detail);
}

function renderPromptForm(panel: HTMLElement, sessionId: string): void {
  const form = element("form");
  form.className = "prompt-form";
  const label = element("label", "Prompt");
  label.htmlFor = "prompt";
  const input = element("textarea") as HTMLTextAreaElement;
  input.id = "prompt";
  input.name = "prompt";
  input.required = true;
  input.rows = 3;
  input.autocomplete = "off";
  input.addEventListener("input", () => {
    if (pendingPrompt && pendingPrompt.sessionId === sessionId && input.value.trim() !== pendingPrompt.prompt) pendingPrompt = null;
  });
  const submit = element("button", "Send");
  submit.type = "submit";
  form.append(label, input, submit);
  form.addEventListener("submit", (event) => void sendPrompt(event, input, submit));
  panel.append(form);
}

function normalizedMessage(value: unknown): { role: "user" | "assistant" | "system"; text: string } {
  if (typeof value === "string") return { role: "system", text: value };
  if (typeof value !== "object" || value === null) return { role: "system", text: "Activity updated." };
  const record = value as { role?: unknown; text?: unknown; message?: unknown; content?: unknown; error?: unknown };
  const role = record.role === "user" || record.role === "assistant" ? record.role : "system";
  const candidate = record.text ?? record.message ?? record.content ?? record.error;
  if (typeof candidate === "string") return { role, text: candidate };
  if (Array.isArray(candidate)) {
    const text = candidate.map((item) => typeof item === "string" ? item : typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "").filter(Boolean).join("\n");
    if (text) return { role, text };
  }
  return { role, text: "Activity updated." };
}

function appendMessage(sessionId: string, value: unknown): void {
  if (sessionId !== selectedSessionId) return;
  const list = document.querySelector<HTMLOListElement>("#messages");
  if (!list) return;
  const normalized = normalizedMessage(value);
  const message = element("li", normalized.text);
  message.className = `message message-${normalized.role}`;
  message.setAttribute("aria-label", `${normalized.role} message`);
  list.append(message);
}

async function archiveSession(sessionId: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const response = await api(`/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !isSession((body as { session?: unknown }).session)) throw new Error("invalid archive response");
    const archived = (body as { session: Session }).session;
    sessions = sessions.map((session) => session.id === sessionId ? archived : session);
    clearSelectedSession();
    fetchError = null;
    activeTab = "history";
    saveNavigation(true);
  } catch (error) {
    fetchError = fetchFailure("Unable to archive session", error);
  } finally {
    render();
  }
}
async function configurePush(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const permission = await enablePush(api);
    fetchError = permission === "granted" ? null : "Push notifications are disabled in browser settings.";
  } catch (error) {
    fetchError = fetchFailure("Unable to configure push notifications", error);
  } finally {
    button.disabled = false;
    render();
  }
}


async function sendPrompt(event: SubmitEvent, input: HTMLTextAreaElement, submit: HTMLButtonElement): Promise<void> {
  event.preventDefault();
  const sessionId = selectedSessionId;
  const prompt = input.value.trim();
  if (!sessionId || !prompt) return;
  const retry = pendingPrompt?.sessionId === sessionId && pendingPrompt.prompt === prompt
    ? pendingPrompt
    : { sessionId, prompt, key: crypto.randomUUID() };
  pendingPrompt = retry;
  submit.disabled = true;
  try {
    const response = await api(`/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": retry.key },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    if (pendingPrompt?.key === retry.key) pendingPrompt = null;
    if (sessionId === selectedSessionId) input.value = "";
  } catch (error) {
    appendMessage(sessionId, fetchFailure("Unable to send prompt", error));
  } finally {
    submit.disabled = false;
  }
}

function isSession(value: unknown): value is Session {
  return typeof value === "object" && value !== null && typeof (value as Session).id === "string" && typeof (value as Session).adapter === "string" && typeof (value as Session).status === "string" && typeof (value as Session).updatedAt === "string";
}
function isWorkItem(value: unknown): value is WorkItem {
  return typeof value === "object" && value !== null &&
    typeof (value as WorkItem).id === "string" &&
    typeof (value as WorkItem).sessionId === "string" &&
    typeof (value as WorkItem).remoteId === "string" &&
    typeof (value as WorkItem).state === "string" &&
    typeof (value as WorkItem).updatedAt === "string";
}


async function loadSessions(): Promise<void> {
  loadingSessions = true;
  render();
  const load = async (path: string): Promise<unknown> => {
    const response = await api(path);
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    return response.json();
  };
  try {
    const [sessionResult, workResult, hitlResult, historyResult] = await Promise.allSettled([
      load("/sessions"),
      load("/work"),
      load("/hitl"),
      load("/history"),
    ]);
    if (sessionResult.status === "fulfilled") {
      const body = sessionResult.value;
      if (typeof body !== "object" || body === null || !Array.isArray((body as { sessions?: unknown }).sessions)) fetchError = "Unable to load sessions: invalid response.";
      else {
        sessions = (body as { sessions: unknown[] }).sessions.filter(isSession);
        if (selectedSessionId) selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? selectedSession;
        fetchError = null;
      }
    } else fetchError = fetchFailure("Unable to load sessions", sessionResult.reason);

    projectionErrors = {};
    if (workResult.status === "fulfilled") {
      const body = workResult.value;
      if (typeof body === "object" && body !== null && Array.isArray((body as { work?: unknown }).work)) workItems = (body as { work: unknown[] }).work.filter(isWorkItem);
      else projectionErrors.work = "Unable to load work: invalid response.";
    } else projectionErrors.work = fetchFailure("Unable to load work", workResult.reason);
    if (hitlResult.status === "fulfilled") {
      const body = hitlResult.value;
      if (typeof body === "object" && body !== null && Array.isArray((body as { actions?: unknown }).actions)) {
        hitlActions = (body as { actions: unknown[] }).actions.flatMap((action) => {
          if (typeof action !== "object" || action === null || typeof (action as { sessionId?: unknown }).sessionId !== "string") return [];
          const parsed = parseActions({ actions: [action] }, (action as { sessionId: string }).sessionId);
          const rootSessionId = typeof (action as { rootSessionId?: unknown }).rootSessionId === "string"
            ? (action as { rootSessionId: string }).rootSessionId
            : undefined;
          return parsed.map((item) => ({ ...item, rootSessionId }));
        });
      } else projectionErrors.inbox = "Unable to load inbox: invalid response.";
    } else projectionErrors.inbox = fetchFailure("Unable to load inbox", hitlResult.reason);
    if (historyResult.status === "fulfilled") {
      const body = historyResult.value;
      if (typeof body === "object" && body !== null && Array.isArray((body as { sessions?: unknown }).sessions)) {
        const history = (body as { sessions: unknown[] }).sessions.filter(isSession);
        sessions = [...new Map([...sessions, ...history].map((session) => [session.id, session])).values()];
        if (selectedSessionId) selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? selectedSession;
      } else projectionErrors.history = "Unable to load history: invalid response.";
    } else projectionErrors.history = fetchFailure("Unable to load history", historyResult.reason);
  } catch (error) {
    fetchError = fetchFailure("Unable to load sessions", error);
  } finally {
    loadingSessions = false;
    render();
  }
}

function parseEvents(body: string): unknown[] {
  const events: unknown[] = [];
  for (const frame of body.split(/\n\n+/)) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) continue;
    try { events.push(JSON.parse(data)); } catch { /* Ignore malformed event frames. */ }
  }
  return events;
}

async function catchUp(sessionId: string, renderMessages = false): Promise<boolean> {
  if (!multiTab.canCoordinate() || !multiTab.isLeader()) return false;
  const previous = catchUpLocks.get(sessionId) ?? Promise.resolve(true);
  const current = previous
    .catch(() => false)
    .then(() => catchUpOnce(sessionId, renderMessages));
  catchUpLocks.set(sessionId, current);
  try {
    return await current;
  } finally {
    if (catchUpLocks.get(sessionId) === current) catchUpLocks.delete(sessionId);
  }
}

async function catchUpOnce(sessionId: string, renderMessages: boolean): Promise<boolean> {
  const cursor = await storedCursor(sessionId);
  const response = await api(`/sessions/${encodeURIComponent(sessionId)}/events${cursor === null ? "" : `?after=${encodeURIComponent(String(cursor))}`}`, { headers: { Accept: "text/event-stream" } });
  if (response.status === 410) {
    multiTab.publishReset(sessionId);
    if (sessionId === selectedSessionId && renderMessages) {
      const list = document.querySelector<HTMLOListElement>("#messages");
      list?.replaceChildren(element("li", "Conversation history is no longer available; refreshed from the latest snapshot."));
    }
    return false;
  }
  if (!response.ok) throw new Error(`catch-up failed (${response.status})`);
  for (const event of parseEvents(await response.text())) await applyEvent(sessionId, event);
  return true;
}

async function applyEvent(sessionId: string, value: unknown): Promise<void> {
  if (!isHubEvent(value) || value.sessionId !== sessionId) return;
  multiTab.publishEvent(sessionId, value, value.seq);
  multiTab.publishCursor(sessionId, value.seq);
}

async function applyBroadcastEvent(sessionId: string, value: unknown): Promise<void> {
  if (!isHubEvent(value) || value.sessionId !== sessionId) return;
  await saveCursor(sessionId, value.seq);
  appendMessage(sessionId, value.payload);
}

function isHubEvent(value: unknown): value is HubEvent {
  return typeof value === "object" && value !== null && typeof (value as HubEvent).seq === "number" && typeof (value as HubEvent).type === "string" && typeof (value as HubEvent).sessionId === "string" && typeof (value as HubEvent).createdAt === "string";
}

function reconnectUpdates(): void {
  window.clearTimeout(reconnectTimer);
  const generation = ++pollGeneration;
  streamConnected = false;
  updateConnectionStatus();
  if (!pairingRequired) void loadSessions();
  if (!online || !multiTab.canCoordinate() || !multiTab.isLeader()) return;
  void pollUpdates(generation);
}

async function pollUpdates(generation: number): Promise<void> {
  try {
    for (const sessionId of multiTab.requestedSessions()) {
      if (generation !== pollGeneration || !multiTab.isLeader()) return;
      await catchUp(sessionId, sessionId === selectedSessionId);
    }
    if (generation !== pollGeneration) return;
    streamConnected = true;
    fetchError = null;
  } catch (error) {
    if (generation !== pollGeneration) return;
    streamConnected = false;
    fetchError = fetchFailure("Unable to catch up updates", error);
  }
  if (generation !== pollGeneration || !multiTab.isLeader()) return;
  updateConnectionStatus();
  reconnectTimer = window.setTimeout(() => void pollUpdates(generation), POLL_INTERVAL);
}
window.addEventListener("popstate", () => restoreNavigation(navigationState()));

window.addEventListener("online", () => { online = true; if (!pairingRequired) reconnectUpdates(); });
window.addEventListener("offline", () => { online = false; ++pollGeneration; window.clearTimeout(reconnectTimer); streamConnected = false; updateConnectionStatus(); });
window.addEventListener("visibilitychange", () => void revokePushWhenPermissionLost(api));
window.addEventListener("planee:logout", () => void revokePush(api));
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
async function start(): Promise<void> {
  try {
    credential = await storedCredential();
    pairingRequired = credential === null;
  } catch (error) {
    pairingRequired = true;
    pairingAvailable = false;
    pairingStatus = error instanceof SecureCredentialUnavailableError ? "This app requires Android secure storage to keep its device credential." : "Secure storage is unavailable. Restart the app and try again.";
  }
  const initialNavigation = navigationState();
  if (initialNavigation) {
    activeTab = initialNavigation.tab;
    selectedSessionId = initialNavigation.sessionId;
    selectedSessionOrigin = initialNavigation.tab;
    appHistoryIndex = initialNavigation.index;
  }
  const deepLinkedSession = requestedSessionId();
  if (deepLinkedSession) {
    clearSelectedSession();
    activeTab = "sessions";
    appHistoryIndex = 0;
    saveNavigation(true, sessionlessUrl());
    selectedSessionId = deepLinkedSession;
    selectedSessionOrigin = "sessions";
    saveNavigation();
  } else saveNavigation(true);
  registerAndroidBackButton();
  render();
  if (pairingRequired) return;
  multiTab.start();
  if (selectedSessionId) multiTab.requestSession(selectedSessionId);
  reconnectUpdates();
}

void start();
