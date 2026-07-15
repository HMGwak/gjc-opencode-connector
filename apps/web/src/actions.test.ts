import { expect, test } from "bun:test";
import { actionErrorMessage, actionPath, actionResponsePath, actionStateText, artifactContentPath, isTerminalAction, parseActions, submitActionResponse, type PendingAction } from "./actions";

const action: PendingAction = {
  id: "action/b",
  sessionId: "session/a",
  version: 2,
  type: "confirm",
  status: "pending",
  expiresAt: "2030-01-01T00:00:00.000Z",
  payload: { summary: "Proceed" },
  artifactIds: ["opaque/token"],
};

test("uses global owner-scoped action and artifact content routes", () => {
  expect(actionPath()).toBe("/actions");
  expect(actionResponsePath("action/b")).toBe("/actions/action%2Fb/response");
  expect(artifactContentPath("opaque/token")).toBe("/artifacts/opaque%2Ftoken/content");
});

test("parses only canonical statuses and makes every terminal status non-actionable", () => {
  const parsed = parseActions({ actions: ["pending", "answered", "cancelled", "expired", "unknown"].map((status) => ({ ...action, status })) }, action.sessionId);
  expect(parsed.map(({ status }) => status)).toEqual(["pending", "answered", "cancelled", "expired", "unknown"]);
  expect(parsed.filter((candidate) => isTerminalAction(candidate, Date.parse("2026-01-01T00:00:00.000Z"))).map(({ status }) => status)).toEqual(["answered", "cancelled", "expired", "unknown"]);
  expect(parseActions({ actions: [{ ...action, status: "responded" }] }, action.sessionId)).toEqual([]);
  expect(parseActions({ actions: [{ ...action, sessionId: "other" }] }, action.sessionId)).toEqual([]);
});

test("submits the response through the canonical URL with version, response, and idempotency key", async () => {
  let received: { path: string; method?: string; key: string | null; body: unknown } | undefined;
  const response = await submitActionResponse(action, "approve", "stable-key", async (path, init) => {
    received = { path, method: init?.method, key: new Headers(init?.headers).get("Idempotency-Key"), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ action, duplicate: false }), { status: 202, headers: { "content-type": "application/json" } });
  });
  expect(response.status).toBe(202);
  expect(received).toEqual({ path: "/actions/action%2Fb/response", method: "POST", key: "stable-key", body: { version: 2, response: "approve" } });
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
