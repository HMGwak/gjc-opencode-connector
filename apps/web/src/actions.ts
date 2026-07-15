export type ActionStatus = "pending" | "answered" | "cancelled" | "expired" | "unknown";

export type PendingAction = {
  readonly id: string;
  readonly sessionId: string;
  readonly version: number;
  readonly type: string;
  readonly status: ActionStatus;
  readonly expiresAt: string;
  readonly payload: unknown;
  readonly artifactIds: readonly string[];
};

export type ActionsRequest = (path: string, init?: RequestInit) => Promise<Response>;
export type ActionResponse = "approve" | "reject";

const terminalStates = new Set<ActionStatus>(["answered", "cancelled", "expired", "unknown"]);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function actionPath(): string {
  return "/actions";
}

export function actionResponsePath(actionId: string): string {
  return `/actions/${encodeURIComponent(actionId)}/response`;
}

export function artifactContentPath(opaqueId: string): string {
  return `/artifacts/${encodeURIComponent(opaqueId)}/content`;
}

export function isTerminalAction(action: Pick<PendingAction, "status" | "expiresAt">, now = Date.now()): boolean {
  return terminalStates.has(action.status) || Number.isNaN(Date.parse(action.expiresAt)) || Date.parse(action.expiresAt) <= now;
}

export function actionStateText(action: Pick<PendingAction, "status" | "expiresAt">, now = Date.now()): string {
  if (Number.isNaN(Date.parse(action.expiresAt)) || Date.parse(action.expiresAt) <= now) return "Expired";
  if (terminalStates.has(action.status)) return action.status[0]!.toUpperCase() + action.status.slice(1);
  return "Pending";
}

function isActionStatus(value: unknown): value is ActionStatus {
  return value === "pending" || value === "answered" || value === "cancelled" || value === "expired" || value === "unknown";
}

export function parseActions(value: unknown, sessionId: string): PendingAction[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { actions?: unknown }).actions)) return [];
  return (value as { actions: unknown[] }).actions.flatMap((item): PendingAction[] => {
    if (typeof item !== "object" || item === null) return [];
    const action = item as Record<string, unknown>;
    const version = action.version;
    if (typeof action.id !== "string" || action.sessionId !== sessionId || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0 || typeof action.type !== "string" || !isActionStatus(action.status) || typeof action.expiresAt !== "string" || !Object.hasOwn(action, "payload")) return [];
    const artifactIds = Array.isArray(action.artifactIds) ? action.artifactIds.filter((id): id is string => typeof id === "string") : [];
    return [{ id: action.id, sessionId, version, type: action.type, status: action.status, expiresAt: action.expiresAt, payload: action.payload, artifactIds }];
  });
}

export function actionErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || typeof (body as { error?: unknown }).error !== "object" || (body as { error: unknown }).error === null) return null;
  switch ((body as { error: { code?: unknown } }).error.code) {
    case "action_stale": return "This action has changed; refresh actions.";
    case "action_expired": return "This action has expired.";
    case "action_unknown": return "This action is unavailable and cannot be answered.";
    case "action_forbidden": return "This action is unavailable and cannot be answered.";
    case "action_invalid": return "This action response is invalid.";
    default: return null;
  }
}

export async function submitActionResponse(action: PendingAction, response: ActionResponse, key: string, request: ActionsRequest): Promise<Response> {
  return request(actionResponsePath(action.id), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ version: action.version, response }),
  });
}

function actionSummary(action: PendingAction): string {
  if (typeof action.payload === "object" && action.payload !== null && typeof (action.payload as { summary?: unknown }).summary === "string") return (action.payload as { summary: string }).summary;
  return JSON.stringify(action.payload) ?? "No details provided.";
}

export function renderActions(panel: HTMLElement, sessionId: string | null, request: ActionsRequest): void {
  panel.append(element("h2", "Actions"));
  if (!sessionId) {
    panel.append(element("p", "Select a session to review pending actions."));
    return;
  }
  const status = element("p", "Loading actions…");
  status.setAttribute("aria-live", "polite");
  panel.append(status);
  void loadActions(panel, sessionId, request, status);
}

async function loadActions(panel: HTMLElement, sessionId: string, request: ActionsRequest, status: HTMLElement): Promise<void> {
  try {
    const response = await request(actionPath());
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    const actions = parseActions(await response.json(), sessionId);
    status.remove();
    if (actions.length === 0) panel.append(element("p", "No pending actions."));
    for (const action of actions) panel.append(renderAction(action, request));
  } catch (error) {
    status.textContent = `Unable to load actions: ${error instanceof Error ? error.message : "unexpected error."}`;
  }
}

function renderAction(action: PendingAction, request: ActionsRequest): HTMLElement {
  const card = element("article");
  card.className = "action-card";
  card.append(element("h3", action.type), element("p", actionSummary(action)));
  const metadata = element("p", `Version ${action.version} · expires ${new Date(action.expiresAt).toLocaleString()} · ${actionStateText(action)}`);
  metadata.className = "action-meta";
  card.append(metadata);
  if (action.artifactIds.length > 0) {
    const artifacts = element("ul");
    artifacts.className = "artifact-list";
    for (const opaqueId of action.artifactIds) {
      const item = element("li");
      const link = element("a", "Download artifact");
      link.href = `/api/v1${artifactContentPath(opaqueId)}`;
      link.download = "";
      item.append(link);
      artifacts.append(item);
    }
    card.append(artifacts);
  }
  const result = element("p");
  result.className = "action-result";
  result.setAttribute("aria-live", "polite");
  card.append(result);
  if (isTerminalAction(action)) {
    result.textContent = actionStateText(action);
    return card;
  }
  const controls = element("div");
  controls.className = "action-controls";
  let retry: { response: ActionResponse; key: string } | null = null;
  for (const response of ["approve", "reject"] as const) {
    const button = element("button", response === "approve" ? "Approve" : "Reject");
    button.type = "button";
    button.addEventListener("click", () => {
      const key = retry?.response === response ? retry.key : crypto.randomUUID();
      retry = { response, key };
      void respond(action, response, key, request, controls, result);
    });
    controls.append(button);
  }
  card.append(controls);
  return card;
}

async function respond(action: PendingAction, response: ActionResponse, key: string, request: ActionsRequest, controls: HTMLElement, result: HTMLElement): Promise<void> {
  const buttons = Array.from(controls.querySelectorAll<HTMLButtonElement>("button"));
  if (buttons.some((button) => button.disabled)) return;
  for (const button of buttons) button.disabled = true;
  try {
    const reply = await submitActionResponse(action, response, key, request);
    if (reply.ok) {
      result.textContent = "Response recorded.";
      controls.remove();
      return;
    }
    const message = actionErrorMessage(await reply.json().catch(() => null));
    result.textContent = message ?? `Unable to record response (${reply.status}).`;
    if (message) controls.remove();
    else for (const button of buttons) button.disabled = false;
  } catch {
    result.textContent = "Unable to record response: network error.";
    for (const button of buttons) button.disabled = false;
  }
}
