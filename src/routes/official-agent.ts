import { randomUUID, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { getConfig } from "../config.js";
import { CodexAppServerClient } from "../codex-app-server/client.js";
import type {
  CodexAppServerBridge,
  OfficialAgentApprovalPolicy,
  StartThreadParams,
  StartTurnAppMention,
  StartTurnParams,
} from "../codex-app-server/types.js";

type BridgeFactory = () => CodexAppServerBridge;

let sharedBridge: CodexAppServerBridge | null = null;

type SessionStatus = "idle" | "running" | "closed";

interface OfficialAgentSession {
  sessionId: string;
  threadId: string;
  status: SessionStatus;
  model: string | null;
  cwd: string | null;
  createdAt: string;
  lastActivityAt: string;
  currentTurnId: string | null;
  upstreamTurnId: string | null;
  cancelRequested: boolean;
  cancelSent: boolean;
  archivedAt: string | null;
  lastError: string | null;
}

const sessions = new Map<string, OfficialAgentSession>();
let sessionCleanupTimer: NodeJS.Timeout | null = null;
let sessionCleanupBridgeFactory: BridgeFactory | null = null;

function getSharedBridge(): CodexAppServerBridge {
  if (sharedBridge) return sharedBridge;
  const config = getConfig();
  sharedBridge = new CodexAppServerClient({
    url: config.official_agent.app_server_url,
    auth: config.official_agent.auth,
    requestTimeoutMs: config.official_agent.request_timeout_ms,
    clientInfo: {
      name: "codex_proxy",
      title: "Codex Proxy",
      version: "2.0.69",
    },
  });
  return sharedBridge;
}

export async function closeOfficialAgentBridgeForTesting(): Promise<void> {
  await sharedBridge?.close();
  sharedBridge = null;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function isAuthorized(authHeader: string | undefined, expectedKey: string | null): boolean {
  if (!expectedKey) return false;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

import { isRecord } from "../translation/shared-utils.js";

function parseStartThread(body: unknown): StartThreadParams {
  if (!isRecord(body)) return {};
  return {
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
  };
}

function parseAppMention(value: unknown): StartTurnAppMention | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

const APPROVAL_POLICIES: readonly OfficialAgentApprovalPolicy[] = ["untrusted", "on-request", "on-failure", "never"];

function isApprovalPolicy(value: string): value is OfficialAgentApprovalPolicy {
  return APPROVAL_POLICIES.includes(value as OfficialAgentApprovalPolicy);
}

type ParseStartTurnResult =
  | { ok: true; params: StartTurnParams }
  | { ok: false; message: string };

function parseStartTurn(threadId: string, body: unknown): ParseStartTurnResult {
  if (!isRecord(body) || typeof body.text !== "string" || body.text.trim() === "") {
    return { ok: false, message: "text is required" };
  }
  if (body.approvalPolicy !== undefined) {
    if (typeof body.approvalPolicy !== "string" || !isApprovalPolicy(body.approvalPolicy)) {
      return { ok: false, message: `approvalPolicy must be one of: ${APPROVAL_POLICIES.join(", ")}` };
    }
  }
  const app = parseAppMention(body.app);
  return { ok: true, params: {
    threadId,
    text: body.text,
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    ...(body.approvalPolicy !== undefined ? { approvalPolicy: body.approvalPolicy } : {}),
    ...(app ? { app } : {}),
  } };
}

function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function extractString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key];
  }
  for (const nestedKey of ["thread", "turn", "result", "data"]) {
    const nested = extractString(value[nestedKey], keys);
    if (nested) return nested;
  }
  return null;
}

async function cancelRunningTurn(session: OfficialAgentSession, bridge: CodexAppServerBridge): Promise<"sent" | "pending" | "ignored"> {
  if (session.status !== "running" || !session.currentTurnId) return "ignored";
  session.cancelRequested = true;
  session.lastActivityAt = new Date().toISOString();
  if (!session.upstreamTurnId) return "pending";
  if (session.cancelSent) return "sent";
  await bridge.interruptTurn(session.threadId, session.upstreamTurnId);
  session.cancelSent = true;
  return "sent";
}

async function disposeSession(session: OfficialAgentSession, bridge: CodexAppServerBridge, reason: "delete" | "ttl") {
  let interrupted = false;
  if (session.status === "running") {
    try { interrupted = (await cancelRunningTurn(session, bridge)) === "sent"; }
    catch (error) { session.lastError = error instanceof Error ? error.message : String(error); }
  }
  let archived = false;
  let archiveError: string | undefined;
  try {
    await bridge.archiveThread(session.threadId);
    archived = true;
    session.archivedAt = new Date().toISOString();
  } catch (error) {
    archiveError = error instanceof Error ? error.message : String(error);
    session.lastError = archiveError;
    console.warn(`[official-agent] Failed to archive thread during ${reason}: ${archiveError}`);
  }
  session.status = "closed";
  sessions.delete(session.sessionId);
  return { interrupted, archived, ...(archiveError ? { archiveError } : {}) };
}

async function cleanupExpiredSessions(bridgeFactory: BridgeFactory): Promise<void> {
  const config = getConfig();
  const cutoff = Date.now() - config.official_agent.session_idle_ttl_hours * 60 * 60 * 1000;
  for (const session of [...sessions.values()]) {
    if (session.status === "running" || Date.parse(session.lastActivityAt) > cutoff) continue;
    await disposeSession(session, bridgeFactory(), "ttl");
  }
}

async function* turnEventStream(
  bridge: CodexAppServerBridge,
  params: StartTurnParams,
): AsyncGenerator<string> {
  for await (const event of bridge.runTurn(params)) {
    if (event.type === "result") {
      yield encodeSse("official_agent.result", event.result);
    } else {
      yield encodeSse(event.notification.method, event.notification);
    }
  }
}

export function createOfficialAgentRoutes(bridgeFactory: BridgeFactory = getSharedBridge): Hono {
  const app = new Hono();
  sessionCleanupBridgeFactory = bridgeFactory;
  if (!sessionCleanupTimer) {
    sessionCleanupTimer = setInterval(() => {
      if (sessionCleanupBridgeFactory) void cleanupExpiredSessions(sessionCleanupBridgeFactory);
    }, getConfig().official_agent.session_cleanup_interval_minutes * 60 * 1000);
    sessionCleanupTimer.unref?.();
  }

  app.use("/official-agent/*", async (c, next) => {
    const config = getConfig();
    if (!config.official_agent.enabled) {
      c.status(503);
      return c.json(errorBody("official_agent_disabled", "Official Codex app-server bridge is disabled"));
    }
    const apiKey = process.env.PROXY_API_KEY?.trim();
    if (!apiKey) {
      c.status(503);
      return c.json(errorBody("proxy_api_key_missing", "PROXY_API_KEY is required"));
    }
    if (!isAuthorized(c.req.header("Authorization"), apiKey)) {
      c.status(401);
      return c.json(errorBody("invalid_api_key", "Invalid official-agent API key"));
    }
    await next();
  });

  app.post("/official-agent/sessions", async (c) => {
    const config = getConfig();
    if (sessions.size >= config.official_agent.max_sessions) {
      c.header("Retry-After", "60");
      c.status(429);
      return c.json(errorBody("session_limit_reached", "Maximum number of sessions reached"));
    }
    let body: unknown = {};
    try { body = await c.req.json(); } catch { /* empty body is valid */ }
    const params = parseStartThread(body);
    const result = await bridgeFactory().startThread(params);
    const threadId = extractString(result, ["threadId", "id"]);
    if (!threadId) {
      c.status(502);
      return c.json(errorBody("invalid_app_server_response", "App Server did not return a thread id"));
    }
    const now = new Date().toISOString();
    const session: OfficialAgentSession = {
      sessionId: randomUUID(),
      threadId,
      status: "idle",
      model: params.model ?? null,
      cwd: params.cwd ?? null,
      createdAt: now,
      lastActivityAt: now,
      currentTurnId: null,
      upstreamTurnId: null,
      cancelRequested: false,
      cancelSent: false,
      archivedAt: null,
      lastError: null,
    };
    sessions.set(session.sessionId, session);
    return c.json(session, 201);
  });

  app.get("/official-agent/sessions", (c) => c.json({ data: [...sessions.values()] }));

  app.get("/official-agent/sessions/:sessionId", (c) => {
    const session = sessions.get(c.req.param("sessionId"));
    if (!session) {
      c.status(404);
      return c.json(errorBody("session_not_found", "Session not found"));
    }
    return c.json(session);
  });

  app.delete("/official-agent/sessions/:sessionId", async (c) => {
    const session = sessions.get(c.req.param("sessionId"));
    if (!session) {
      c.status(404);
      return c.json(errorBody("session_not_found", "Session not found"));
    }
    const result = await disposeSession(session, bridgeFactory(), "delete");
    return c.json({ deleted: true, sessionId: session.sessionId, threadId: session.threadId, ...result });
  });

  app.post("/official-agent/sessions/:sessionId/turns", async (c) => {
    const session = sessions.get(c.req.param("sessionId"));
    if (!session) {
      c.status(404);
      return c.json(errorBody("session_not_found", "Session not found"));
    }
    if (session.status === "running") {
      c.status(409);
      return c.json(errorBody("session_busy", "This session already has a running turn"));
    }
    let body: unknown;
    try { body = await c.req.json(); } catch {
      c.status(400);
      return c.json(errorBody("invalid_json", "Malformed JSON request body"));
    }
    const parsed = parseStartTurn(session.threadId, body);
    if (!parsed.ok) {
      c.status(400);
      return c.json(errorBody("invalid_request", parsed.message));
    }

    const localTurnId = randomUUID();
    session.status = "running";
    session.currentTurnId = localTurnId;
    session.upstreamTurnId = null;
    session.cancelRequested = false;
    session.cancelSent = false;
    session.lastError = null;
    session.lastActivityAt = new Date().toISOString();
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          controller.enqueue(encoder.encode(encodeSse("official_agent.turn_started", {
            sessionId: session.sessionId,
            turnId: localTurnId,
          })));
          for await (const event of bridgeFactory().runTurn(parsed.params)) {
            if (event.type === "result") {
              session.upstreamTurnId = extractString(event.result, ["turnId", "id"]);
              if (session.cancelRequested && session.upstreamTurnId && !session.cancelSent) {
                try {
                  await bridgeFactory().interruptTurn(session.threadId, session.upstreamTurnId);
                  session.cancelSent = true;
                } catch (error) { session.lastError = error instanceof Error ? error.message : String(error); }
              }
              if (!streamCancelled) controller.enqueue(encoder.encode(encodeSse("official_agent.result", { turnId: localTurnId, result: event.result })));
            } else {
              session.lastActivityAt = new Date().toISOString();
              if (!streamCancelled) controller.enqueue(encoder.encode(encodeSse(event.notification.method, event.notification)));
            }
          }
          if (!streamCancelled) controller.close();
        } catch (error) {
          session.lastError = error instanceof Error ? error.message : String(error);
          if (!streamCancelled) {
            controller.enqueue(encoder.encode(encodeSse("official_agent.error", errorBody("app_server_error", session.lastError))));
            controller.close();
          }
        } finally {
          if (sessions.get(session.sessionId) === session) {
            session.status = "idle";
            session.currentTurnId = null;
            session.upstreamTurnId = null;
            session.cancelRequested = false;
            session.cancelSent = false;
            session.lastActivityAt = new Date().toISOString();
          }
        }
      },
      async cancel() {
        streamCancelled = true;
        await cancelRunningTurn(session, bridgeFactory());
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  });

  app.post("/official-agent/sessions/:sessionId/turns/:turnId/cancel", async (c) => {
    const session = sessions.get(c.req.param("sessionId"));
    if (!session) {
      c.status(404);
      return c.json(errorBody("session_not_found", "Session not found"));
    }
    const turnId = c.req.param("turnId");
    if (session.status !== "running" || session.currentTurnId !== turnId) {
      c.status(404);
      return c.json(errorBody("turn_not_found", "Running turn not found"));
    }
    const result = await cancelRunningTurn(session, bridgeFactory());
    return c.json({ cancelled: result === "sent", pending: result === "pending", sessionId: session.sessionId, turnId }, result === "pending" ? 202 : 200);
  });

  app.get("/official-agent/apps", async (c) => {
    const cursor = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const result = await bridgeFactory().listApps({
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined && Number.isInteger(limit) ? { limit } : {}),
    });
    return c.json(result);
  });

  app.post("/official-agent/threads", async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const result = await bridgeFactory().startThread(parseStartThread(body));
    return c.json(result);
  });

  app.post("/official-agent/threads/:threadId/turns", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(errorBody("invalid_json", "Malformed JSON request body"));
    }

    const parsed = parseStartTurn(c.req.param("threadId"), body);
    if (!parsed.ok) {
      c.status(400);
      return c.json(errorBody("invalid_request", parsed.message));
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const chunk of turnEventStream(bridgeFactory(), parsed.params)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(encodeSse("official_agent.error", errorBody("app_server_error", message))));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
