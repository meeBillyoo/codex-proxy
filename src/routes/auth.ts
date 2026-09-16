/** Read-only Codex CLI identity routes plus an explicit auth-file reload. */

import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";

export function createAuthRoutes(pool: AccountPool): Hono {
  const app = new Hono();

  app.get("/auth/status", (c) => {
    const account = pool.getAccounts()[0] ?? null;
    return c.json({
      authenticated: pool.isAuthenticated(),
      account,
      auth_file: pool.getAuthFilePath(),
    });
  });

  app.get("/auth/account", (c) => {
    const account = pool.getAccounts()[0];
    if (!account) {
      c.status(404);
      return c.json({
        error: "Codex CLI auth file is unavailable. Run `codex login` as the service user, then reload.",
        auth_file: pool.getAuthFilePath(),
      });
    }
    return c.json({ account, auth_file: pool.getAuthFilePath() });
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
