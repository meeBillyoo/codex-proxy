import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { FormatAdapter, ProxyRequest } from "./proxy-handler-types.js";
import { canReturnStreamError, streamErrorResponse } from "./stream-error-response.js";

export interface RespondWithNoAccountOptions {
  c: Context;
  req: ProxyRequest;
  fmt: FormatAdapter;
}

export interface RespondWithProxyErrorOptions {
  c: Context;
  req: ProxyRequest;
  fmt: FormatAdapter;
  status: number;
  message: string;
  useFormat429?: boolean;
}

export function respondWithNoAccount(options: RespondWithNoAccountOptions): Response {
  const { c, req, fmt } = options;
  if (canReturnStreamError(req, fmt)) {
    return streamErrorResponse(
      c,
      fmt,
      fmt.noAccountStatus,
      "The Codex CLI account is unavailable, expired, or rate-limited.",
    );
  }
  c.status(fmt.noAccountStatus);
  return c.json(fmt.formatNoAccount());
}

export function respondWithQuotaExhausted(options: RespondWithNoAccountOptions): Response {
  const { c, req, fmt } = options;
  const message = "The Codex CLI account quota is exhausted.";
  if (canReturnStreamError(req, fmt)) {
    return streamErrorResponse(c, fmt, 429, message);
  }
  c.status(429);
  return c.json(fmt.formatQuotaExhausted(message));
}

export function respondWithProxyError(options: RespondWithProxyErrorOptions): Response {
  const { c, req, fmt, status, message, useFormat429 = false } = options;
  if (canReturnStreamError(req, fmt)) {
    return streamErrorResponse(c, fmt, status, message);
  }
  c.status(status as StatusCode);
  return c.json(useFormat429 ? fmt.format429(message) : fmt.formatError(status, message));
}
