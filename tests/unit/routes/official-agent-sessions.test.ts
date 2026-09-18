import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOfficialAgentRoutes,
  resetOfficialAgentStateForTesting,
} from "@src/routes/official-agent.js";
import type {
  CodexAppNotification,
  CodexAppServerBridge,
  CodexAppTurnStreamEvent,
  ListAppsParams,
  StartThreadParams,
  StartTurnParams,
} from "@src/codex-app-server/types.js";
import { ConfigSchema } from "@src/config-schema.js";
import { resetConfigForTesting, setConfigForTesting } from "@src/config.js";

class SessionBridge implements CodexAppServerBridge {
  readonly startedTurns: StartTurnParams[] = [];
  readonly listedApps: ListAppsParams[] = [];
  readonly archivedThreads: string[] = [];
  readonly interruptedTurns: Array<{ threadId: string; turnId: string }> = [];

  async listApps(params: ListAppsParams = {}): Promise<unknown> {
    this.listedApps.push(params);
    return { data: [], nextCursor: null };
  }

  async startThread(params: StartThreadParams): Promise<unknown> {
    return { thread: { id: params.model === "gpt-5.4" ? "thr_54" : "thr_default" } };
  }

  async startTurn(params: StartTurnParams): Promise<unknown> {
    this.startedTurns.push(params);
    return { turn: { id: "turn_1", status: "inProgress" } };
  }

  notificationsUntilTurnCompleted(_threadId: string): AsyncIterable<CodexAppNotification> {
    return (async function* () {
      yield { method: "item/agentMessage/delta", params: { delta: "ok" } };
      yield { method: "turn/completed", params: { turn: { id: "turn_1", status: "completed" } } };
    })();
  }

  async *runTurn(params: StartTurnParams): AsyncIterable<CodexAppTurnStreamEvent> {
    yield { type: "result", result: await this.startTurn(params) };
    for await (const notification of this.notificationsUntilTurnCompleted(params.threadId)) {
      yield { type: "notification", notification };
    }
  }

  async archiveThread(threadId: string): Promise<unknown> {
    this.archivedThreads.push(threadId);
    return {};
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    this.interruptedTurns.push({ threadId, turnId });
    return {};
  }

  async close(): Promise<void> {}
}

class BlockingSessionBridge extends SessionBridge {
  readonly started: Promise<void>;
  private readonly markStarted: () => void;
  private readonly released: Promise<void>;
  private readonly markReleased: () => void;

  constructor() {
    super();
    let start = () => undefined;
    let release = () => undefined;
    this.started = new Promise<void>((resolve) => { start = resolve; });
    this.released = new Promise<void>((resolve) => { release = resolve; });
    this.markStarted = start;
    this.markReleased = release;
  }

  release(): void {
    this.markReleased();
  }

  async *runTurn(params: StartTurnParams): AsyncIterable<CodexAppTurnStreamEvent> {
    yield { type: "result", result: await this.startTurn(params) };
    this.markStarted();
    await this.released;
  }
}

const AUTH_HEADERS = { Authorization: "Bearer agent-key" };

function enableOfficialAgent(options: Record<string, unknown> = {}): void {
  setConfigForTesting(ConfigSchema.parse({
    api: {}, client: {}, model: {}, auth: {}, session: {},
    server: { proxy_api_key: "proxy-key" },
    official_agent: { enabled: true, api_key: "agent-key", ...options },
  }));
}

function makeApp(bridge: CodexAppServerBridge): Hono {
  const app = new Hono();
  app.route("/", createOfficialAgentRoutes(() => bridge));
  return app;
}

async function createSession(app: Hono, body: unknown = {}): Promise<Record<string, unknown>> {
  const response = await app.request("/official-agent/sessions", {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<Record<string, unknown>>;
}

describe("official agent managed session API", () => {
  beforeEach(() => {
    resetOfficialAgentStateForTesting();
    resetConfigForTesting();
    process.env.PROXY_API_KEY = "agent-key";
    enableOfficialAgent();
  });

  afterEach(() => {
    resetOfficialAgentStateForTesting();
  });

  it("creates, retrieves, and lists a stable session over an app-server thread", async () => {
    const app = makeApp(new SessionBridge());
    const session = await createSession(app, { model: "gpt-5.4", cwd: "/workspace" });
    expect(session).toMatchObject({
      threadId: "thr_54",
      status: "idle",
      model: "gpt-5.4",
      cwd: "/workspace",
      currentTurnId: null,
      lastError: null,
    });
    expect(typeof session.sessionId).toBe("string");

    const fetched = await app.request(`/official-agent/sessions/${session.sessionId}`, { headers: AUTH_HEADERS });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ sessionId: session.sessionId, threadId: "thr_54" });

    const listed = await app.request("/official-agent/sessions", { headers: AUTH_HEADERS });
    expect(await listed.json()).toEqual({ data: [session] });
  });

  it("enforces the configured session limit with retry guidance", async () => {
    enableOfficialAgent({ max_sessions: 1 });
    const app = makeApp(new SessionBridge());
    await createSession(app);

    const limited = await app.request("/official-agent/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toEqual({
      error: { code: "session_limit_reached", message: "Maximum number of sessions reached" },
    });
  });

  it("rejects a session when App Server omits its thread id", async () => {
    const bridge = new SessionBridge();
    bridge.startThread = async () => ({ thread: {} });
    const response = await makeApp(bridge).request("/official-agent/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4" }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "invalid_app_server_response", message: "App Server did not return a thread id" },
    });
  });

  it("streams a turn with app mention, approval policy, and lifecycle events", async () => {
    const bridge = new SessionBridge();
    const app = makeApp(bridge);
    const session = await createSession(app, { model: "gpt-5.4" });

    const response = await app.request(`/official-agent/sessions/${session.sessionId}/turns`, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Inspect the dashboard",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        app: { id: "chrome", name: "Chrome" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(bridge.startedTurns).toEqual([{
      threadId: "thr_54",
      text: "Inspect the dashboard",
      cwd: "/workspace",
      approvalPolicy: "on-request",
      app: { id: "chrome", name: "Chrome" },
    }]);
    const body = await response.text();
    expect(body).toContain("event: official_agent.turn_started");
    expect(body).toContain("event: official_agent.result");
    expect(body).toContain("event: item/agentMessage/delta");
    expect(body).toContain("event: turn/completed");

    const fetched = await app.request(`/official-agent/sessions/${session.sessionId}`, { headers: AUTH_HEADERS });
    expect(await fetched.json()).toMatchObject({ status: "idle", currentTurnId: null, upstreamTurnId: null });
  });

  it("rejects malformed and incomplete turns before calling App Server", async () => {
    const bridge = new SessionBridge();
    const app = makeApp(bridge);
    const session = await createSession(app);
    const path = `/official-agent/sessions/${session.sessionId}/turns`;

    const malformed = await app.request(path, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: { code: "invalid_json", message: "Malformed JSON request body" } });

    const incomplete = await app.request(path, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json()).toEqual({ error: { code: "invalid_request", message: "text is required" } });
    expect(bridge.startedTurns).toEqual([]);
  });

  it("prevents concurrent turns and forwards cancellation to App Server", async () => {
    const bridge = new BlockingSessionBridge();
    const app = makeApp(bridge);
    const session = await createSession(app);
    const path = `/official-agent/sessions/${session.sessionId}/turns`;
    const firstTurn = app.request(path, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "long-running task" }),
    });
    await bridge.started;

    const busy = await app.request(path, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "second task" }),
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: { code: "session_busy", message: "This session already has a running turn" } });

    const current = await app.request(`/official-agent/sessions/${session.sessionId}`, { headers: AUTH_HEADERS });
    const state = await current.json() as { currentTurnId: string; upstreamTurnId: string };
    expect(state.upstreamTurnId).toBe("turn_1");
    const cancelled = await app.request(
      `/official-agent/sessions/${session.sessionId}/turns/${state.currentTurnId}/cancel`,
      { method: "POST", headers: AUTH_HEADERS },
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ cancelled: true, pending: false });
    expect(bridge.interruptedTurns).toEqual([{ threadId: "thr_default", turnId: "turn_1" }]);

    bridge.release();
    await (await firstTurn).text();
  });

  it("archives the App Server thread when deleting a managed session", async () => {
    const bridge = new SessionBridge();
    const app = makeApp(bridge);
    const session = await createSession(app, { model: "gpt-5.4" });

    const deleted = await app.request(`/official-agent/sessions/${session.sessionId}`, {
      method: "DELETE",
      headers: AUTH_HEADERS,
    });
    expect(await deleted.json()).toMatchObject({
      deleted: true,
      threadId: "thr_54",
      interrupted: false,
      archived: true,
    });
    expect(bridge.archivedThreads).toEqual(["thr_54"]);
    expect((await app.request(`/official-agent/sessions/${session.sessionId}`, { headers: AUTH_HEADERS })).status).toBe(404);
  });

  it("forwards app pagination and returns 404 for unknown resources", async () => {
    const bridge = new SessionBridge();
    const app = makeApp(bridge);
    const apps = await app.request("/official-agent/apps?cursor=next&limit=25", { headers: AUTH_HEADERS });
    expect(apps.status).toBe(200);
    expect(bridge.listedApps).toEqual([{ cursor: "next", limit: 25 }]);

    const missing = await app.request("/official-agent/sessions/missing", { headers: AUTH_HEADERS });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "session_not_found", message: "Session not found" } });
  });
});
