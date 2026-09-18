import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  readWebSocketHandshakeError,
  WebSocketHandshakeError,
} from "@src/proxy/ws-handshake-error.js";

function handshakeResponse(options: {
  status: number;
  headers?: Record<string, string>;
  chunks?: Array<string | Buffer>;
}): IncomingMessage {
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    resume(): void;
  };
  response.statusCode = options.status;
  response.headers = options.headers ?? {};
  response.resume = () =>
    queueMicrotask(() => {
      for (const chunk of options.chunks ?? []) response.emit("data", chunk);
      response.emit("end");
    });
  return response as unknown as IncomingMessage;
}

describe("WebSocket handshake rejection", () => {
  it.each([
    [
      401,
      { error: { message: "missing bearer token" } },
      "missing bearer token",
    ],
    [403, { message: "account is not permitted" }, "account is not permitted"],
    [429, { detail: "upgrade rate limited" }, "upgrade rate limited"],
  ])(
    "preserves HTTP %i and summarizes its JSON body",
    async (status, body, detail) => {
      const error = await readWebSocketHandshakeError(
        handshakeResponse({
          status,
          headers: { "content-type": "application/json", "retry-after": "30" },
          chunks: [JSON.stringify(body)],
        }),
      );

      expect(error).toBeInstanceOf(WebSocketHandshakeError);
      expect(error.status).toBe(status);
      expect(error.body).toBe(JSON.stringify(body));
      expect(error.headers["retry-after"]).toBe("30");
      expect(error.message).toContain(detail);
    },
  );

  it("normalizes whitespace in a plain-text proxy rejection", async () => {
    const error = await readWebSocketHandshakeError(
      handshakeResponse({
        status: 502,
        chunks: ["  gateway\n\tupgrade   failed  "],
      }),
    );

    expect(error.message).toBe(
      "Upstream WebSocket handshake failed (502): gateway upgrade failed",
    );
  });

  it("bounds an untrusted rejection body at 64 KiB", async () => {
    const error = await readWebSocketHandshakeError(
      handshakeResponse({
        status: 500,
        chunks: [Buffer.alloc(80 * 1024, "x")],
      }),
    );

    expect(Buffer.byteLength(error.body)).toBe(64 * 1024);
    expect(error.message.length).toBeLessThan(400);
  });

  it("still resolves when reading the rejection body emits an error", async () => {
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
      resume(): void;
    };
    response.statusCode = 503;
    response.headers = {};
    response.resume = () =>
      queueMicrotask(() => response.emit("error", new Error("socket reset")));

    await expect(
      readWebSocketHandshakeError(response as unknown as IncomingMessage),
    ).resolves.toMatchObject({ status: 503, body: "" });
  });
});
