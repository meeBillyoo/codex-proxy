import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AccountPool } from "@src/auth/account-pool.js";

const apiMocks = vi.hoisted(() => ({
  getResetCredits: vi.fn(),
}));

vi.mock("@src/proxy/codex-api.js", () => ({
  CodexApi: class {
    getResetCredits = apiMocks.getResetCredits;
  },
}));

import { createAuthRoutes } from "@src/routes/auth.js";

function createPool(withAccount = true): AccountPool {
  return {
    getCurrentEntry: () => withAccount ? {
      id: "codex-cli",
      token: "secret-token",
      accountId: "acct-1",
    } : null,
    getAccount: () => null,
    getAuthFilePath: () => "/tmp/auth.json",
    isAuthenticated: () => withAccount,
  } as unknown as AccountPool;
}

function createApp(pool: AccountPool): Hono {
  const app = new Hono();
  app.route("/", createAuthRoutes(pool));
  return app;
}

describe("GET /auth/reset-credits", () => {
  beforeEach(() => {
    apiMocks.getResetCredits.mockReset();
  });

  it("returns only the reset-card count and nearest expiry", async () => {
    apiMocks.getResetCredits.mockResolvedValue({
      available_count: 2,
      next_expires_at: 1_800_000_000,
      credits: [{ id: "credit-secret", expires_at: 1_800_000_000 }],
    });

    const response = await createApp(createPool()).request("/auth/reset-credits");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available_count: 2,
      next_expires_at: 1_800_000_000,
    });
  });

  it("returns 404 when no CLI account is available", async () => {
    const response = await createApp(createPool(false)).request("/auth/reset-credits");

    expect(response.status).toBe(404);
    expect(apiMocks.getResetCredits).not.toHaveBeenCalled();
  });

  it("returns a gateway error when the upstream lookup fails", async () => {
    apiMocks.getResetCredits.mockRejectedValue(new Error("upstream unavailable"));

    const response = await createApp(createPool()).request("/auth/reset-credits");

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("upstream unavailable");
  });
});
