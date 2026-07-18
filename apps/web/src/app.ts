import { App } from "@capacitor/app";
import { Dialog } from "@capacitor/dialog";
import { Capacitor } from "@capacitor/core";
import { parseActions, renderAction, renderActions as renderSessionActions, type PendingAction } from "./actions";
import { clearCredential, saveCredential, SecureCredentialUnavailableError, storedCredential } from "./credential";
import { enablePush, revokePush, revokePushWhenPermissionLost } from "./push";
import { MultiTabCoordinator } from "./multitab";
import { canNavigateBack, denseRowDescriptor, historySections, inboxRowDescriptor, isDeliberateArchiveSwipe, rootSessionSections, SESSION_ARCHIVE_LONG_PRESS_MS, SESSION_ARCHIVE_SWIPE_VERTICAL_TOLERANCE_PX, sessionSections, workAccordionDescriptor, workSessionGroups } from "./view-model";
import { conversationHistoryState, mergeConversationMessages, orderedConversationMessages, parseSseDataFrames, responseCursor, visibleConversationMessage, type VisibleConversationMessage } from "./conversation-state";
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


type HubEvent = {
  seq: number;
  type: string;
  sessionId: string;
  payload: unknown;
  createdAt: string;
};
type NormalizedMessage = VisibleConversationMessage;

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
let appHistoryIndex = 0;
let androidBackRegistered = false;
let exitDialogOpen = false;
let archiveConfirmation: { session: Session; focusId: string } | null = null;
const sessionMessages = new Map<string, Map<number, NormalizedMessage>>();
const hydratingSessions = new Set<string>();
const unavailableSessionHistory = new Set<string>();
const hydrationLocks = new Map<string, Promise<void>>();
registerAndroidBackButton();

function isTab(value: string | null): value is TabId {
  return value !== null && tabOptions.some((option) => option.id === value);
}

function normalizeTab(value: string | null): TabId {
  return value === "work" ? "sessions" : isTab(value) ? value : "inbox";
}

function readDefaultTab(): TabId {
  try {
    return normalizeTab(localStorage.getItem(DEFAULT_TAB_KEY));
  } catch {
    return "inbox";
  }
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
  if (state?.planee !== true || typeof state.index !== "number") return null;
  return {
    planee: true,
    tab: normalizeTab(typeof tab === "string" ? tab : null),
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
    void hydrateSession(state.sessionId);
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
    if (archiveConfirmation) {
      dismissArchiveConfirmation();
      return;
    }
    if (canNavigateBack({ sessionId: selectedSessionId, index: appHistoryIndex })) {
      navigateBack();
      return;
    }
    if (exitDialogOpen) return;
    exitDialogOpen = true;
    void Dialog.confirm({
      title: "Exit Planee Agent Hub?",
      message: "Are you sure you want to exit?",
      okButtonTitle: "Exit",
      cancelButtonTitle: "Cancel",
    }).then(({ value }) => {
      if (value) void App.exitApp();
    }).finally(() => {
      exitDialogOpen = false;
    });
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
  if (archiveConfirmation) renderArchiveConfirmation();
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
  void hydrateSession(session.id);
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
  const groups = workSessionGroups(workItems, sessions);
  for (const session of items) {
    const item = element("li");
    if (origin !== "sessions") {
      const button = denseRow(session.title || session.adapter, session.status, session.updatedAt, session, session.id === selectedSessionId);
      button.addEventListener("click", () => selectSession(session, origin));
      item.append(button);
      list.append(item);
      continue;
    }
    const disclosure = element("details");
    disclosure.className = "session-work-disclosure";
    const summary = element("summary");
    summary.append(element("strong", session.title || session.adapter), element("small", `Status: ${session.status}`));
    disclosure.append(summary);
    const actions = element("div");
    actions.className = "session-row-actions";
    const open = element("button", "Open session");
    open.type = "button";
    open.addEventListener("click", () => selectSession(session, origin));
    const archive = element("button", "Archive session");
    archive.type = "button";
    archive.className = "archive-session-action";
    archive.id = `session-row-${session.id}`;
    archive.setAttribute("aria-label", `Archive ${session.title || session.adapter}`);
    archive.addEventListener("click", () => openArchiveConfirmation(session, archive.id));
    actions.append(open, archive);
    attachArchiveGestures(summary, session, archive.id);
    disclosure.append(actions);
    const group = groups.find((candidate) => candidate.rootSessionId === session.id);
    if (group) appendWorkAccordion(disclosure, group, "sessions");
    item.append(disclosure);
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

function awaitsOwnerResponse(action: HitlAction, at = Date.now()): boolean {
  if (!Number.isFinite(Date.parse(action.expiresAt)) || Date.parse(action.expiresAt) <= at) return false;
  if (action.status === "pending") return true;
  if (action.status !== "unknown" || action.allowedResponses.length === 0 || typeof action.payload !== "object" || action.payload === null) return false;
  return (action.payload as { requiresOwnerIntervention?: unknown }).requiresOwnerIntervention === true;
}

function renderInbox(panel: HTMLElement): void {
  const pendingActions = hitlActions.filter(awaitsOwnerResponse);
  panel.append(element("h2", `Inbox · Your turn (${pendingActions.length})`));
  panel.append(element("p", "Sessions waiting for your decision or feedback."));
  renderProjectionError(panel, "inbox");
  if (loadingSessions) panel.append(element("p", "Loading inbox…"));
  else if (pendingActions.length === 0) panel.append(element("p", "No sessions are waiting for you."));
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
  const descriptor = workAccordionDescriptor(group.title, group.items.length, true);
  const disclosure = element(descriptor.element);
  disclosure.className = group.unassigned ? "unassigned-work" : "session-work";
  disclosure.open = descriptor.expanded;
  disclosure.append(element("summary", group.unassigned ? `${descriptor.summary} active work` : `Active work (${group.items.length})`));
  const list = element("ul");
  list.className = "dense-list work-list";
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

function rootSessions(items: Session[]): Session[] {
  return items.filter((session) => session.rootSessionId === session.id);
}

function renderSessions(panel: HTMLElement): void {
  const activeSessions = sessions.filter((session) => !isArchived(session));
  const sections = rootSessionSections(activeSessions);
  const activeCount = sections.reduce((count, section) => count + section.items.length, 0);
  panel.append(element("h2", `Sessions (${activeCount})`));
  renderProjectionError(panel, "work");
  const unassigned = workSessionGroups(workItems, sessions).find((group) => group.unassigned);
  if (loadingSessions || activeCount === 0) {
    renderSessionList(panel, [], "No active runtime sessions.");
  } else {
    for (const section of sections) appendSessionGroup(panel, section.heading, section.items, "sessions");
  }
  if (!loadingSessions && unassigned) appendWorkAccordion(panel, unassigned, "sessions");
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
  const archivedSessions = rootSessions(sessions.filter(isArchived));
  panel.append(element("h2", `Archive (${archivedSessions.length})`));
  renderProjectionError(panel, "history");
  if (loadingSessions) {
    const status = element("p", "Loading archive…");
    status.className = "surface-state";
    panel.append(status);
    return;
  }
  if (archivedSessions.length === 0) {
    const status = element("p", "No archived sessions.");
    status.className = "surface-state";
    panel.append(status);
    return;
  }
  for (const section of historySections(archivedSessions, localDateHeading)) appendSessionGroup(panel, section.heading, section.items, "history");
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
  renderConversationMessages(messages, session.id);
  activity.append(messages);
  detail.append(activity);
  if (isArchived(session)) {
    detail.append(element("p", "Archived sessions are read-only."));
  } else {
    const archive = element("button", "Archive session");
    archive.type = "button";
    archive.id = "archive-session-action";
    archive.addEventListener("click", () => openArchiveConfirmation(session, "archive-session-action"));
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

function normalizedMessage(event: HubEvent): NormalizedMessage | null {
  return visibleConversationMessage(event.type, event.payload);
}

function messageElement(message: NormalizedMessage): HTMLLIElement {
  const item = element("li", message.text);
  item.className = `message message-${message.role}`;
  item.setAttribute("aria-label", `${message.role} message`);
  return item;
}

function renderConversationMessages(list: HTMLOListElement, sessionId: string): void {
  list.replaceChildren();
  const storedMessages = orderedConversationMessages(sessionMessages.get(sessionId) ?? new Map<number, NormalizedMessage>());
  for (const message of storedMessages) list.append(messageElement(message));
  const state = conversationHistoryState(storedMessages.length, unavailableSessionHistory.has(sessionId), hydratingSessions.has(sessionId));
  if (state) {
    const empty = element("li", state);
    empty.className = "message message-system";
    empty.setAttribute("aria-label", "conversation status");
    empty.dataset.placeholder = "conversation-state";
    list.append(empty);
  }
  list.scrollTop = list.scrollHeight;
}

function appendMessage(sessionId: string): void {
  if (sessionId !== selectedSessionId) return;
  const list = document.querySelector<HTMLOListElement>("#messages");
  if (list) renderConversationMessages(list, sessionId);
}

function recordSessionEvent(sessionId: string, event: HubEvent): boolean {
  const message = normalizedMessage(event);
  if (!message) return false;
  const messages = sessionMessages.get(sessionId) ?? new Map<number, NormalizedMessage>();
  if (messages.has(event.seq)) return false;
  mergeConversationMessages(messages, [{ seq: event.seq, message }]);
  sessionMessages.set(sessionId, messages);
  return true;
}

function openArchiveConfirmation(session: Session, focusId: string): void {
  archiveConfirmation = { session, focusId };
  render();
}

function dismissArchiveConfirmation(renderApp = true): void {
  const focusId = archiveConfirmation?.focusId;
  archiveConfirmation = null;
  if (renderApp) render();
  if (focusId) window.setTimeout(() => document.getElementById(focusId)?.focus(), 0);
}

function renderArchiveConfirmation(): void {
  const confirmation = archiveConfirmation;
  if (!confirmation) return;
  const dialog = document.createElement("dialog");
  dialog.className = "archive-confirmation";
  dialog.setAttribute("aria-labelledby", "archive-confirmation-title");
  dialog.append(element("h2", "Archive session"));
  dialog.lastElementChild!.id = "archive-confirmation-title";
  dialog.append(element("p", `Archive ${confirmation.session.title || confirmation.session.adapter}? This can be viewed later in Archive.`));
  const controls = element("div");
  controls.className = "archive-confirmation-controls";
  const cancel = element("button", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => dismissArchiveConfirmation());
  const archive = element("button", "Archive");
  archive.id = "confirm-archive";
  archive.type = "button";
  archive.addEventListener("click", () => {
    const target = archiveConfirmation;
    if (!target) return;
    archiveConfirmation = null;
    void archiveSession(target.session.id, archive);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismissArchiveConfirmation();
  });
  controls.append(cancel, archive);
  dialog.append(controls);
  app.append(dialog);
  dialog.showModal();
  archive.focus();
}

function attachArchiveGestures(row: HTMLElement, session: Session, focusId: string): void {
  let timer: number | undefined;
  let start: { x: number; y: number } | null = null;
  let suppressClick = false;
  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  row.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    clear();
    timer = window.setTimeout(() => {
      suppressClick = true;
      openArchiveConfirmation(session, focusId);
    }, SESSION_ARCHIVE_LONG_PRESS_MS);
  });
  row.addEventListener("pointermove", (event: PointerEvent) => {
    if (!start) return;
    const movedHorizontally = Math.abs(event.clientX - start.x) > 12;
    const movedVertically = Math.abs(event.clientY - start.y) > SESSION_ARCHIVE_SWIPE_VERTICAL_TOLERANCE_PX;
    if (movedHorizontally || movedVertically) clear();
  });
  row.addEventListener("pointerup", (event: PointerEvent) => {
    clear();
    if (start && isDeliberateArchiveSwipe(start.x, start.y, event.clientX, event.clientY)) {
      suppressClick = true;
      openArchiveConfirmation(session, focusId);
    }
    start = null;
  });
  row.addEventListener("pointercancel", () => {
    clear();
    start = null;
  });
  row.addEventListener("pointerleave", () => {
    clear();
    start = null;
  });
  row.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
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
    fetchError = fetchFailure("Unable to send prompt", error);
    updateConnectionStatus();
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
      load("/work?scope=active"),
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


async function hydrateSession(sessionId: string): Promise<void> {
  const existing = hydrationLocks.get(sessionId);
  if (existing) return existing;
  hydratingSessions.add(sessionId);
  unavailableSessionHistory.delete(sessionId);
  const messages = sessionMessages.get(sessionId) ?? new Map<number, NormalizedMessage>();
  sessionMessages.set(sessionId, messages);
  const hydration = (async () => {
    try {
      const response = await api(`/sessions/${encodeURIComponent(sessionId)}/events?view=conversation`, { headers: { Accept: "text/event-stream" } });
      if (response.status === 410) {
        unavailableSessionHistory.add(sessionId);
        return;
      }
      if (!response.ok) throw new Error(`conversation hydration failed (${response.status})`);
      const history = parseSseDataFrames(await response.text()).flatMap((value) => {
        if (!isHubEvent(value) || value.sessionId !== sessionId) return [];
        const message = normalizedMessage(value);
        return message ? [{ seq: value.seq, message }] : [];
      });
      mergeConversationMessages(sessionMessages.get(sessionId) ?? messages, history);
      const nextCursor = responseCursor(response.headers.get("x-next-event-cursor"));
      if (nextCursor !== null) multiTab.publishCursor(sessionId, nextCursor);
    } catch (error) {
      fetchError = fetchFailure("Unable to load conversation", error);
      updateConnectionStatus();
    } finally {
      hydratingSessions.delete(sessionId);
      hydrationLocks.delete(sessionId);
      if (sessionId === selectedSessionId) {
        const list = document.querySelector<HTMLOListElement>("#messages");
        if (list) renderConversationMessages(list, sessionId);
        else render();
      }
    }
  })();
  hydrationLocks.set(sessionId, hydration);
  return hydration;
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
  let cursor = await storedCursor(sessionId);
  if (cursor === null) {
    await (hydrationLocks.get(sessionId) ?? hydrateSession(sessionId));
    cursor = await storedCursor(sessionId);
  }
  const query = new URLSearchParams({ view: "conversation", after: String(cursor ?? 0) });
  const response = await api(`/sessions/${encodeURIComponent(sessionId)}/events?${query}`, { headers: { Accept: "text/event-stream" } });
  if (response.status === 410) {
    multiTab.publishReset(sessionId);
    unavailableSessionHistory.add(sessionId);
    if (sessionId === selectedSessionId && renderMessages) render();
    return false;
  }
  if (!response.ok) throw new Error(`catch-up failed (${response.status})`);
  for (const event of parseSseDataFrames(await response.text())) await applyEvent(sessionId, event);
  const nextCursor = responseCursor(response.headers.get("x-next-event-cursor"));
  if (nextCursor !== null) multiTab.publishCursor(sessionId, nextCursor);
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
  if (recordSessionEvent(sessionId, value)) appendMessage(sessionId);
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
window.addEventListener("popstate", () => {
  if (archiveConfirmation) dismissArchiveConfirmation(false);
  restoreNavigation(navigationState());
});

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
  render();
  if (pairingRequired) return;
  multiTab.start();
  if (selectedSessionId) {
    multiTab.requestSession(selectedSessionId);
    await hydrateSession(selectedSessionId);
  }
  reconnectUpdates();
}

void start();
