/**
 * Tests for issue #753 Bug 1 fix: ambiguous /usage answers must not clear a
 * 429-learned lock whose reset_at is still in the future. An authoritative
 * answer that explicitly reports allowed=true with remaining quota does clear
 * the lock so stale local state cannot block an available account.
 */

import { describe, it, expect } from "vitest";
import { preserveLearnedLocks } from "@src/auth/active-quota-refresher.js";
import type { CodexQuota } from "@src/auth/types.js";

const NOW = Math.floor(Date.now() / 1000);

function quota(overrides: Partial<CodexQuota> = {}): CodexQuota {
  return {
    plan_type: "free",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 30,
      reset_at: NOW + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
    ...overrides,
  };
}

describe("preserveLearnedLocks", () => {
  it("keeps a future primary lock when /usage lacks an explicit remaining balance", () => {
    const existing = quota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: NOW + 28 * 24 * 3600,
        limit_window_seconds: 3600,
      },
    });
    const fresh = quota({ rate_limit: { allowed: true, limit_reached: false, used_percent: 40, reset_at: null, limit_window_seconds: null } });

    const merged = preserveLearnedLocks(existing, fresh);
    expect(merged.rate_limit.limit_reached).toBe(true);
    expect(merged.rate_limit.allowed).toBe(false);
    expect(merged.rate_limit.used_percent).toBe(100);
    expect(merged.rate_limit.reset_at).toBe(existing.rate_limit.reset_at);
  });

  it("clears a future primary lock when /usage explicitly reports remaining quota", () => {
    const existing = quota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        remaining_percent: 0,
        reset_at: NOW + 28 * 24 * 3600,
        limit_window_seconds: 3600,
      },
    });
    const fresh = quota({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: 36,
        remaining_percent: 64,
        reset_at: NOW + 3600,
        limit_window_seconds: 7 * 24 * 3600,
      },
    });

    const merged = preserveLearnedLocks(existing, fresh);

    expect(merged.rate_limit).toEqual(fresh.rate_limit);
  });

  it("unlocks once the lock reset_at has passed", () => {
    const existing = quota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: NOW - 60, // already passed
        limit_window_seconds: 3600,
      },
    });
    const fresh = quota({ rate_limit: { allowed: true, limit_reached: false, used_percent: 40, reset_at: null, limit_window_seconds: null } });

    const merged = preserveLearnedLocks(existing, fresh);
    expect(merged.rate_limit.limit_reached).toBe(false);
    expect(merged.rate_limit.allowed).toBe(true);
  });

  it("applies a fresh exhausted quota as-is", () => {
    const existing = quota();
    const fresh = quota({
      rate_limit: {
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        reset_at: NOW + 3600,
        limit_window_seconds: 3600,
      },
    });

    const merged = preserveLearnedLocks(existing, fresh);
    expect(merged.rate_limit.limit_reached).toBe(true);
    expect(merged.rate_limit.reset_at).toBe(fresh.rate_limit.reset_at);
  });

  it("keeps future secondary and code_review locks", () => {
    const existing = quota({
      secondary_rate_limit: { limit_reached: true, used_percent: 100, reset_at: NOW + 3600, limit_window_seconds: 3600 },
      code_review_rate_limit: { allowed: false, limit_reached: true, used_percent: 100, reset_at: NOW + 7200, limit_window_seconds: 3600 },
    });
    const fresh = quota({
      secondary_rate_limit: { limit_reached: false, used_percent: 20, reset_at: null, limit_window_seconds: null },
      code_review_rate_limit: { allowed: true, limit_reached: false, used_percent: 20, reset_at: null, limit_window_seconds: null },
    });

    const merged = preserveLearnedLocks(existing, fresh);
    expect(merged.secondary_rate_limit?.limit_reached).toBe(true);
    expect(merged.secondary_rate_limit?.reset_at).toBe(existing.secondary_rate_limit?.reset_at);
    expect(merged.code_review_rate_limit?.limit_reached).toBe(true);
    expect(merged.code_review_rate_limit?.reset_at).toBe(existing.code_review_rate_limit?.reset_at);
  });

  it("keeps a future per-model bucket lock", () => {
    const existing = quota({
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          limit_id: "codex_bengalfox",
          limit_name: "codex_bengalfox",
          allowed: false,
          limit_reached: true,
          used_percent: 100,
          remaining_percent: 0,
          reset_at: NOW + 3600,
          limit_window_seconds: 3600,
          secondary_rate_limit: null,
        },
      },
    });
    const fresh = quota({
      rate_limits_by_limit_id: {
        codex_bengalfox: {
          limit_id: "codex_bengalfox",
          limit_name: "codex_bengalfox",
          allowed: true,
          limit_reached: false,
          used_percent: 20,
          remaining_percent: 80,
          reset_at: null,
          limit_window_seconds: null,
          secondary_rate_limit: null,
        },
      },
    });

    const merged = preserveLearnedLocks(existing, fresh);
    expect(merged.rate_limits_by_limit_id?.codex_bengalfox?.limit_reached).toBe(true);
    expect(merged.rate_limits_by_limit_id?.codex_bengalfox?.reset_at).toBe(
      existing.rate_limits_by_limit_id?.codex_bengalfox?.reset_at,
    );
  });

  it("returns fresh unchanged when there is no existing lock", () => {
    const fresh = quota({ rate_limit: { allowed: true, limit_reached: false, used_percent: 20, reset_at: null, limit_window_seconds: null } });
    const merged = preserveLearnedLocks(undefined, fresh);
    expect(merged).toEqual(fresh);
  });
});
