import type { IncomingMessage } from "node:http";

/**
 * A WebSocket upgrade reached the upstream server, but the server rejected
 * the HTTP upgrade before a WebSocket connection was established.
 *
 * This is deliberately different from a Codex API error received after the
 * socket is open.  A rejected upgrade is a transport capability/auth
 * negotiation failure; for a request that does not depend on
 * `previous_response_id`, the caller can safely retry the same request over
 * HTTP SSE and let the normal HTTP response decide whether the credential is
 * actually invalid.
 */
export class WebSocketHandshakeError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly headers: Record<string, string | string[] | undefined> = {},
  ) {
    const detail = summarizeBody(body);
    super(
      `Upstream WebSocket handshake failed (${status})${detail ? `: ${detail}` : ""}`,
    );
    this.name = "WebSocketHandshakeError";
  }
}

const MAX_HANDSHAKE_ERROR_BODY_BYTES = 64 * 1024;

/** Read the non-101 upgrade response without allowing an unbounded body. */
export function readWebSocketHandshakeError(
  response: IncomingMessage,
): Promise<WebSocketHandshakeError> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(
        new WebSocketHandshakeError(
          response.statusCode ?? 0,
          Buffer.concat(chunks).toString("utf8"),
          response.headers,
        ),
      );
    };

    response.on("data", (chunk: Buffer | string) => {
      if (settled || total >= MAX_HANDSHAKE_ERROR_BODY_BYTES) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_HANDSHAKE_ERROR_BODY_BYTES - total;
      chunks.push(bytes.subarray(0, remaining));
      total += Math.min(bytes.length, remaining);
    });
    response.once("end", finish);
    response.once("error", finish);
    // A rejected upgrade response is not consumed by ws. Resume it so the
    // underlying socket can be released even when the server sends no body.
    response.resume();
  });
}

function summarizeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const nested = record.error;
      if (nested && typeof nested === "object") {
        const message = (nested as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message.trim();
      }
      const message = record.message ?? record.detail;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  } catch {
    // Keep a bounded plain-text response below.
  }

  return trimmed.slice(0, 240).replace(/\s+/g, " ");
}
