import "./utils/install-dev-logger.js";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig, loadFingerprint, getConfig, hasLocalOverride } from "./config.js";
import { initContext } from "./context.js";
import { AccountPool } from "./auth/account-pool.js";

import { requestId } from "./middleware/request-id.js";
import { logger } from "./middleware/logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { dashboardAuth } from "./middleware/dashboard-auth.js";
import { logCapture } from "./middleware/log-capture.js";
import { cors } from "./middleware/cors.js";

import type { Server } from "http";
import { createAuthRoutes } from "./routes/auth.js";
import { createChatRoutes } from "./routes/chat.js";
import { createMessagesRoutes } from "./routes/messages.js";
import { createGeminiRoutes } from "./routes/gemini.js";
import { createModelRoutes } from "./routes/models.js";
import { createBillingRoutes } from "./routes/billing.js";
import { createWebRoutes } from "./routes/web.js";
import { CookieJar } from "./proxy/cookie-jar.js";
import { setWsPoolConfig, getWsPool } from "./proxy/ws-pool.js";
import { createResponsesRoutes } from "./routes/responses.js";
import { ResponsesWebSocketServer } from "./routes/responses-websocket.js";
import { createImagesRoutes } from "./routes/images.js";
import { startUpdateChecker, stopUpdateChecker } from "./update-checker.js";
import { startProxyUpdateChecker, stopProxyUpdateChecker, setCloseHandler, getDeployMode } from "./self-update.js";
import { initProxy } from "./tls/proxy.js";
import { initTransport, getTransport } from "./tls/transport.js";
import { loadStaticModels } from "./models/model-store.js";
import { startModelRefresh, stopModelRefresh } from "./models/model-fetcher.js";
import { startQuotaRefresh, stopQuotaRefresh } from "./auth/usage-refresher.js";
import { ActiveQuotaRefresher } from "./auth/active-quota-refresher.js";
import { UsageStatsStore } from "./auth/usage-stats.js";
import { startSessionCleanup, stopSessionCleanup } from "./auth/dashboard-session.js";
import { createDashboardAuthRoutes } from "./routes/dashboard-login.js";
import { startOllamaBridge, stopOllamaBridge } from "./ollama/server.js";
import { createOfficialAgentRoutes } from "./routes/official-agent.js";
import { installUncaughtErrorHandlers } from "./logs/error-log.js";
import { awaitServerListening } from "./utils/await-listening.js";

export interface ServerHandle {
  close: () => Promise<void>;
  port: number;
}

export interface StartOptions {
  host?: string;
  port?: number;
}

function urlHostForLocalRequest(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

/**
 * Core startup logic shared by CLI and Electron entry points.
 * Throws on config errors instead of calling process.exit().
 */
export async function startServer(options?: StartOptions): Promise<ServerHandle> {
  // Funnel uncaught errors / unhandled rejections into the local
  // error log before anything else can throw. Idempotent — Electron
  // main may have already called this earlier.
  installUncaughtErrorHandlers("server");

  // Load configuration
  console.log("[Init] Loading configuration...");
  const config = loadConfig();
  if (!process.env.PROXY_API_KEY?.trim()) {
    throw new Error("PROXY_API_KEY is required. Set it in the process environment before starting codex-proxy.");
  }
  const fingerprint = loadFingerprint();

  // Load static model catalog (before transport/auth init)
  loadStaticModels();

  // Detect proxy (config > env > auto-detect local ports)
  await initProxy();

  // Initialize TLS transport (auto-selects curl CLI or libcurl FFI)
  const transport = await initTransport();
  initContext(config, fingerprint, transport);

  // Initialize managers
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();

  // Create Hono app
  const app = new Hono();

  // Global middleware
  app.use("*", cors);
  app.use("*", requestId);
  app.use("*", logger);
  app.onError(errorHandler);
  app.use("*", dashboardAuth);
  app.use("*", logCapture);

  // Build upstream router from config
  const cfg = getConfig();

  // Wire WS connection pool to user config (defaults to enabled). Without
  // this call `getWsPool()` would always use DEFAULT_WS_POOL_CONFIG and
  // ignore `ws_pool.enabled: false` overrides — breaking the rollback path.
  setWsPoolConfig({
    enabled: cfg.ws_pool.enabled,
    maxAgeMs: cfg.ws_pool.max_age_ms,
    maxPerAccount: cfg.ws_pool.max_per_account,
  });
  // Mount routes
  const authRoutes = createAuthRoutes(accountPool);
  const chatRoutes = createChatRoutes(accountPool, cookieJar);
  const messagesRoutes = createMessagesRoutes(accountPool, cookieJar);
  const geminiRoutes = createGeminiRoutes(accountPool, cookieJar);
  const responsesRoutes = createResponsesRoutes(accountPool, cookieJar);
  const imagesRoutes = createImagesRoutes(accountPool, cookieJar);
  const usageStats = new UsageStatsStore();
  usageStats.recoverBaseline(accountPool);
  const webRoutes = createWebRoutes(accountPool, usageStats);

  app.route("/", createDashboardAuthRoutes());
  app.route("/", authRoutes);
  app.route("/", chatRoutes);
  app.route("/", messagesRoutes);
  app.route("/", geminiRoutes);
  app.route("/", responsesRoutes);
  app.route("/", imagesRoutes);
  app.route("/", createOfficialAgentRoutes());
  app.route("/", createModelRoutes(accountPool));
  app.route("/", createBillingRoutes(accountPool));
  app.route("/", webRoutes);

  // Start server
  // User's explicit local.yaml host wins over programmatic options (e.g. Electron's 127.0.0.1 default)
  const port = options?.port ?? config.server.port;
  const host = hasLocalOverride("server", "host")
    ? config.server.host
    : (options?.host ?? config.server.host);

  const displayHost = (host === "0.0.0.0" || host === "::") ? "localhost" : host;

  console.log(`
╔══════════════════════════════════════════╗
║           Codex Proxy Server             ║
╠══════════════════════════════════════════╣
║  Status: ${accountPool.isAuthenticated() ? "Authenticated ✓" : "Not logged in  "}             ║
║  Listen: http://${displayHost}:${port}              ║
║  API:    http://${displayHost}:${port}/v1            ║
╚══════════════════════════════════════════╝
`);

  if (accountPool.isAuthenticated()) {
    const user = accountPool.getUserInfo();
    console.log(`  User: ${user?.email ?? "unknown"}`);
    console.log(`  Plan: ${user?.planType ?? "unknown"}`);
    console.log("  Key:  configured through PROXY_API_KEY");
    console.log(`  Auth: ${accountPool.getAuthFilePath()}`);
  } else {
    console.log(`  Run codex login as this OS user, then POST /auth/reload`);
  }
  console.log();

  // Start dashboard session cleanup
  startSessionCleanup();

  // Start background update checkers
  // (Electron has its own native auto-updater — skip proxy update checker)
  startUpdateChecker();
  if (getDeployMode() !== "electron") {
    startProxyUpdateChecker();
  }

  // Start background model refresh (requires auth to be ready)
  startModelRefresh(accountPool, cookieJar);

  // Start usage stats snapshot timer (no upstream requests — quota is collected passively)
  startQuotaRefresh(accountPool, usageStats);

  // Start active quota refresher — proactively syncs limit_reached / dirty accounts
  const activeQuotaRefresher = new ActiveQuotaRefresher(accountPool, { cookieJar });
  activeQuotaRefresher.start();

  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  // Accept client WebSocket upgrades on /v1/responses (issue #681). The socket is
  // only a transport; each response.create frame is re-dispatched through the same
  // POST handler. HTTP POST+SSE remains the fallback. Must be closed in shutdown.
  const responsesWebsocket = new ResponsesWebSocketServer({
    server: server as Server,
    app,
    accountPool,
  });

  // `serve()` returns synchronously before `listen()` actually binds.
  // Wait for the listening event (or surface bind errors as a real
  // rejection of startServer) so callers' try/catch can react —
  // notably main.ts's port-fallback path, which was getting bypassed
  // because EADDRINUSE fired after `await startServer(...)` resolved.
  await awaitServerListening(server);

  // Resolve actual port (may differ from requested when port=0)
  const addr = server.address();
  const actualPort = (addr && typeof addr === "object") ? addr.port : port;
  const upstreamBaseUrl = `http://${urlHostForLocalRequest(host)}:${actualPort}`;
  await startOllamaBridge(getConfig(), { upstreamBaseUrl });

  const close = async (): Promise<void> => {
    await stopOllamaBridge();
    await responsesWebsocket.close();
    return new Promise((resolve) => {
      server.close(() => {
        stopUpdateChecker();
        stopProxyUpdateChecker();
        stopModelRefresh();
        stopQuotaRefresh();
        activeQuotaRefresher.stop();
        stopSessionCleanup();
        cookieJar.destroy();
        accountPool.destroy();
        resolve();
      });
    });
  };

  // Register close handler so self-update can attempt graceful shutdown before restart
  setCloseHandler(close);

  return { close, port: actualPort };
}

// ── CLI entry point ──────────────────────────────────────────────────

async function main() {
  let handle: ServerHandle;

  // Retry on EADDRINUSE — the previous process may still be releasing the port after a self-update restart
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      handle = await startServer();
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && attempt < MAX_RETRIES) {
        console.warn(`[Init] Port in use, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Init] Failed to start server: ${msg}`);
      console.error("[Init] Make sure config/default.yaml and config/fingerprint.yaml exist and are valid YAML.");
      process.exit(1);
    }
  }

  // P1-7: Graceful shutdown — stop accepting, drain, then cleanup
  let shutdownCalled = false;
  const shutdown = () => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    console.log("\n[Shutdown] Stopping new connections...");

    const forceExit = setTimeout(() => {
      console.error("[Shutdown] Timeout after 10s — forcing exit");
      process.exit(1);
    }, 10_000);
    if (forceExit.unref) forceExit.unref();

    handle.close().then(async () => {
      getTransport().destroy?.();
      try {
        await getWsPool().shutdown();
      } catch { /* never throws today, but defend against future regressions */ }
      console.log("[Shutdown] Server closed, cleanup complete.");
      clearTimeout(forceExit);
      process.exit(0);
    }).catch((err) => {
      console.error("[Shutdown] Error during cleanup:", err instanceof Error ? err.message : err);
      clearTimeout(forceExit);
      process.exit(1);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run CLI entry when executed directly (not imported by Electron)
const isDirectRun = process.argv[1]?.includes("index");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(1), 2000).unref();
  });
}
