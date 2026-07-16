import { parseActions, renderAction, renderActions as renderSessionActions, type PendingAction } from "./actions";
import { clearCredential, saveCredential, SecureCredentialUnavailableError, storedCredential } from "./credential";
import { enablePush, revokePush, revokePushWhenPermissionLost } from "./push";
import { MultiTabCoordinator } from "./multitab";
type Session = {
  id: string;
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
type WorkItem = {
  id: string;
  sessionId: string;
  remoteId: string;
  state: string;
  payload: unknown;
  updatedAt: string;
};

type HitlAction = PendingAction;

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
const tabs = ["inbox", "work", "sessions", "history"] as const;
let sessions: Session[] = [];
let workItems: WorkItem[] = [];
let hitlActions: HitlAction[] = [];
let selectedSessionId: string | null = null;
let activeTab: "inbox" | "work" | "sessions" | "history" = readDefaultTab();
let reconnectTimer: number | undefined;
let online = navigator.onLine;
let streamConnected = false;
let loadingSessions = false;
let fetchError: string | null = null;
let projectionErrors: Partial<Record<"inbox" | "work" | "history", string>> = {};

function isTab(value: string | null): value is typeof tabs[number] {
  return value !== null && (tabs as readonly string[]).includes(value);
}

function readDefaultTab(): typeof tabs[number] {
  let configured: string | null;
  try {
    configured = localStorage.getItem(DEFAULT_TAB_KEY);
  } catch {
    return "inbox";
  }
  return isTab(configured) ? configured : "inbox";
}

function selectDefaultTab(tab: typeof tabs[number]): void {
  activeTab = tab;
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
  if (activeTab === "inbox") renderInbox(panel);
  if (activeTab === "work") renderWork(panel);
  if (activeTab === "sessions") renderSessions(panel);
  if (activeTab === "history") renderHistory(panel);

  const navigation = element("nav");
  navigation.className = "tabs";
  navigation.setAttribute("aria-label", "Main navigation");
  for (const [id, label] of [["inbox", "Inbox"], ["work", "Work"], ["sessions", "Sessions"], ["history", "History"]] as const) {
    const button = element("button", label);
    button.type = "button";
    button.dataset.tab = id;
    button.setAttribute("aria-current", id === activeTab ? "page" : "false");
    button.addEventListener("click", () => { selectDefaultTab(id); render(); });
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

function selectSession(session: Session): void {
  if (selectedSessionId && selectedSessionId !== session.id) multiTab.releaseSession(selectedSessionId);
  selectedSessionId = session.id;
  multiTab.requestSession(session.id);
  render();
}

function renderSessionList(panel: HTMLElement, items: Session[], empty: string): void {
  if (loadingSessions) {
    panel.append(element("p", "Loading sessions…"));
    return;
  }
  if (items.length === 0) {
    panel.append(element("p", empty));
    return;
  }
  const list = element("ul");
  list.className = "session-list";
  for (const session of items) {
    const item = element("li");
    const button = element("button");
    button.type = "button";
    button.className = "session";
    button.setAttribute("aria-pressed", String(session.id === selectedSessionId));
    const title = session.title || session.adapter;
    const stale = session.status === "stale" ? "Stale" : session.status;
    button.append(element("strong", title), element("span", stale), element("small", `Updated ${new Date(session.updatedAt).toLocaleString()}`));
    if (session.hitlCount) button.append(element("span", `${session.hitlCount} needs input`));
    if (session.failureCount) button.append(element("span", `${session.failureCount} failed`));
    button.addEventListener("click", () => selectSession(session));
    item.append(button);
    list.append(item);
  }
  panel.append(list);
}

function renderInbox(panel: HTMLElement): void {
  panel.append(element("h2", "Inbox"));
  renderProjectionError(panel, "inbox");
  if (loadingSessions) panel.append(element("p", "Loading inbox…"));
  else if (hitlActions.length === 0) panel.append(element("p", "No open approvals or failures."));
  else {
    const list = element("ul");
    list.className = "session-list";
    for (const action of hitlActions) {
      if (action.status !== "pending" && action.status !== "dispatching" && action.status !== "unknown") continue;
      const item = element("li");
      item.className = "inbox-action";
      const card = renderAction(action, api);
      const session = sessions.find((candidate) => candidate.id === action.sessionId);
      if (session) {
        const open = element("button", "View session");
        open.type = "button";
        open.addEventListener("click", () => selectSession(session));
        card.append(open);
      } else card.append(element("p", "The authorized session is unavailable."));
      item.append(card);
      list.append(item);
    }
    panel.append(list);
  }
  renderSelectedSession(panel);
}

const WORK_STATE_GROUPS = {
  Todo: new Set(["todo", "open"]),
  "In progress": new Set(["in-progress", "active", "in_progress"]),
  Results: new Set(["done", "completed", "result", "resolved", "succeeded", "success"]),
  Failed: new Set(["failed", "error", "cancelled", "canceled"]),
} as const;

type WorkGroup = keyof typeof WORK_STATE_GROUPS | "Unknown";

function workGroup(state: string): WorkGroup {
  for (const [group, states] of Object.entries(WORK_STATE_GROUPS) as [keyof typeof WORK_STATE_GROUPS, ReadonlySet<string>][]) {
    if (states.has(state)) return group;
  }
  return "Unknown";
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

function renderWork(panel: HTMLElement): void {
  panel.append(element("h2", "Work"));
  renderProjectionError(panel, "work");
  if (loadingSessions) panel.append(element("p", "Loading work…"));
  else if (workItems.length === 0) panel.append(element("p", "No work items."));
  else for (const heading of ["Todo", "In progress", "Results", "Failed", "Unknown"] as const) {
    panel.append(element("h3", heading));
    const items = workItems.filter((work) => workGroup(work.state) === heading);
    if (items.length === 0) {
      panel.append(element("p", `No ${heading.toLowerCase()} items.`));
      continue;
    }
    const list = element("ul");
    list.className = "session-list";
    for (const work of items) {
      const item = element("li");
      const button = element("button");
      button.type = "button";
      button.className = "session";
      button.append(element("strong", workTitle(work)), element("span", work.state), element("small", `Updated ${new Date(work.updatedAt).toLocaleString()}`));
      const session = sessions.find((candidate) => candidate.id === work.sessionId);
      if (session) button.addEventListener("click", () => selectSession(session));
      else button.disabled = true;
      item.append(button);
      list.append(item);
    }
    panel.append(list);
  }
  renderSelectedSession(panel);
}

function renderSessions(panel: HTMLElement): void {
  panel.append(element("h2", "Sessions"));
  renderSessionList(panel, sessions.filter((session) => !isArchived(session)), "No active runtime sessions.");
  renderSelectedSession(panel);
  const settings = element("details");
  settings.append(element("summary", "Settings"));
  const defaultViewLabel = element("label", "Default view");
  defaultViewLabel.htmlFor = "default-view";
  const defaultView = element("select") as HTMLSelectElement;
  defaultView.id = "default-view";
  for (const [id, label] of [["inbox", "Inbox"], ["work", "Work"], ["sessions", "Sessions"], ["history", "History"]] as const) {
    const option = element("option", label) as HTMLOptionElement;
    option.value = id;
    option.selected = activeTab === id;
    defaultView.append(option);
  }
  defaultView.addEventListener("change", () => selectDefaultTab(defaultView.value as typeof tabs[number]));
  const reconnect = element("button", "Reconnect updates");
  reconnect.type = "button";
  reconnect.addEventListener("click", reconnectUpdates);
  const push = element("button", "Enable push notifications");
  push.type = "button";
  push.addEventListener("click", () => void configurePush(push));
  settings.append(defaultViewLabel, defaultView, element("p", "Updates reconnect automatically when network access returns."), reconnect, push);
  panel.append(settings);
}

function renderHistory(panel: HTMLElement): void {
  panel.append(element("h2", "History"));
  renderProjectionError(panel, "history");
  renderSessionList(panel, sessions.filter(isArchived), "No completed or archived sessions.");
  renderSelectedSession(panel);
}

function renderSelectedSession(panel: HTMLElement): void {
  const session = sessions.find((item) => item.id === selectedSessionId);
  if (!session) return;
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
  multiTab.requestSession(session.id);
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
    activeTab = "history";
    fetchError = null;
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
          return parseActions({ actions: [action] }, (action as { sessionId: string }).sessionId);
        });
      } else projectionErrors.inbox = "Unable to load inbox: invalid response.";
    } else projectionErrors.inbox = fetchFailure("Unable to load inbox", hitlResult.reason);
    if (historyResult.status === "fulfilled") {
      const body = historyResult.value;
      if (typeof body === "object" && body !== null && Array.isArray((body as { sessions?: unknown }).sessions)) {
        const history = (body as { sessions: unknown[] }).sessions.filter(isSession);
        sessions = [...new Map([...sessions, ...history].map((session) => [session.id, session])).values()];
      } else projectionErrors.history = "Unable to load history: invalid response.";
    } else projectionErrors.history = fetchFailure("Unable to load history", historyResult.reason);
    if (selectedSessionId && !sessions.some((session) => session.id === selectedSessionId)) {
      selectedSessionId = null;
      activeTab = "inbox";
      fetchError = "The requested session is unavailable to this device.";
    }
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
  const deepLinkedSession = requestedSessionId();
  if (deepLinkedSession) {
    selectedSessionId = deepLinkedSession;
    activeTab = "sessions";
  }
  render();
  if (pairingRequired) return;
  multiTab.start();
  reconnectUpdates();
}

void start();
