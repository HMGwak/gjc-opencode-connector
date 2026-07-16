import { expect, test } from "bun:test";
import { actionErrorMessage, actionPath, actionResponsePath, actionStateText, artifactContentPath, isTerminalAction, parseActions, renderAction, submitActionResponse, type PendingAction } from "./actions";
const source = await Bun.file(new URL("./actions.ts", import.meta.url)).text();

const action: PendingAction = {
  id: "action/b",
  sessionId: "session/a",
  version: 2,
  type: "confirm",
  status: "pending",
  expiresAt: "2030-01-01T00:00:00.000Z",
  payload: { summary: "Proceed" },
  artifactIds: ["opaque/token"],
  allowedResponses: [{ value: "continue", label: "Continue safely" }],
};

test("uses global owner-scoped action and artifact content routes", () => {
  expect(actionPath()).toBe("/actions");
  expect(actionResponsePath("action/b")).toBe("/actions/action%2Fb/response");
  expect(artifactContentPath("opaque/token")).toBe("/artifacts/opaque%2Ftoken/content");
});

test("parses canonical statuses and validated allowed responses", () => {
  const parsed = parseActions({ actions: ["pending", "dispatching", "answered", "cancelled", "expired", "unknown"].map((status) => ({ ...action, status })) }, action.sessionId);
  expect(parsed.map(({ status }) => status)).toEqual(["pending", "dispatching", "answered", "cancelled", "expired", "unknown"]);
  expect(parsed.filter((candidate) => isTerminalAction(candidate, Date.parse("2026-01-01T00:00:00.000Z"))).map(({ status }) => status)).toEqual(["answered", "cancelled", "expired", "unknown"]);
  expect(actionStateText({ status: "dispatching", expiresAt: "2030-01-01T00:00:00.000Z" })).toBe("Processing response…");
  expect(parseActions({ actions: [{ ...action, allowedResponses: [{ value: "custom", label: "Custom choice" }, { value: "later" }, "dismiss"] }] }, action.sessionId)[0]?.allowedResponses).toEqual([{ value: "custom", label: "Custom choice" }, { value: "later", label: "later" }, { value: "dismiss", label: "dismiss" }]);
  expect(parseActions({ actions: [{ ...action, status: "responded" }] }, action.sessionId)).toEqual([]);
  expect(parseActions({ actions: [{ ...action, sessionId: "other" }] }, action.sessionId)).toEqual([]);
  expect(parseActions({ actions: [{ ...action, allowedResponses: [] }, { ...action, allowedResponses: ["ok", { label: "Missing value" }] }, { ...action, allowedResponses: [{ value: true, label: "Not opaque" }] }] }, action.sessionId)).toEqual([]);
});

test("renders only allowed controls and preserves unknown actions for manual review", () => {
  expect(source).toContain("for (const allowed of action.allowedResponses)");
  expect(source).toContain('const button = element("button", allowed.label);');
  expect(source).not.toContain('["approve", "reject"] as const');
  expect(source).toContain('action.status === "unknown" ? "Manual review required; action controls are unavailable."');
  expect(source).toContain('if (action.status === "dispatching") {');
});

test("submits the selected allowed response through the canonical URL with version and idempotency key", async () => {
  let received: { path: string; method?: string; key: string | null; body: unknown } | undefined;
  const response = await submitActionResponse(action, "continue", "stable-key", async (path, init) => {
    received = { path, method: init?.method, key: new Headers(init?.headers).get("Idempotency-Key"), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ action, duplicate: false }), { status: 202, headers: { "content-type": "application/json" } });
  });
  expect(response.status).toBe(202);
  expect(received).toEqual({ path: "/actions/action%2Fb/response", method: "POST", key: "stable-key", body: { version: 2, response: "continue" } });
});
test("renders custom controls exactly and gives unknown actions without controls a manual-review state", () => {
  class Node {
    readonly children: Node[] = [];
    readonly listeners = new Map<string, () => void>();
    className = "";
    textContent = "";
    type = "";
    disabled = false;
    isConnected = true;
    append(...nodes: Node[]): void { this.children.push(...nodes); }
    setAttribute(): void {}
    addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
    remove(): void {}
    querySelectorAll<T>(): T[] { return this.children.filter((node) => node.type === "button") as T[]; }
  }
  const originalDocument = globalThis.document;
  Object.assign(globalThis, { document: { createElement: () => new Node() } });
  try {
    const card = renderAction({ ...action, allowedResponses: [{ value: "hold", label: "Hold for review" }, { value: "skip", label: "Skip" }] }, async () => new Response(null, { status: 202 }));
    const controls = Array.from(card.children).find((child) => child.className === "action-controls")!;
    expect(Array.from(controls.children).map((button) => button.textContent)).toEqual(["Hold for review", "Skip"]);
    expect(Array.from(controls.children).map((button) => button.textContent)).not.toContain("Approve");
    const unknown = renderAction({ ...action, status: "unknown", allowedResponses: [] }, async () => new Response());
    expect(Array.from(unknown.children).find((child) => child.className === "action-result")?.textContent).toBe("Manual review required; action controls are unavailable.");
  } finally {
    Object.assign(globalThis, { document: originalDocument });
  }
});

test("maps stable live server error envelopes instead of HTTP statuses", () => {
  expect(actionErrorMessage({ error: { code: "action_stale", message: "Stale action version" } })).toBe("This action has changed; refresh actions.");
  expect(actionErrorMessage({ error: { code: "action_expired", message: "Action expired" } })).toBe("This action has expired.");
  expect(actionErrorMessage({ error: { code: "action_unknown", message: "Action not found" } })).toBe("This action is unavailable and cannot be answered.");
  expect(actionErrorMessage({ error: { code: "action_forbidden", message: "Forbidden" } })).toBe("This action is unavailable and cannot be answered.");
  expect(actionErrorMessage({ error: { code: "action_invalid", message: "Invalid action request" } })).toBe("This action response is invalid.");
  expect(actionErrorMessage({ error: "expired" })).toBeNull();
});

test("does not offer responses for stale, expired, or terminal actions", () => {
  const expiry = "2026-01-01T00:00:00.000Z";
  expect(isTerminalAction({ status: "pending", expiresAt: expiry }, Date.parse("2026-01-02T00:00:00.000Z"))).toBe(true);
  expect(actionStateText({ status: "cancelled", expiresAt: "2030-01-01T00:00:00.000Z" })).toBe("Cancelled");
  expect(isTerminalAction({ status: "unknown", expiresAt: "2030-01-01T00:00:00.000Z" })).toBe(true);
  expect(isTerminalAction({ status: "answered", expiresAt: "2030-01-01T00:00:00.000Z" })).toBe(true);
});
