/**
 * Model routes — pure route handlers reading from model-store singleton.
 */

import { Hono } from "hono";
import type { OpenAIModel, OpenAIModelList } from "../types/openai.js";
import {
  getModelCatalog,
  getModelInfo,
  getModelStoreDebug,
  resolveModelId,
  type CodexModelInfo,
} from "../models/model-store.js";
import { triggerImmediateRefresh } from "../models/model-fetcher.js";
import { getConfig } from "../config.js";
import type { AccountPool } from "../auth/account-pool.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";

// --- Routes ---

/** Stable timestamp used for all model `created` fields (2023-11-14T22:13:20Z). */
const MODEL_CREATED_TIMESTAMP = 1700000000;
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
const AUTO_COMPACT_CONTEXT_WINDOW_PERCENT = 80;
const AUTO_COMPACT_TOKEN_LIMIT_OVERRIDES: Record<string, number> = {
  "gpt-5.5": 50_000,
};

function resolvedContextWindow(info: CodexModelInfo): number | undefined {
  return info.contextWindow ?? info.maxContextWindow;
}

function autoCompactTokenLimit(info: CodexModelInfo): number | undefined {
  const override = AUTO_COMPACT_TOKEN_LIMIT_OVERRIDES[info.id];
  if (override !== undefined) return override;
  if (info.autoCompactTokenLimit !== undefined) return info.autoCompactTokenLimit;
  const contextWindow = resolvedContextWindow(info);
  if (contextWindow === undefined) return undefined;
  return Math.floor((contextWindow * AUTO_COMPACT_CONTEXT_WINDOW_PERCENT) / 100);
}

function toOpenAIModel(info: CodexModelInfo): OpenAIModel {
  const model: OpenAIModel = {
    id: info.id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };

  if (info.contextWindow !== undefined) model.context_window = info.contextWindow;
  if (info.maxContextWindow !== undefined) model.max_context_window = info.maxContextWindow;
  if (info.maxOutputTokens !== undefined) model.max_output_tokens = info.maxOutputTokens;
  if (info.truncationPolicyLimit !== undefined) {
    model.truncation_policy = { mode: "tokens", limit: info.truncationPolicyLimit };
  }

  const compactLimit = autoCompactTokenLimit(info);
  if (compactLimit !== undefined) {
    model.auto_compact_token_limit = compactLimit;
    model.effective_context_window_percent = DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT;
  }

  return model;
}

export function createModelRoutes(
  accountPool?: AccountPool,
): Hono {
  const app = new Hono();

  if (accountPool) {
    app.use("/v1/models", apiKeyAuth(accountPool));
    app.use("/v1/models/*", apiKeyAuth(accountPool));
  }

  app.get("/v1/models", (c) => {
    const catalog = getModelCatalog();
    const modelsById = new Map<string, OpenAIModel>();

    for (const model of catalog) {
      modelsById.set(model.id, toOpenAIModel(model));
    }
    const data = [...modelsById.values()];

    const response: OpenAIModelList = { object: "list", data };
    return c.json(response);
  });

  // Full catalog with reasoning efforts (for dashboard UI)
  // Must be before :modelId to avoid being matched as a model ID
  app.get("/v1/models/catalog", (c) => {
    const catalog = getModelCatalog();
    const config = getConfig();
    const rawDefault = config.model?.default?.trim();
    const configDefault = rawDefault ? resolveModelId(rawDefault) : undefined;

    // Default outputModalities to ["text"] for chat-family entries that don't
    // set it explicitly, matching the interface's documented default.
    return c.json(
      catalog.map((m) => ({
        ...m,
        isDefault: configDefault ? m.id === configDefault : m.isDefault,
        outputModalities: m.outputModalities ?? ["text"],
      })),
    );
  });

  app.get("/v1/models/:modelId", (c) => {
    const modelId = c.req.param("modelId");
    const catalog = getModelCatalog();

    const info = catalog.find((m) => m.id === modelId);
    if (info) return c.json(toOpenAIModel(info));

    c.status(404);
    return c.json({
      error: {
        message: `Model '${modelId}' not found`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
  });

  // Extended endpoint: model details with reasoning efforts
  app.get("/v1/models/:modelId/info", (c) => {
    const modelId = c.req.param("modelId");
    const info = getModelInfo(modelId);
    if (!info) {
      c.status(404);
      return c.json({ error: `Model '${modelId}' not found` });
    }
    return c.json(info);
  });

  // Debug endpoint: model store internals
  app.get("/debug/models", (c) => {
    return c.json(getModelStoreDebug());
  });

  // Admin endpoint: trigger immediate model refresh
  app.post("/admin/refresh-models", (c) => {
    const configKey = process.env.PROXY_API_KEY?.trim();
    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!configKey || token !== configKey) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }
    triggerImmediateRefresh();
    return c.json({ ok: true, message: "Model refresh triggered" });
  });

  return app;
}
