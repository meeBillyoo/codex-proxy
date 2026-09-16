import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodexApiError, toErrorStatus } from "@src/routes/shared/proxy-error-handler.js";
import { CodexApiError } from "@src/proxy/codex-types.js";
import { _resetAllCfChallengeCooldowns, getCfChallengeCooldown } from "@src/auth/cf-challenge-cooldown.js";

function createPool() {
  return {
    applyRateLimit429: vi.fn(),
    applyAdditionalRateLimit429: vi.fn(),
    markStatus: vi.fn(),
    getEntry: vi.fn(() => ({ email: "test@example.com" })),
  };
}

describe("handleCodexApiError", () => {
  const entryId = "codex-cli";
  const model = "gpt-5.4";
  let pool: ReturnType<typeof createPool>;

  beforeEach(() => {
    pool = createPool();
    _resetAllCfChallengeCooldowns();
  });

  it("returns a terminal model-not-supported response without changing account state", () => {
    const error = new CodexApiError(400, JSON.stringify({ error: { message: "Model is not supported on this plan" } }));
    expect(handleCodexApiError(error, pool as never, entryId, model, "Test")).toEqual({
      status: 400,
      message: expect.stringContaining("not supported"),
    });
    expect(pool.markStatus).not.toHaveBeenCalled();
  });

  it("records primary and Spark rate limits on the current account", () => {
    const error = new CodexApiError(429, JSON.stringify({ error: { resets_in_seconds: 30 } }));
    expect(handleCodexApiError(error, pool as never, entryId, model, "Test")).toMatchObject({ status: 429, useFormat429: true });
    expect(pool.applyRateLimit429).toHaveBeenCalledWith(entryId, { retryAfterSec: 30, countRequest: true });

    handleCodexApiError(error, pool as never, entryId, "gpt-5.3-codex-spark", "Test");
    expect(pool.applyAdditionalRateLimit429).toHaveBeenCalledWith(entryId, "codex_bengalfox", { retryAfterSec: 30, countRequest: true });
  });

  it("marks quota exhaustion, bans, and invalid tokens on the current account", () => {
    handleCodexApiError(new CodexApiError(402, "Payment required"), pool as never, entryId, model, "Test");
    expect(pool.markStatus).toHaveBeenCalledWith(entryId, "quota_exhausted");

    handleCodexApiError(new CodexApiError(403, JSON.stringify({ error: { message: "banned" } })), pool as never, entryId, model, "Test");
    expect(pool.markStatus).toHaveBeenCalledWith(entryId, "banned");

    handleCodexApiError(new CodexApiError(401, "token revoked"), pool as never, entryId, model, "Test");
    expect(pool.markStatus).toHaveBeenCalledWith(entryId, "expired");
  });

  it("treats Cloudflare challenges as upstream failures without banning", () => {
    const result = handleCodexApiError(new CodexApiError(403, "<html>cf_chl challenge</html>"), pool as never, entryId, model, "Test");
    expect(result).toEqual({ status: 502, message: "Upstream blocked the request (Cloudflare challenge)" });
    expect(pool.markStatus).not.toHaveBeenCalled();
    expect(getCfChallengeCooldown(entryId)?.delaySeconds).toBe(10);
  });

  it("clears account cookies for an empty-body Cloudflare path block", () => {
    const cookieJar = { clear: vi.fn() };
    const result = handleCodexApiError(new CodexApiError(404, ""), pool as never, entryId, model, "Test", cookieJar as never);
    expect(result.status).toBe(502);
    expect(cookieJar.clear).toHaveBeenCalledWith(entryId);
  });

  it("returns generic upstream errors directly and clamps invalid statuses", () => {
    expect(handleCodexApiError(new CodexApiError(503, "service unavailable"), pool as never, entryId, model, "Test")).toMatchObject({ status: 503 });
    expect(toErrorStatus(0)).toBe(502);
  });
});
