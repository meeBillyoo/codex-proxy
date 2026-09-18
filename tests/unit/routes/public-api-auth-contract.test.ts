import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AccountPool } from "@src/auth/account-pool.js";
import { createBillingRoutes } from "@src/routes/billing.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createGeminiRoutes } from "@src/routes/gemini.js";
import { createImagesRoutes } from "@src/routes/images.js";
import { createMessagesRoutes } from "@src/routes/messages.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createResponsesRoutes } from "@src/routes/responses.js";

function createPool(): AccountPool {
  return {
    validateProxyApiKey: vi.fn((key: string) => key === "public-api-key"),
    getAccount: vi.fn(() => null),
  } as unknown as AccountPool;
}

function createPublicApiApp(pool: AccountPool): Hono {
  const app = new Hono();
  app.route("/", createChatRoutes(pool));
  app.route("/", createMessagesRoutes(pool));
  app.route("/", createGeminiRoutes(pool));
  app.route("/", createResponsesRoutes(pool));
  app.route("/", createImagesRoutes(pool));
  app.route("/", createModelRoutes(pool));
  app.route("/", createBillingRoutes(pool));
  return app;
}

const JSON_REQUEST = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
};

describe("public API authentication contracts", () => {
  it.each([
    ["OpenAI Chat Completions", "/v1/chat/completions", JSON_REQUEST],
    ["OpenAI Responses", "/v1/responses", JSON_REQUEST],
    ["OpenAI Responses alias", "/responses", JSON_REQUEST],
    ["OpenAI Responses review", "/v1/responses/review", JSON_REQUEST],
    ["OpenAI Responses compact", "/v1/responses/compact", JSON_REQUEST],
    ["OpenAI Images", "/v1/images/generations", JSON_REQUEST],
    ["OpenAI Images alias", "/images/generations", JSON_REQUEST],
    ["Anthropic Messages", "/v1/messages", JSON_REQUEST],
    ["Anthropic token count", "/v1/messages/count_tokens", JSON_REQUEST],
    [
      "Gemini generateContent",
      "/v1beta/models/gemini-2.5-pro:generateContent",
      JSON_REQUEST,
    ],
    ["Gemini model list", "/v1beta/models", undefined],
    ["OpenAI model list", "/v1/models", undefined],
    ["OpenAI model catalog", "/v1/models/catalog", undefined],
    ["billing subscription", "/v1/dashboard/billing/subscription", undefined],
    ["billing usage", "/v1/dashboard/billing/usage", undefined],
  ])("rejects an unauthenticated %s request", async (_name, path, init) => {
    const response = await createPublicApiApp(createPool()).request(path, init);
    expect(response.status).toBe(401);
  });

  it("uses each provider's native authentication error envelope", async () => {
    const app = createPublicApiApp(createPool());

    const openAi = await app.request("/v1/chat/completions", JSON_REQUEST);
    expect(await openAi.json()).toEqual({
      error: {
        message: "Invalid proxy API key",
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    });

    const anthropic = await app.request("/v1/messages", JSON_REQUEST);
    expect(await anthropic.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Invalid proxy API key" },
    });

    const gemini = await app.request(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      JSON_REQUEST,
    );
    expect(await gemini.json()).toEqual({
      error: {
        code: 401,
        message: "Invalid proxy API key",
        status: "UNAUTHENTICATED",
      },
    });
  });

  it.each([
    ["Authorization", "Bearer public-api-key"],
    ["x-api-key", "public-api-key"],
    ["x-goog-api-key", "public-api-key"],
  ])("accepts the supported %s credential location", async (header, value) => {
    const response = await createPublicApiApp(createPool()).request(
      "/v1/models",
      {
        headers: { [header]: value },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: "list" });
  });

  it("exposes new-api-compatible billing responses after authentication", async () => {
    const app = createPublicApiApp(createPool());
    const headers = { Authorization: "Bearer public-api-key" };

    const subscription = await app.request(
      "/v1/dashboard/billing/subscription",
      { headers },
    );
    expect(subscription.status).toBe(200);
    expect(await subscription.json()).toMatchObject({
      object: "billing_subscription",
      has_payment_method: false,
      hard_limit_usd: 0,
    });

    const usage = await app.request("/v1/dashboard/billing/usage", { headers });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual({ object: "list", total_usage: 0 });
  });
});
