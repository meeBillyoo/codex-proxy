import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { AccountInfo, CodexQuota } from "../auth/types.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";

const PLUS_VIRTUAL_LIMIT_USD = 140;

function planMultiplier(planType: string | null | undefined): number {
  const normalized = planType?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";

  if (normalized.includes("pro") && normalized.includes("20x")) return 20;
  if (normalized.includes("pro") && normalized.includes("5x")) return 5;
  // The quota API commonly reports only "pro". Use the lower official Pro
  // tier rather than overstating an account as Pro 20x.
  if (normalized === "pro" || normalized.endsWith("_pro")) return 5;
  if (normalized === "plus" || normalized.endsWith("_plus")) return 1;
  return 0;
}

function boundedPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function effectiveUsedPercent(quota: CodexQuota | undefined): number {
  if (!quota) return 0;

  const primary = boundedPercent(quota.rate_limit.used_percent);
  const secondary = boundedPercent(quota.secondary_rate_limit?.used_percent);
  // Virtual limits are weekly, so prefer the weekly window. Older upstream
  // responses may omit it; in that case the primary window is the fallback.
  return secondary ?? primary ?? 0;
}

function isIncludedAccount(account: AccountInfo): boolean {
  return account.status === "active" || account.status === "refreshing" || account.status === "quota_exhausted";
}

function virtualBillingSnapshot(accounts: AccountInfo[]): { total: number; used: number } {
  let total = 0;
  let used = 0;

  for (const account of accounts) {
    if (!isIncludedAccount(account)) continue;

    const planType = account.quota?.plan_type ?? account.planType;
    const accountTotal = PLUS_VIRTUAL_LIMIT_USD * planMultiplier(planType);
    total += accountTotal;
    used += accountTotal * effectiveUsedPercent(account.quota) / 100;
  }

  return { total, used };
}

/** OpenAI-compatible legacy billing routes used by gateways such as new-api. */
export function createBillingRoutes(
  accountPool: AccountPool,
): Hono {
  const app = new Hono();
  const auth = apiKeyAuth(accountPool);

  app.use("/v1/dashboard/billing/subscription", auth);
  app.use("/v1/dashboard/billing/usage", auth);

  app.get("/v1/dashboard/billing/subscription", (c) => {
    const snapshot = virtualBillingSnapshot(accountPool.getAccounts());
    return c.json({
      object: "billing_subscription",
      has_payment_method: snapshot.total > 0,
      soft_limit_usd: snapshot.total,
      hard_limit_usd: snapshot.total,
      system_hard_limit_usd: snapshot.total,
      access_until: 0,
    });
  });

  app.get("/v1/dashboard/billing/usage", (c) => {
    const snapshot = virtualBillingSnapshot(accountPool.getAccounts());
    return c.json({
      object: "list",
      // The legacy OpenAI endpoint reports cents. new-api divides this by 100.
      total_usage: snapshot.used * 100,
    });
  });

  return app;
}
