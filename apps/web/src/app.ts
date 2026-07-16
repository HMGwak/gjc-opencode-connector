import { renderActions as renderSessionActions } from "./actions";
import { clearCredential, saveCredential, SecureCredentialUnavailableError, storedCredential } from "./credential";
import { enablePush, revokePush, revokePushWhenPermissionLost } from "./push";
import { MultiTabCoordinator } from "./multitab";
type Session = {
  id: string;
  adapter: string;
  status: "active" | "stale" | "unknown" | "terminal";
  updatedAt: string;
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
let sessions: Session[] = [];
let selectedSessionId: string | null = null;
let activeTab = "sessions";
let reconnectTimer: number | undefined;
let online = navigator.onLine;
let streamConnected = false;
let loadingSessions = false;
let fetchError: string | null = null;
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
    header.append(error);
  }

  const panel = element("section");
  panel.className = "panel";
  panel.setAttribute("aria-label", `${activeTab} panel`);
  if (activeTab === "sessions") renderSessions(panel);
  if (activeTab === "conversation") renderConversation(panel);
  if (activeTab === "actions") renderActions(panel);
  if (activeTab === "settings") renderSettings(panel);

  const navigation = element("nav");
  navigation.className = "tabs";
  navigation.setAttribute("aria-label", "Main navigation");
  for (const [id, label] of [["sessions", "Sessions"], ["conversation", "Conversation"], ["actions", "Actions"], ["settings", "Settings"]] as const) {
    const button = element("button", label);
    button.type = "button";
    button.dataset.tab = id;
    button.setAttribute("aria-current", id === activeTab ? "page" : "false");
    button.addEventListener("click", () => { activeTab = id; render(); });
    navigation.append(button);
  }
  app.append(header, panel, navigation);
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
    void loadSessions();
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

function renderSessions(panel: HTMLElement): void {
  panel.append(element("h2", "Sessions"));
  if (loadingSessions) panel.append(element("p", "Loading sessions…"));
  if (!loadingSessions && sessions.length === 0) panel.append(element("p", "No sessions are available."));
  const list = element("ul");
  list.className = "session-list";
  for (const session of sessions) {
    const item = element("li");
    const button = element("button");
    button.type = "button";
    button.className = "session";
    button.setAttribute("aria-pressed", String(session.id === selectedSessionId));
    button.append(element("strong", session.adapter), element("span", session.status), element("small", new Date(session.updatedAt).toLocaleString()));
    button.addEventListener("click", () => {
      if (selectedSessionId && selectedSessionId !== session.id) multiTab.releaseSession(selectedSessionId);
      selectedSessionId = session.id;
      multiTab.requestSession(session.id);
      activeTab = "conversation";
      render();
    });
    item.append(button);
    list.append(item);
  }
  panel.append(list);
}

function renderConversation(panel: HTMLElement): void {
  panel.append(element("h2", "Conversation"));
  if (!selectedSessionId) {
    panel.append(element("p", "Select a session to view its conversation."));
    return;
  }
  const messages = element("ol");
  messages.id = "messages";
  messages.className = "messages";
  messages.setAttribute("aria-label", "Session messages");
  panel.append(messages);
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
    if (pendingPrompt && pendingPrompt.sessionId === selectedSessionId && input.value.trim() !== pendingPrompt.prompt) pendingPrompt = null;
  });
  const submit = element("button", "Send");
  submit.type = "submit";
  form.append(label, input, submit);
  form.addEventListener("submit", (event) => void sendPrompt(event, input, submit));
  panel.append(form);
  multiTab.requestSession(selectedSessionId);
}

function renderActions(panel: HTMLElement): void {
  if (!selectedSessionId) {
    renderSessionActions(panel, null, api);
    return;
  }
  renderSessionActions(panel, selectedSessionId, api);
}

function renderSettings(panel: HTMLElement): void {
  panel.append(element("h2", "Settings"));
  panel.append(element("p", "Updates reconnect automatically when network access returns."));
  const reconnect = element("button", "Reconnect updates");
  reconnect.type = "button";
  reconnect.addEventListener("click", reconnectUpdates);
  panel.append(reconnect);
  const push = element("button", "Enable push notifications");
  push.type = "button";
  push.addEventListener("click", () => void configurePush(push));
  panel.append(push);
}

function appendMessage(sessionId: string, value: unknown): void {
  if (sessionId !== selectedSessionId) return;
  const list = document.querySelector<HTMLOListElement>("#messages");
  if (!list) return;
  const message = element("li");
  message.textContent = typeof value === "string" ? value : JSON.stringify(value);
  list.append(message);
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

async function loadSessions(): Promise<void> {
  loadingSessions = true;
  render();
  try {
    const response = await api("/sessions");
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !Array.isArray((body as { sessions?: unknown }).sessions)) throw new Error("invalid sessions response");
    sessions = (body as { sessions: unknown[] }).sessions.filter(isSession);
    fetchError = null;
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
  render();
  if (pairingRequired) return;
  multiTab.start();
  void loadSessions();
  reconnectUpdates();
}

void start();
