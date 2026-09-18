import { describe, expect, it } from "vitest";
import { AccountPool } from "@src/auth/account-pool.js";
import type { AccountEntry } from "@src/auth/types.js";

function tokenExpiringAt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function poolWithEntry(entry: AccountEntry): AccountPool {
  const pool = Object.create(AccountPool.prototype) as AccountPool;
  (pool as unknown as { entry: AccountEntry | null }).entry = entry;
  return pool;
}

function entryWithToken(token: string): AccountEntry {
  return {
    id: "codex-cli",
    token,
    email: null,
    accountId: null,
    userId: null,
    label: null,
    planType: "pro",
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
    },
    addedAt: new Date().toISOString(),
    cachedQuota: {
      plan_type: "pro",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        remaining_percent: 0,
        reset_at: Math.floor(Date.now() / 1000) + 3600,
        limit_window_seconds: 604800,
      },
      secondary_rate_limit: null,
      code_review_rate_limit: null,
    },
    quotaFetchedAt: new Date().toISOString(),
  };
}

describe("AccountPool authentication", () => {
  it("stays authenticated when valid credentials have exhausted quota", () => {
    const pool = poolWithEntry(
      entryWithToken(tokenExpiringAt(Math.floor(Date.now() / 1000) + 3600)),
    );

    expect(pool.isAuthenticated()).toBe(true);
  });

  it("is not authenticated when the credential has expired", () => {
    const pool = poolWithEntry(
      entryWithToken(tokenExpiringAt(Math.floor(Date.now() / 1000) - 60)),
    );

    expect(pool.isAuthenticated()).toBe(false);
  });
});
