/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono, type Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { AnthropicCountTokensRequestSchema, AnthropicMessagesRequestSchema } from "../types/anthropic.js";
import type { AnthropicCountTokensRequest, AnthropicErrorBody, AnthropicErrorType, AnthropicMessagesRequest } from "../types/anthropic.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import { translateAnthropicToCodexRequest } from "../translation/anthropic-to-codex.js";
import {
  streamCodexToAnthropic,
  collectCodexToAnthropicResponse,
} from "../translation/codex-to-anthropic.js";
import { getConfig } from "../config.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { parseModelName, buildDisplayModelName } from "../models/model-store.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import {
  handleProxyRequest,
} from "./shared/proxy-handler.js";
import type { FormatAdapter } from "./shared/proxy-handler-types.js";
import { extractAnthropicClientConversationId } from "./shared/anthropic-session-id.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import { resolveDefaultTools, mergeDefaultTools } from "./shared/default-tools.js";
import { isRecord } from "../translation/shared-utils.js";
import { isUpstreamResponsesWebSocketEnabled } from "../proxy/upstream-transport-policy.js";

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}



function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const cjkMatches = trimmed.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkCount = Math.max(0, trimmed.length - cjkCount);

  return Math.ceil(nonCjkCount / 4) + cjkCount;
}

function estimateUnknownTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return estimateTextTokens(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return estimateTextTokens(String(value));
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateUnknownTokens(item), 0) + value.length;
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (sum, [key, item]) => sum + estimateTextTokens(key) + estimateUnknownTokens(item),
      2,
    );
  }
  return estimateTextTokens(String(value));
}

function estimateMessageContentTokens(content: AnthropicMessagesRequest["messages"][number]["content"]): number {
  if (typeof content === "string") return estimateTextTokens(content);
  return content.reduce((sum, block) => sum + estimateUnknownTokens(block), 0);
}

function estimateCountTokens(req: AnthropicCountTokensRequest): number {
  const modelTokens = estimateTextTokens(req.model);
  const systemTokens = req.system ? estimateUnknownTokens(req.system) + 4 : 0;
  const messageTokens = req.messages.reduce(
    (sum, message) =>
      sum +
      4 +
      estimateTextTokens(message.role) +
      estimateMessageContentTokens(message.content),
    0,
  );
  const toolTokens = (req.tools ?? []).reduce(
    (sum, tool) => sum + 16 + estimateUnknownTokens(tool),
    0,
  );
  const toolChoiceTokens = req.tool_choice ? estimateUnknownTokens(req.tool_choice) : 0;
  const thinkingTokens = req.thinking ? estimateUnknownTokens(req.thinking) : 0;

  return Math.max(1, modelTokens + systemTokens + messageTokens + toolTokens + toolChoiceTokens + thinkingTokens + 3);
}

function makeAnthropicFormat(wantThinking: boolean): FormatAdapter {
  return {
    tag: "Messages",
    noAccountStatus: 529 as StatusCode,
    formatNoAccount: (message = "The Codex CLI account is unavailable, expired, or rate-limited.") =>
      makeError(
        "overloaded_error",
        message,
      ),
    format429: (msg) => makeError("rate_limit_error", msg),
    formatQuotaExhausted: (msg) => makeError("rate_limit_error", msg),
    formatError: (_status, msg) => makeError("api_error", msg),
    streamTranslator: ({
      api,
      response,
      model,
      onUsage,
      onResponseId,
      onResponseCompleted,
      usageHint,
      onResponseMetadata,
    }) =>
      streamCodexToAnthropic(api, response, model, onUsage, onResponseId, wantThinking, usageHint, onResponseMetadata, onResponseCompleted),
    collectTranslator: ({
      api,
      response,
      model,
      usageHint,
      onResponseMetadata,
    }) =>
      collectCodexToAnthropicResponse(api, response, model, wantThinking, usageHint, onResponseMetadata),
  };
}

export function createMessagesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  app.post("/v1/messages/count_tokens", apiKeyAuth(accountPool), async (c) => {
    const body = await c.req.json();

    const parsed = AnthropicCountTokensRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }

    return c.json({ input_tokens: estimateCountTokens(parsed.data) });
  });

  app.post("/v1/messages", apiKeyAuth(accountPool), async (c) => {
    // Parse request
    const body = await c.req.json();
    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;

    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    const clientConversationId = extractAnthropicClientConversationId(
      req,
      c.req.header("x-claude-code-session-id"),
    );

    const defaultTools = resolveDefaultTools(c, {
      allowUnauthenticated: false,
      fallbackDefaultTools: ["web_search"],
    });

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    const codexRequest = translateAnthropicToCodexRequest(req, undefined, {
      injectHostedWebSearch: false,
      mapClaudeCodeWebSearch: clientConversationId !== null,
      requestId,
    });
    codexRequest.useWebSocket = isUpstreamResponsesWebSocketEnabled();
    if (defaultTools.length > 0) {
      codexRequest.tools = mergeDefaultTools(codexRequest.tools, defaultTools);
    }
    // Check after translation so suffix-parsed and config-default effort are included.
    const wantThinking = !!codexRequest.reasoning?.effort;
    const proxyReq = {
      codexRequest,
      model: buildDisplayModelName(parseModelName(req.model)),
      isStreaming: req.stream,
      clientConversationId: clientConversationId ?? undefined,
      expectsImageGen: Array.isArray(codexRequest.tools)
        && codexRequest.tools.some((tool) => isRecord(tool) && tool.type === "image_generation"),
    };
    const fmt = makeAnthropicFormat(wantThinking);

    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: req.model,
      stream: !!req.stream,
      request: summarizeRequestForLog("messages", req, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt });
  });

  return app;
}
