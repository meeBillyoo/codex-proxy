/**
 * Google Gemini API route handler.
 * POST /v1beta/models/{model}:generateContent — non-streaming
 * POST /v1beta/models/{model}:streamGenerateContent — streaming
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { GeminiErrorResponse } from "../types/gemini.js";
import { GEMINI_STATUS_MAP } from "../types/gemini.js";
import { GeminiGenerateContentRequestSchema } from "../types/gemini.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import {
  translateGeminiToCodexRequest,
} from "../translation/gemini-to-codex.js";
import {
  streamCodexToGemini,
  collectCodexToGeminiResponse,
} from "../translation/codex-to-gemini.js";
import { getConfig } from "../config.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { getModelCatalog } from "../models/model-store.js";
import {
  handleProxyRequest,
} from "./shared/proxy-handler.js";
import type { FormatAdapter, ProxyRequest } from "./shared/proxy-handler-types.js";
import { extractProxyApiKey } from "../utils/extract-api-key.js";
import { resolveDefaultTools, mergeDefaultTools } from "./shared/default-tools.js";
import { isRecord } from "../translation/shared-utils.js";

function makeError(
  code: number,
  message: string,
  status?: string,
): GeminiErrorResponse {
  return {
    error: {
      code,
      message,
      status: status ?? GEMINI_STATUS_MAP[code] ?? "INTERNAL",
    },
  };
}

/**
 * Parse model name and action from the URL param.
 * e.g. "gemini-2.5-pro:generateContent" → { model: "gemini-2.5-pro", action: "generateContent" }
 */
function parseModelAction(param: string): {
  model: string;
  action: string;
} | null {
  const lastColon = param.lastIndexOf(":");
  if (lastColon <= 0) return null;
  return {
    model: param.slice(0, lastColon),
    action: param.slice(lastColon + 1),
  };
}

const GEMINI_FORMAT: FormatAdapter = {
  tag: "Gemini",
  noAccountStatus: 503,
  formatNoAccount: (message = "The Codex CLI account is unavailable, expired, or rate-limited.") =>
    makeError(
      503,
      message,
      "UNAVAILABLE",
    ),
  format429: (msg) => makeError(429, msg, "RESOURCE_EXHAUSTED"),
  formatQuotaExhausted: (msg) => makeError(429, msg, "RESOURCE_EXHAUSTED"),
  formatError: (status, msg) => makeError(status, msg),
  streamTranslator: ({ api, response, model, onUsage, onResponseId, onResponseCompleted, tupleSchema }) =>
    streamCodexToGemini(api, response, model, onUsage, onResponseId, tupleSchema, onResponseCompleted),
  collectTranslator: ({ api, response, model, tupleSchema }) =>
    collectCodexToGeminiResponse(api, response, model, tupleSchema),
};

export function createGeminiRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  // Handle both generateContent and streamGenerateContent
  app.post("/v1beta/models/:modelAction", apiKeyAuth(accountPool), async (c) => {
    const modelActionParam = c.req.param("modelAction");
    const parsedAction = parseModelAction(modelActionParam);

    if (
      !parsedAction ||
      (parsedAction.action !== "generateContent" &&
        parsedAction.action !== "streamGenerateContent")
    ) {
      c.status(400);
      return c.json(
        makeError(
          400,
          `Invalid action. Expected :generateContent or :streamGenerateContent, got: ${modelActionParam}`,
        ),
      );
    }

    const { model: geminiModel, action } = parsedAction;

    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError(
          401,
          "Not authenticated. Please login first at /",
          "UNAUTHENTICATED",
        ),
      );
    }

    // Parse body
    const rawBody = await c.req.json();
    const parsed = GeminiGenerateContentRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError(
          400,
          `Invalid request: ${parsed.error.message}`,
          "INVALID_ARGUMENT",
        ),
      );
    }

    const defaultTools = resolveDefaultTools(c, { allowUnauthenticated: false });
    const { codexRequest, tupleSchema } = translateGeminiToCodexRequest(
      parsed.data,
      geminiModel,
    );
    if (defaultTools.length > 0) {
      codexRequest.tools = mergeDefaultTools(codexRequest.tools, defaultTools);
    }

    console.log(
      `[Gemini] Model: ${geminiModel} → ${codexRequest.model}`,
    );

    const isStreaming =
      action === "streamGenerateContent" ||
      c.req.query("alt") === "sse";

    const proxyReq: ProxyRequest = {
      codexRequest,
      model: geminiModel,
      isStreaming,
      clientConversationId: c.req.header("x-conversation-id") || c.req.header("x-session-id"),
      tupleSchema,
      expectsImageGen: Array.isArray(codexRequest.tools)
        && codexRequest.tools.some((tool) => isRecord(tool) && tool.type === "image_generation"),
    };

    return handleProxyRequest({ c, accountPool, cookieJar, req: proxyReq, fmt: GEMINI_FORMAT });
  });

  // List available models (Gemini format)
  app.get("/v1beta/models", apiKeyAuth(accountPool), (c) => {
    const catalog = getModelCatalog();

    const models = catalog.map((m) => ({
      name: `models/${m.id}`,
      displayName: m.displayName,
      description: m.description,
      supportedGenerationMethods: [
        "generateContent",
        "streamGenerateContent",
      ],
    }));

    return c.json({ models });
  });

  return app;
}
