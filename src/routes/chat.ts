import { Hono } from "hono";
import type { Context } from "hono";
import { ChatCompletionRequestSchema } from "../types/openai.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import { translateToCodexRequest } from "../translation/openai-to-codex.js";
import { isRecord } from "../translation/shared-utils.js";
import {
  streamCodexToOpenAI,
  collectCodexResponse,
} from "../translation/codex-to-openai.js";
import { getConfig } from "../config.js";
import {
  parseModelName,
  buildDisplayModelName,
  isRecognizedModelName,
} from "../models/model-store.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import {
  handleProxyRequest,
} from "./shared/proxy-handler.js";
import type { FormatAdapter, ProxyRequest } from "./shared/proxy-handler-types.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { resolveDefaultTools, mergeDefaultTools } from "./shared/default-tools.js";
import { isUpstreamResponsesWebSocketEnabled } from "../proxy/upstream-transport-policy.js";

function makeOpenAIFormat(
  wantReasoning: boolean,
  customToolCallsAsFunctions = false,
): FormatAdapter {
  return {
    tag: "Chat",
    noAccountStatus: 503,
    formatNoAccount: () => ({
      error: {
        message:
          "The Codex CLI account is unavailable, expired, or rate-limited.",
        type: "server_error",
        param: null,
        code: "no_available_accounts",
      },
    }),
    format429: (msg) => ({
      error: {
        message: msg,
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_exceeded",
      },
    }),
    formatQuotaExhausted: (msg) => ({
      error: {
        message: msg,
        type: "rate_limit_error",
        param: null,
        code: "quota_exhausted",
      },
    }),
    formatError: (_status, msg) => ({
      error: {
        message: msg,
        type: "server_error",
        param: null,
        code: "codex_api_error",
      },
    }),
    streamTranslator: ({ api, response, model, onUsage, onResponseId, onResponseCompleted, tupleSchema }) =>
      streamCodexToOpenAI(
        api,
        response,
        model,
        onUsage,
        onResponseId,
        wantReasoning,
        tupleSchema,
        onResponseCompleted,
        customToolCallsAsFunctions,
      ),
    collectTranslator: ({ api, response, model, tupleSchema }) =>
      collectCodexResponse(api, response, model, wantReasoning, tupleSchema, customToolCallsAsFunctions),
  };
}

function isCursorClient(c: Context): boolean {
  return /^cursor\//i.test(c.req.header("user-agent") ?? "");
}

function formatModelNotFound(model: string) {
  return {
    error: {
      message: `Model '${model}' not found`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  };
}

export function createChatRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", apiKeyAuth(accountPool), async (c) => {
    // Parse request
    const body = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({
        error: {
          message: `Invalid request: ${parsed.error.message}`,
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      });
    }
    const req = parsed.data;

    if (!isRecognizedModelName(req.model)) {
      c.status(404);
      return c.json(formatModelNotFound(req.model));
    }

    const defaultTools = resolveDefaultTools(c, { allowUnauthenticated: false });

    const { codexRequest, tupleSchema } = translateToCodexRequest(req);
    // Chat Completions is translated to the Codex Responses protocol. Keep
    // the transport explicit so the first turn establishes a pooled WSS
    // owner; without this, only HTTP SSE would run and later turns could not
    // safely use previous_response_id continuity.
    codexRequest.useWebSocket = isUpstreamResponsesWebSocketEnabled();
    if (defaultTools.length > 0) {
      codexRequest.tools = mergeDefaultTools(codexRequest.tools, defaultTools);
    }
    const expectsImageGen = Array.isArray(codexRequest.tools)
      && codexRequest.tools.some((t): t is Record<string, unknown> => isRecord(t) && t.type === "image_generation");
    // Check after translation so suffix-parsed and config-default effort are included.
    const wantReasoning = !!codexRequest.reasoning?.effort;
    const fmt = makeOpenAIFormat(wantReasoning, isCursorClient(c));
    const displayModel = buildDisplayModelName(parseModelName(req.model));
    const proxyReq: ProxyRequest = {
      codexRequest,
      model: displayModel,
      isStreaming: req.stream ?? false,
      clientConversationId: req.user,
      tupleSchema,
      expectsImageGen,
    };

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: req.model,
      stream: !!req.stream,
      request: summarizeRequestForLog("chat", req, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json({
        error: {
          message: "Not authenticated. Please login first at /",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt });
  });

  return app;
}
