import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountPool } from "@src/auth/account-pool.js";
import { resetConfigForTesting, setConfigForTesting } from "@src/config.js";
import { createBillingRoutes } from "@src/routes/billing.js";
import type { CodexQuota } from "@src/auth/types.js";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createMockConfig } from "@helpers/config.js";
import { createValidJwt } from "@helpers/jwt.js";

function quota(planType: string, primaryUsed: number, secondaryUsed?: number): CodexQuota {
  return {
    plan_type: planType,
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: primaryUsed,
      remaining_percent: 100 - primaryUsed,
      reset_at: null,
      limit_window_seconds: 18_000,
    },
    secondary_rate_limit: secondaryUsed === undefined ? null : {
      limit_reached: false,
      used_percent: secondaryUsed,
      remaining_percent: 100 - secondaryUsed,
      reset_at: null,
      limit_window_seconds: 604_800,
    },
    code_review_rate_limit: null,
  };
}

describe("OpenAI-compatible billing routes", () => {
  let pool: AccountPool;
  let accountSequence: number;

  beforeEach(() => {
    const config = createMockConfig();
    config.server.proxy_api_key = "billing-secret";
    setConfigForTesting(config);
    pool = new AccountPool({ persistence: createMemoryPersistence(), initialToken: null });
    accountSequence = 0;
  });

  afterEach(() => {
    resetConfigForTesting();
  });

  function addAccount(planType: string, accountQuota: CodexQuota): string {
    accountSequence += 1;
    const id = pool.addAccount(createValidJwt({ accountId: `${planType}-${accountSequence}`, planType }));
    pool.updateCachedQuota(id, accountQuota);
    return id;
  }

  it("requires the configured bearer key", async () => {
    const app = createBillingRoutes(pool);

    const response = await app.request("/v1/dashboard/billing/subscription");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_api_key" },
    });
  });

  it("reports Plus as 140 and usage in cents using the limiting quota window", async () => {
    addAccount("plus", quota("plus", 20, 35));
    const app = createBillingRoutes(pool);
    const headers = { Authorization: "Bearer billing-secret" };

    const subscription = await app.request("/v1/dashboard/billing/subscription", { headers });
    expect(subscription.status).toBe(200);
    expect(await subscription.json()).toEqual({
      object: "billing_subscription",
      has_payment_method: true,
      soft_limit_usd: 140,
      hard_limit_usd: 140,
      system_hard_limit_usd: 140,
      access_until: 0,
    });

    const usage = await app.request(
      "/v1/dashboard/billing/usage?start_date=2026-09-01&end_date=2026-09-16",
      { headers },
    );
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual({ object: "list", total_usage: 4900 });
  });

  it("supports official Pro 5x and Pro 20x virtual totals", async () => {
    addAccount("pro", quota("pro", 10));
    addAccount("pro_20x", quota("pro_20x", 25));
    const app = createBillingRoutes(pool);
    const headers = { Authorization: "Bearer billing-secret" };

    const subscription = await app.request("/v1/dashboard/billing/subscription", { headers });
    expect(await subscription.json()).toMatchObject({ hard_limit_usd: 3500 });

    const usage = await app.request("/v1/dashboard/billing/usage", { headers });
    expect(await usage.json()).toEqual({ object: "list", total_usage: 77000 });
  });

  it("excludes disabled accounts and unsupported plans", async () => {
    const disabledId = addAccount("plus", quota("plus", 100));
    pool.markStatus(disabledId, "disabled");
    addAccount("free", quota("free", 80));
    const app = createBillingRoutes(pool);

    const response = await app.request("/v1/dashboard/billing/subscription", {
      headers: { Authorization: "Bearer billing-secret" },
    });

    expect(await response.json()).toMatchObject({
      has_payment_method: false,
      hard_limit_usd: 0,
    });
  });
});
