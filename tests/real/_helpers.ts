/**
 * Shared helpers for real upstream integration tests.
 *
 * All tests require a running proxy at PROXY_URL (default: http://localhost:8080)
 * with the current OS user's Codex CLI account logged in.
 */

export const PROXY_URL = process.env.PROXY_URL ?? "http://localhost:8080";
export const API_KEY = process.env.PROXY_API_KEY ?? "pwd";
export const TIMEOUT = 30_000;

let _proxyReachable: boolean | null = null;

/** Check proxy reachability (cached after first call). */
export async function checkProxy(): Promise<boolean> {
  if (_proxyReachable !== null) return _proxyReachable;
  try {
    const res = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(5000) });
    _proxyReachable = res.ok;
    if (!_proxyReachable) {
      console.warn(`[real] Proxy at ${PROXY_URL} returned ${res.status}, skipping`);
    }
  } catch {
    _proxyReachable = false;
    console.warn(`[real] Proxy at ${PROXY_URL} not reachable, skipping`);
  }
  return _proxyReachable;
}

/** Returns true when tests should be skipped (proxy not reachable). */
export function skip(): boolean {
  return !_proxyReachable;
}

/** Standard auth headers for proxy requests. */
export function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
  };
}

/** Collect SSE `data:` lines from a response. */
export async function collectSSE(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
}

/** Collect SSE `event:` type lines from a response. */
export async function collectSSEEvents(res: Response): Promise<{ events: string[]; text: string }> {
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("event: "))
    .map((l) => l.slice(7));
  return { events, text };
}

/** Extract JSON data lines from SSE text (already collected). */
export function parseDataLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
}

/** Send a lightweight non-streaming chat completion request. */
export async function sendQuickRequest(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "codex",
      messages: [{ role: "user", content: "Reply with just the word 'ok'." }],
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

/** Parse SSE text into event types and data lines. */
export function parseSSE(text: string): { events: string[]; dataLines: string[] } {
  const lines = text.split("\n");
  const events = lines.filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
  const dataLines = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  return { events, dataLines };
}

/** Anthropic-style auth headers (x-api-key, no redundant Authorization). */
export function anthropicHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
  };
}
