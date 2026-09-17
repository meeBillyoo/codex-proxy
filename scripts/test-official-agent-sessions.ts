/**
 * End-to-end smoke test for the Official Agent session API.
 *
 * Usage:
 *   OFFICIAL_AGENT_API_KEY=... npm run test:official-agent-sessions
 *
 * Optional:
 *   OFFICIAL_AGENT_BASE_URL=http://127.0.0.1:8221/v1
 */

export {};

interface Session {
  sessionId: string;
  threadId: string;
  status: "idle" | "running" | "closed";
  currentTurnId: string | null;
}

interface SseEvent {
  event: string;
  data: unknown;
}

interface TurnResult {
  output: string | null;
  terminalStatus: string | null;
  cancelStatus: number | null;
}

const configuredBaseUrl = process.env.OFFICIAL_AGENT_BASE_URL ?? "http://34.28.243.240:8221/v1";
const apiBaseUrl = configuredBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
const apiKey = process.env.OFFICIAL_AGENT_API_KEY ?? process.env.PROXY_API_KEY;

if (!apiKey) {
  throw new Error("Set OFFICIAL_AGENT_API_KEY (or PROXY_API_KEY) before running this script");
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as T : {} as T;
  if (!response.ok) {
    if (response.status === 503 && text.includes("official_agent_disabled")) {
      throw new Error("Official Agent is disabled on the server. Set official_agent.enabled: true, configure app_server_url, and restart codex-proxy.");
    }
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  }
  return { status: response.status, body };
}

async function createSession(label: string): Promise<Session> {
  const { status, body } = await requestJson<Session>("/official-agent/sessions", {
    method: "POST",
    body: JSON.stringify({}),
  });
  console.log(`[${label}] created (${status}): session=${body.sessionId}, thread=${body.threadId}`);
  return body;
}

async function readSse(response: Response, onEvent: (event: SseEvent) => Promise<void>): Promise<void> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += value ?? "";
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      const rawData = dataLines.join("\n");
      let data: unknown = rawData;
      try { data = JSON.parse(rawData); } catch { /* keep non-JSON data */ }
      await onEvent({ event, data });
    }
    if (done) return;
  }
}

async function runTurn(session: Session, label: string, cancelImmediately: boolean): Promise<TurnResult> {
  const response = await fetch(`${apiBaseUrl}/official-agent/sessions/${session.sessionId}/turns`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: `Reply with exactly ${label}_OK and nothing else.` }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Start turn for ${label} returned ${response.status}: ${await response.text()}`);

  let cancelRequested = false;
  let cancelStatus: number | null = null;
  let output: string | null = null;
  let terminalStatus: string | null = null;
  await readSse(response, async ({ event, data }) => {
    console.log(`[${label}] ${event}:`, JSON.stringify(data));
    if (event === "item/completed" && isRecord(data) && isRecord(data.params) && isRecord(data.params.item) && data.params.item.type === "agentMessage" && typeof data.params.item.text === "string") {
      output = data.params.item.text;
    }
    if (event === "turn/completed" && isRecord(data) && isRecord(data.params) && isRecord(data.params.turn) && typeof data.params.turn.status === "string") {
      terminalStatus = data.params.turn.status;
    }
    if (!cancelImmediately || cancelRequested || !["official_agent.turn_started", "official_agent.result"].includes(event)) return;
    const turnId = isRecord(data) && typeof data.turnId === "string"
      ? data.turnId
      : "";
    if (!turnId) throw new Error(`${label} did not receive a local turnId`);
    cancelRequested = true;
    const cancelled = await requestJson<{ cancelled: boolean; pending: boolean }>(
      `/official-agent/sessions/${session.sessionId}/turns/${turnId}/cancel`,
      { method: "POST", body: "{}" },
    );
    cancelStatus = cancelled.status;
    console.log(`[${label}] cancel (${cancelled.status}):`, cancelled.body);
    if (![200, 202].includes(cancelled.status)) throw new Error(`Unexpected cancel status ${cancelled.status}`);
  });
  return { output, terminalStatus, cancelStatus };
}

async function main(): Promise<void> {
  console.log(`Testing Official Agent API at ${apiBaseUrl}`);
  const createdSessions: Session[] = [];
  try {
    const before = await requestJson<{ data: Session[] }>("/official-agent/sessions");
    console.log(`Existing sessions: ${before.body.data.length}`);

    const [sessionA, sessionB] = await Promise.all([createSession("A"), createSession("B")]);
    createdSessions.push(sessionA, sessionB);

    const details = await requestJson<Session>(`/official-agent/sessions/${sessionA.sessionId}`);
    console.log(`[A] GET status=${details.body.status}`);

    console.log("Starting two sessions in parallel; B will be cancelled immediately...");
    const [resultA, resultB] = await Promise.all([
      runTurn(sessionA, "SESSION_A", false),
      runTurn(sessionB, "SESSION_B", true),
    ]);
    if (resultA.terminalStatus !== "completed" || resultA.output !== "SESSION_A_OK") {
      throw new Error(`Session A failed: ${JSON.stringify(resultA)}`);
    }
    if (!resultB.cancelStatus || !["interrupted", "cancelled"].includes(resultB.terminalStatus ?? "")) {
      throw new Error(`Session B cancellation failed: ${JSON.stringify(resultB)}`);
    }
    console.log("Turn result and cancellation assertions passed");

    const after = await requestJson<{ data: Session[] }>("/official-agent/sessions");
    const ids = new Set(after.body.data.map((session) => session.sessionId));
    if (!createdSessions.every((session) => ids.has(session.sessionId))) {
      throw new Error("Created sessions were not returned by GET /official-agent/sessions");
    }
    console.log("Session list verification passed");
  } finally {
    for (const session of createdSessions) {
      try {
        const deleted = await requestJson<{ deleted: boolean; archived: boolean }>(
          `/official-agent/sessions/${session.sessionId}`,
          { method: "DELETE" },
        );
        if (!deleted.body.deleted) throw new Error("Delete response did not confirm deletion");
        console.log(`Deleted ${session.sessionId}:`, deleted.body);
      } catch (error) {
        console.error(`Failed to clean up ${session.sessionId}:`, error);
      }
    }
  }
}

await main();
