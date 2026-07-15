import { CorruptPersistentDataError, DurableCommandDispatcher, type AgentAdapter, type CoreDatabase, type Session } from "@planee/core";
import { AccessJwtVerifier, type AccessClaims } from "./auth";
import { ActionApiError, type ArtifactMetadata, type ArtifactService, type HubPendingActionService, type PendingAction } from "./actions";
import { prometheusMetrics, type HubMetricsOptions } from "./metrics";
import { readiness, type RecoveryState } from "./readiness";

const JSON_LIMIT = 64 * 1024;
const PUSH_BODY_LIMIT = 16 * 1024;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;

export interface HubServerOptions {
  readonly database: CoreDatabase;
  readonly auth: AccessJwtVerifier;
  readonly publicOrigin?: string;
  readonly bodyLimitBytes?: number;
  readonly commandId?: () => string;
  readonly rateLimit?: { readonly maxRequests: number; readonly windowMs: number };
  readonly adapters?: Readonly<Record<string, AgentAdapter>>;
  readonly adapterHealth?: HubMetricsOptions["adapterHealth"];
  /** Access subject permitted to scrape operational metrics. */
  readonly metricsOwnerId?: string;
  readonly authorizeSession?: (sessionId: string, ownerId: string) => boolean;
  readonly actions?: HubPendingActionService;
  readonly artifacts?: ArtifactService;
  readonly push?: PushSubscriptionService;
}
export interface PushSubscriptionService {
  publicKey(): Promise<string> | string;
  subscribe(input: { readonly ownerId: string; readonly subscription: PushSubscriptionJSON; readonly idempotencyKey: string }): Promise<{ readonly duplicate: boolean }> | { readonly duplicate: boolean };
  unsubscribe(input: { readonly ownerId: string; readonly endpoint: string; readonly idempotencyKey: string }): Promise<{ readonly duplicate: boolean }> | { readonly duplicate: boolean };
}

type PushSubscriptionJSON = {
  readonly endpoint: string;
  readonly expirationTime?: number | null;
  readonly keys: { readonly p256dh: string; readonly auth: string };
};


const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);
const commandId = (): string => crypto.randomUUID();
const safeFilename = (filename: string): string => filename.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact";
const decodeRouteId = (value: string): string | Response => {
  try { return decodeURIComponent(value); } catch { return error(400, "bad_request", "Invalid request"); }
};

function sessionFromRow(row: Session): Session {
  return row;
}


const contentLengthError = (request: Request, limit: number): Response | null => {
  const value = request.headers.get("content-length");
  if (!value) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) return error(400, "bad_request", "Invalid Content-Length");
  return Number(value) > limit ? error(413, "payload_too_large", "Request body too large") : null;
};

async function parsePrompt(request: Request, limit: number): Promise<{ prompt: string } | Response> {
  const lengthError = contentLengthError(request, limit); if (lengthError) return lengthError;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) return error(413, "payload_too_large", "Request body too large");
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { prompt?: unknown };
    if (typeof value.prompt !== "string" || value.prompt.length === 0) return error(400, "bad_request", "prompt is required");
    return { prompt: value.prompt };
  } catch { return error(400, "bad_request", "Invalid JSON"); }
}
const actionWire = (action: PendingAction) => ({ id: action.id, sessionId: action.sessionId, version: action.version, expiresAt: action.expiresAt, status: action.status, type: action.type, payload: action.payload, artifactIds: action.artifactIds });
const artifactWire = (artifact: ArtifactMetadata) => ({ id: artifact.id, name: artifact.name, contentType: artifact.contentType, size: artifact.size, createdAt: artifact.createdAt });

async function parseActionResponse(request: Request, limit: number): Promise<{ version: number; response: unknown } | Response> {
  const lengthError = contentLengthError(request, limit); if (lengthError) return lengthError;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) return error(413, "payload_too_large", "Request body too large");
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown; response?: unknown };
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 0 || !Object.hasOwn(value, "response")) return error(400, "action_invalid", "version and response are required");
    return { version: value.version as number, response: value.response };
  } catch { return error(400, "action_invalid", "Invalid JSON"); }
}
async function parsePushSubscription(request: Request, limit: number): Promise<PushSubscriptionJSON | Response> {
  const lengthError = contentLengthError(request, limit); if (lengthError) return lengthError;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) return error(413, "payload_too_large", "Request body too large");
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { subscription?: PushSubscriptionJSON };
    const subscription = value.subscription;
    if (!subscription || typeof subscription.endpoint !== "string" || subscription.endpoint.length > 4096 || typeof subscription.keys?.p256dh !== "string" || typeof subscription.keys?.auth !== "string" || subscription.keys.p256dh.length > 512 || subscription.keys.auth.length > 512) return error(400, "push_invalid", "Invalid push subscription");
    const endpoint = new URL(subscription.endpoint);
    if (endpoint.protocol !== "https:" || !/^[A-Za-z0-9_-]+$/.test(subscription.keys.p256dh) || !/^[A-Za-z0-9_-]+$/.test(subscription.keys.auth)) return error(400, "push_invalid", "Invalid push subscription");
    return subscription;
  } catch { return error(400, "push_invalid", "Invalid push subscription"); }
}

async function parsePushEndpoint(request: Request, limit: number): Promise<string | Response> {
  const lengthError = contentLengthError(request, limit); if (lengthError) return lengthError;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) return error(413, "payload_too_large", "Request body too large");
  try {
    const endpoint = (JSON.parse(new TextDecoder().decode(bytes)) as { endpoint?: unknown }).endpoint;
    if (typeof endpoint !== "string" || endpoint.length > 4096 || new URL(endpoint).protocol !== "https:") return error(400, "push_invalid", "Invalid push endpoint");
    return endpoint;
  } catch { return error(400, "push_invalid", "Invalid push endpoint"); }
}

const serviceError = (cause: unknown): Response => {
  if (cause instanceof ActionApiError) {
    switch (cause.code) {
      case "unknown": return error(404, "action_unknown", "Action not found");
      case "expired": return error(409, "action_expired", "Action expired");
      case "stale": return error(409, "action_stale", "Stale action version");
      case "forbidden": return error(403, "action_forbidden", "Forbidden");
      case "invalid": return error(400, "action_invalid", "Invalid action request");
      case "range": return error(416, "range_not_satisfiable", "Invalid range");
      case "traversal": return error(400, "bad_request", "Invalid request");
    }
  }
  return error(500, "internal_error", "Internal server error");
};

const parseRange = (value: string | null): { start: number; end: number } | undefined | Response => {
  if (!value) return undefined;
  const match = /^bytes=(\d+)-(\d+)$/.exec(value);
  if (!match) return error(416, "range_not_satisfiable", "Invalid range");
  const start = Number(match[1]); const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end ? { start, end } : error(416, "range_not_satisfiable", "Invalid range");
};

export function createHubServer(options: HubServerOptions): { fetch(request: Request): Promise<Response> } {
  const origin = options.publicOrigin ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const limit = options.bodyLimitBytes ?? JSON_LIMIT;
  const requests = new Map<string, { count: number; resetAt: number }>();
  const ownsSession = (sessionId: string, ownerId: string): boolean => {
    const session = options.database.getSessionForOwner(sessionId, ownerId);
    return session !== null && (options.authorizeSession?.(sessionId, ownerId) ?? true);
  };
  const authenticate = async (request: Request): Promise<AccessClaims | Response> => {
    const token = request.headers.get("cf-access-jwt-assertion") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return error(401, "unauthorized", "Authentication required");
    try { return await options.auth.verify(token); } catch { return error(401, "unauthorized", "Authentication required"); }
  };
  const rateLimit = (subject: string): Response | null => {
    const policy = options.rateLimit ?? { maxRequests: 120, windowMs: 60_000 };
    const now = Date.now();
    const previous = requests.get(subject);
    const entry = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + policy.windowMs } : previous;
    entry.count++;
    requests.set(subject, entry);
    return entry.count > policy.maxRequests ? error(429, "rate_limited", "Rate limit exceeded") : null;
  };
  const csrf = (request: Request): Response | null => {
    if (request.headers.get("origin") !== origin) return error(403, "forbidden", "CSRF origin rejected");
    return null;
  };

  let recoveryState: RecoveryState = "recovering";
  const recovery = Promise.resolve().then(async () => {
    const commands = options.database.listCommandsForRecovery<{ prompt: string }>();
    await Promise.all(commands.map(async (command) => {
      const session = options.database.getSession(command.sessionId);
      const adapter = session ? options.adapters?.[session.adapter] : undefined;
      const dispatcher = new DurableCommandDispatcher<{ prompt: string }>({
        database: options.database,
        remote: {
          supportsCorrelation: false,
          dispatch: async ({ command: pending }) => {
            if (!adapter?.prompt || !session) throw new Error("No prompt-capable adapter is registered");
            await adapter.prompt(session.remoteId, pending.payload.prompt);
          },
        },
        eventType: "session.prompt.remote-confirmed",
        unknownEventType: "session.prompt.unknown",
      });
      await dispatcher.recover(command.id);
    }));
    recoveryState = "ready";
  }).catch(() => {
    recoveryState = "failed";
  });
  return { async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      const status = await readiness({ database: options.database, adapters: options.adapters, adapterHealth: options.adapterHealth }, recoveryState);
      return json({ ok: status.ok, readiness: status }, status.ok ? 200 : 503);
    }
    if (!url.pathname.startsWith("/api/v1/")) return error(404, "not_found", "Not found");
    const claims = await authenticate(request);
    if (claims instanceof Response) return claims;
    const limited = rateLimit(claims.sub);
    if (limited) return limited;
    if (request.method !== "GET" && request.method !== "HEAD") {
      await recovery;
      if (recoveryState !== "ready") return error(503, "recovery_unready", "Command recovery is not ready");
    }
    if (request.method === "GET" && url.pathname === "/api/v1/metrics") {
      if (!options.metricsOwnerId || claims.sub !== options.metricsOwnerId) return error(403, "forbidden", "Metrics access is restricted");
      return new Response(await prometheusMetrics({ database: options.database, adapters: options.adapters, adapterHealth: options.adapterHealth }), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/push/public-key") {
      if (!options.push) return error(404, "not_found", "Not found");
      try {
        const publicKey = await options.push.publicKey();
        if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(publicKey)) return error(500, "internal_error", "Invalid push configuration");
        return json({ publicKey });
      } catch { return error(500, "internal_error", "Internal server error"); }
    }
    if (request.method === "POST" && url.pathname === "/api/v1/push/subscriptions") {
      if (!options.push) return error(404, "not_found", "Not found");
      const csrfFailure = csrf(request); if (csrfFailure) return csrfFailure;
      const key = request.headers.get("idempotency-key");
      if (!key || key.trim().length === 0 || key.length > 256) return error(400, "push_invalid", "Idempotency-Key is required");
      const subscription = await parsePushSubscription(request, Math.min(limit, PUSH_BODY_LIMIT)); if (subscription instanceof Response) return subscription;
      try {
        const result = await options.push.subscribe({ ownerId: claims.sub, subscription, idempotencyKey: key });
        return json({ duplicate: result.duplicate }, result.duplicate ? 200 : 202);
      } catch { return error(409, "push_conflict", "Push subscription rejected"); }
    }
    if (request.method === "DELETE" && url.pathname === "/api/v1/push/subscriptions") {
      if (!options.push) return error(404, "not_found", "Not found");
      const csrfFailure = csrf(request); if (csrfFailure) return csrfFailure;
      const key = request.headers.get("idempotency-key");
      if (!key || key.trim().length === 0 || key.length > 256) return error(400, "push_invalid", "Idempotency-Key is required");
      const endpoint = await parsePushEndpoint(request, Math.min(limit, PUSH_BODY_LIMIT)); if (endpoint instanceof Response) return endpoint;
      try {
        const result = await options.push.unsubscribe({ ownerId: claims.sub, endpoint, idempotencyKey: key });
        return json({ duplicate: result.duplicate }, result.duplicate ? 200 : 202);
      } catch { return error(409, "push_conflict", "Push subscription rejected"); }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/actions") {
      if (!options.actions) return error(404, "not_found", "Not found");
      try {
        const actions = await options.actions.list(claims.sub);
        return json({ actions: actions.filter((action) => action.ownerId === claims.sub).map(actionWire) });
      } catch (cause) { return serviceError(cause); }
    }
    const actionMatch = /^\/api\/v1\/actions\/([^/]+)\/response$/.exec(url.pathname);
    if (request.method === "POST" && actionMatch) {
      if (!options.actions) return error(404, "not_found", "Not found");
      const id = decodeRouteId(actionMatch[1]!); if (id instanceof Response) return id;
      const csrfFailure = csrf(request); if (csrfFailure) return csrfFailure;
      const key = request.headers.get("idempotency-key");
      if (!key || key.trim().length === 0 || key.length > 256) return error(400, "action_invalid", "Idempotency-Key is required");
      const body = await parseActionResponse(request, limit); if (body instanceof Response) return body;
      try {
        const owned = await options.actions.list(claims.sub);
        if (!owned.some((action) => action.id === id && action.ownerId === claims.sub)) return error(403, "action_forbidden", "Forbidden");
        const result = await options.actions.respondWithEvent({ id, ownerId: claims.sub, version: body.version, response: body.response, idempotencyKey: key });
        return json({ action: actionWire(result.action), duplicate: result.duplicate }, result.duplicate ? 200 : 202);
      } catch (cause) { return serviceError(cause); }
    }
    const artifactMatch = /^\/api\/v1\/artifacts\/([^/]+)(\/content)?$/.exec(url.pathname);
    if (request.method === "GET" && artifactMatch) {
      if (!options.artifacts) return error(404, "not_found", "Not found");
      const id = decodeRouteId(artifactMatch[1]!); if (id instanceof Response) return id;
      try {
        if (!artifactMatch[2]) {
          const metadata = await options.artifacts.getMetadata(id, claims.sub);
          return json({ artifact: artifactWire(metadata) });
        }
        const range = parseRange(request.headers.get("range")); if (range instanceof Response) return range;
        const content = await options.artifacts.getContent(id, claims.sub, range);
        const headers = new Headers({
          "content-type": content.artifact.contentType,
          "content-disposition": `attachment; filename="${safeFilename(content.artifact.name)}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
          "accept-ranges": "bytes",
        });
        if (content.range) {
          headers.set("content-range", `bytes ${content.range.start}-${content.range.end}/${content.artifact.size}`);
          headers.set("content-length", String(content.range.end - content.range.start + 1));
        } else headers.set("content-length", String(content.artifact.size));
        return new Response(content.content, { status: content.range ? 206 : 200, headers });
      } catch (cause) { return serviceError(cause); }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/sessions") {
      return json({ sessions: options.database.listSessionsForOwner(claims.sub).filter((session) => options.authorizeSession?.(session.id, claims.sub) ?? true).map(sessionFromRow) });
    }
    const promptMatch = /^\/api\/v1\/sessions\/([^/]+)\/prompt$/.exec(url.pathname);
    if (request.method === "POST" && promptMatch) {
      const sessionId = decodeRouteId(promptMatch[1]!); if (sessionId instanceof Response) return sessionId;
      const csrfFailure = csrf(request); if (csrfFailure) return csrfFailure;
      const key = request.headers.get("idempotency-key");
      if (!key || key.length > 256) return error(400, "bad_request", "Idempotency-Key is required");
      if (!ownsSession(sessionId, claims.sub)) {
        return options.database.getSession(sessionId) ? error(403, "forbidden", "Forbidden") : error(404, "not_found", "Session not found");
      }
      const body = await parsePrompt(request, limit); if (body instanceof Response) return body;
      try {
        const id = (options.commandId ?? commandId)();
        const accepted = options.database.acceptCommandWithEvent({ id, sessionId, idempotencyKey: key, payload: body, eventType: "session.prompt.accepted", eventPayload: { commandId: id } });
        if (!accepted.duplicate) {
          const session = options.database.getSession(accepted.command.sessionId)!;
          const adapter = options.adapters?.[session.adapter];
          const dispatcher = new DurableCommandDispatcher<{ prompt: string }>({
            database: options.database,
            remote: {
              supportsCorrelation: false,
              dispatch: async ({ command }) => {
                if (!adapter?.prompt) throw new Error("No prompt-capable adapter is registered");
                await adapter.prompt(session.remoteId, command.payload.prompt);
              },
            },
            eventType: "session.prompt.remote-confirmed",
            unknownEventType: "session.prompt.unknown",
          });
          await dispatcher.dispatch(accepted.command.id);
        }
        return json({ command: options.database.getCommand(accepted.command.id)!, duplicate: accepted.duplicate }, accepted.duplicate ? 200 : 202);
      } catch { return error(409, "conflict", "Mutation rejected"); }
    }
    const eventsMatch = /^\/api\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method === "GET" && eventsMatch) {
      const sessionId = decodeRouteId(eventsMatch[1]!); if (sessionId instanceof Response) return sessionId;
      if (!ownsSession(sessionId, claims.sub)) {
        return options.database.getSession(sessionId) ? error(403, "forbidden", "Forbidden") : error(404, "not_found", "Session not found");
      }
      const cursorText = request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0";
      if (!/^\d+$/.test(cursorText)) return error(400, "bad_request", "Invalid cursor");
      const after = Number(cursorText);
      const bounds = options.database.sqlite.query("SELECT MIN(seq) AS first, MAX(seq) AS last FROM events WHERE session_id = ?").get(sessionId) as { first: number | null; last: number | null };
      if (bounds.first !== null && after < bounds.first - 1) return json({ reset: "snapshot-required" }, 410);
      try {
        const events = options.database.listEvents<unknown>(sessionId, after);
        const wire = events.map((event) => `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
        return new Response(wire, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" } });
      } catch (cause) {
        if (cause instanceof CorruptPersistentDataError) return error(500, "corrupt_data", "Session event data is corrupt");
        return error(500, "internal_error", "Internal server error");
      }
    }
    return error(404, "not_found", "Not found");
  } };
}

export function listenHub(options: HubServerOptions & { readonly hostname?: string; readonly port?: number }): ReturnType<typeof Bun.serve> {
  const handler = createHubServer(options);
  return Bun.serve({ hostname: options.hostname ?? DEFAULT_HOST, port: options.port ?? DEFAULT_PORT, fetch: handler.fetch });
}
