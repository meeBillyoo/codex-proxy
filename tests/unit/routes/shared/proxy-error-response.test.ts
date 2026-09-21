import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  respondWithNoAccount,
  respondWithProxyError,
} from "@src/routes/shared/proxy-error-response.js";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";

function createRequest(isStreaming: boolean): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user", content: "hello" }],
      stream: isStreaming,
    },
    model: "codex",
    isStreaming,
  };
}

describe("proxy error response helpers", () => {
  it("formats non-streaming proxy errors with the route-specific 429 formatter", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(false);

    app.get("/error", (c) => respondWithProxyError({
      c,
      req,
      fmt,
      status: 429,
      message: "Current Codex CLI account is rate-limited",
      useFormat429: true,
    }));

    const res = await app.request("/error");

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "rate_limited",
      message: "Current Codex CLI account is rate-limited",
    });
    expect(fmt.format429).toHaveBeenCalledWith("Current Codex CLI account is rate-limited");
    expect(fmt.formatError).not.toHaveBeenCalled();
  });

  it("formats streaming proxy errors as SSE when the adapter supports stream errors", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(true);

    app.get("/stream-error", (c) => respondWithProxyError({
      c,
      req,
      fmt,
      status: 503,
      message: "No accounts",
    }));

    const res = await app.request("/stream-error");
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(text).toContain("event: response.failed");
    expect(text).toContain("No accounts");
    expect(fmt.formatStreamError).toHaveBeenCalledWith(503, "No accounts");
  });

  it("preserves route-specific no-account JSON responses for non-streaming requests", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(false);

    app.get("/no-account", (c) => respondWithNoAccount({ c, req, fmt }));

    const res = await app.request("/no-account");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_account" });
    expect(fmt.formatNoAccount).toHaveBeenCalledOnce();
  });

  it("surfaces the account availability reason for streaming requests", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    const req = createRequest(true);
    const accountPool = {
      getAvailability: () => ({
        available: false,
        reason: "busy" as const,
        maxConcurrent: 3,
        usedSlots: 3,
      }),
    } as never;

    app.get("/busy", (c) => respondWithNoAccount({ c, req, fmt, accountPool }));

    const res = await app.request("/busy");
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).toContain("busy (3/3 concurrency slots in use)");
    expect(text).not.toContain("expired, or rate-limited");
  });

  it("formats non-streaming 500 proxy errors with the route formatter", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    app.get("/server-error", (c) => respondWithProxyError({
      c,
      req: createRequest(false),
      fmt,
      status: 500,
      message: "internal error",
    }));

    const res = await app.request("/server-error");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "api_error",
      status: 500,
      message: "internal error",
    });
    expect(fmt.formatError).toHaveBeenCalledWith(500, "internal error");
  });

  it("formats streaming 500 proxy errors as SSE when the adapter supports stream errors", async () => {
    const app = new Hono();
    const fmt = createMockFormatAdapter();
    app.get("/stream-server-error", (c) => respondWithProxyError({
      c,
      req: createRequest(true),
      fmt,
      status: 500,
      message: "internal error",
    }));

    const res = await app.request("/stream-server-error");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: response.failed");
    expect(text).toContain("internal error");
    expect(fmt.formatStreamError).toHaveBeenCalledWith(500, "internal error");
  });
});
