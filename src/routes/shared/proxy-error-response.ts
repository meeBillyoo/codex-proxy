import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { FormatAdapter, ProxyRequest } from "./proxy-handler-types.js";
import { canReturnStreamError, streamErrorResponse } from "./stream-error-response.js";
import type { AccountPool, AccountUnavailableReason } from "../../auth/account-pool.js";

const GENERIC_NO_ACCOUNT_MESSAGE = "The Codex CLI account is unavailable, expired, or rate-limited.";

function unavailableMessage(
  reason: AccountUnavailableReason | undefined,
  availability: { maxConcurrent?: number; usedSlots?: number } | undefined,
): string {
  switch (reason) {
    case "auth_file_unavailable":
      return "The Codex CLI account is not loaded. Run `codex login` as the service user, then reload the account.";
    case "expired":
      return "The Codex CLI account access token is expired. Run `codex login` again, then reload the account.";
    case "quota_exhausted":
      return "The Codex CLI account quota is exhausted. Wait for the quota window to reset or use another account.";
    case "refreshing":
      return "The Codex CLI account is refreshing. Retry after the account reload completes.";
    case "disabled":
      return "The Codex CLI account is disabled after repeated upstream blocks. Check the server logs and reload credentials.";
    case "banned":
      return "The Codex CLI account was rejected as banned or suspended by the upstream service. Refresh credentials or use another account.";
    case "busy": {
      const used = availability?.usedSlots;
      const max = availability?.maxConcurrent;
      const slots = used != null && max != null ? ` (${used}/${max} concurrency slots in use)` : "";
      return `The Codex CLI account is busy${slots}. Retry when an in-flight request completes.`;
    }
    default:
      return GENERIC_NO_ACCOUNT_MESSAGE;
  }
}

export interface RespondWithNoAccountOptions {
  c: Context;
  req: ProxyRequest;
  fmt: FormatAdapter;
  accountPool?: AccountPool;
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
  const { c, req, fmt, accountPool } = options;
  const availability = accountPool?.getAvailability?.(req.codexRequest.model);
  const message = unavailableMessage(availability?.reason, availability);
  if (canReturnStreamError(req, fmt)) {
    // A streaming response normally starts with HTTP 200, which causes some
    // clients to report any early SSE failure as a generic disconnect. Account
    // contention is a local, observable condition: expose it as a real 503
    // plus a stable header, while retaining the protocol-specific SSE body.
    if (availability?.reason === "busy") {
      c.status(503);
      c.header("X-Codex-Proxy-Error-Code", "account_busy");
    }
    return streamErrorResponse(
      c,
      fmt,
      fmt.noAccountStatus,
      message,
    );
  }
  c.status(fmt.noAccountStatus);
  return c.json(fmt.formatNoAccount(message));
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
