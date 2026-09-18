/** Read-only Codex CLI identity routes plus an explicit auth-file reload. */

import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import { CodexApi } from "../proxy/codex-api.js";

export function createAuthRoutes(pool: AccountPool): Hono {
  const app = new Hono();

  app.get("/auth/status", (c) => {
    const account = pool.getAccount();
    return c.json({
      authenticated: pool.isAuthenticated(),
      account,
      auth_file: pool.getAuthFilePath(),
    });
  });

  app.get("/auth/account", (c) => {
    const account = pool.getAccount();
    if (!account) {
      c.status(404);
      return c.json({
        error: "Codex CLI auth file is unavailable. Run `codex login` as the service user, then reload.",
        auth_file: pool.getAuthFilePath(),
      });
    }
    return c.json({ account, auth_file: pool.getAuthFilePath() });
  });

  app.get("/auth/reset-credits", async (c) => {
    const entry = pool.getCurrentEntry();
    if (!entry) {
      c.status(404);
      return c.json({ error: "Codex CLI auth file is unavailable." });
    }

    try {
      const credits = await new CodexApi(
        entry.token,
        entry.accountId,
        undefined,
        entry.id,
      ).getResetCredits();
      return c.json({
        available_count: credits.available_count ?? null,
        next_expires_at: credits.next_expires_at ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Auth] Failed to load reset credits: ${message}`);
      c.status(502);
      return c.json({ error: message });
    }
  });

  app.post("/auth/reload", (c) => {
    try {
      const result = pool.reloadFromCli();
      return c.json({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Auth] Failed to reload Codex CLI auth: ${message}`);
      c.status(500);
      return c.json({ error: message, auth_file: pool.getAuthFilePath() });
    }
  });

  return app;
}
