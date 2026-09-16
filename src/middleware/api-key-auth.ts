import type { Context, Next, MiddlewareHandler } from "hono";
import { extractProxyApiKey } from "../utils/extract-api-key.js";
import type { AccountPool } from "../auth/account-pool.js";
import { validateSession } from "../auth/dashboard-session.js";
import { parseSessionCookie } from "../utils/parse-cookie.js";

function makeOpenAIError(message: string, code = "invalid_api_key", type = "invalid_request_error") {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

function makeAnthropicError(message: string, type = "authentication_error") {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}

function makeGeminiError(code: number, message: string, status = "UNAUTHENTICATED") {
  return {
    error: {
      code,
      message,
      status,
    },
  };
}

function formatAuthError(path: string, message: string, code = "invalid_api_key", statusCode = 401) {
  if (path.startsWith("/admin/")) {
    return { error: message };
  }
  if (path.startsWith("/v1/messages")) {
    const anthropicType =
      statusCode === 429
        ? "rate_limit_error"
        : statusCode === 403
          ? "permission_error"
          : "authentication_error";
    return makeAnthropicError(message, anthropicType);
  }
  if (path.startsWith("/v1beta/")) {
    const geminiStatus =
      statusCode === 429
        ? "RESOURCE_EXHAUSTED"
        : statusCode === 403
          ? "PERMISSION_DENIED"
          : "UNAUTHENTICATED";
    return makeGeminiError(statusCode, message, geminiStatus);
  }
  return makeOpenAIError(message, code);
}

export function apiKeyAuth(accountPool: AccountPool): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (c.get("authRole") === "master") return next();
    const providedKey = extractProxyApiKey(c);
    const path = c.req.path;

    if (providedKey && accountPool.validateProxyApiKey(providedKey)) {
      c.set("authRole", "master");
      return next();
    }
    const sessionId = parseSessionCookie(c.req.header("cookie"));
    if (sessionId && validateSession(sessionId)) {
      c.set("authRole", "master");
      return next();
    }
    c.status(401);
    return c.json(formatAuthError(path, "Invalid proxy API key", "invalid_api_key", 401));
  };
}
