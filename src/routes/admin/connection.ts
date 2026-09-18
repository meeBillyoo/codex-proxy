import { Hono } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import { getConfig } from "../../config.js";
import { getTransport, getTransportInfo } from "../../tls/transport.js";
import { buildHeaders } from "../../fingerprint/manager.js";
import { usageUrls } from "../../proxy/codex-usage.js";
import { isQuotaExhausted } from "../../auth/quota-skip.js";

export function createConnectionRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  app.post("/admin/test-connection", async (c) => {
    type DiagStatus = "pass" | "fail" | "skip";
    interface DiagCheck {
      name: string;
      status: DiagStatus;
      latencyMs: number;
      detail: string | null;
      error: string | null;
      errorCode?: "quota_exhausted" | "account_busy";
      resetAt?: number | null;
    }
    const checks: DiagCheck[] = [];
    let overallFailed = false;

    // 1. Server check
    const serverStart = Date.now();
    checks.push({
      name: "server",
      status: "pass",
      latencyMs: Date.now() - serverStart,
      detail: `PID ${process.pid}`,
      error: null,
    });

    // 2. Codex CLI account check
    const accountStart = Date.now();
    const account = accountPool.getAccount();
    const hasActive = account?.status === "active";
    const quotaExhausted = hasActive && isQuotaExhausted(account.quota);
    const exhaustedResetTimes = account?.quota
      ? [
          account.quota.rate_limit.limit_reached
            ? account.quota.rate_limit.reset_at
            : null,
          account.quota.secondary_rate_limit?.limit_reached
            ? account.quota.secondary_rate_limit.reset_at
            : null,
          account.quota.code_review_rate_limit?.limit_reached
            ? account.quota.code_review_rate_limit.reset_at
            : null,
          ...Object.values(account.quota.rate_limits_by_limit_id ?? {})
            .filter((limit) => limit.limit_reached)
            .map((limit) => limit.reset_at),
        ].filter((value): value is number => typeof value === "number")
      : [];
    const quotaResetAt = exhaustedResetTimes.length > 0
      ? Math.max(...exhaustedResetTimes)
      : null;
    const accountUsable = hasActive && !quotaExhausted;
    checks.push({
      name: "account",
      status: accountUsable ? "pass" : "fail",
      latencyMs: Date.now() - accountStart,
      detail: hasActive
        ? `${account.email ?? "Codex CLI account"} (${account.planType ?? "unknown plan"})`
        : account ? `Codex CLI account status: ${account.status}` : "Codex CLI auth file unavailable",
      error: quotaExhausted
        ? "Codex CLI account quota is exhausted"
        : hasActive ? null : "Codex CLI account is unavailable",
      ...(quotaExhausted
        ? { errorCode: "quota_exhausted" as const, resetAt: quotaResetAt }
        : {}),
    });
    if (!accountUsable) overallFailed = true;

    // 3. Transport check
    const transportStart = Date.now();
    const transportInfo = getTransportInfo();
    const transportOk = transportInfo.initialized;
    checks.push({
      name: "transport",
      status: transportOk ? "pass" : "fail",
      latencyMs: Date.now() - transportStart,
      detail: transportOk
        ? `${transportInfo.type}, impersonate=${transportInfo.impersonate}`
        : null,
      error: transportOk ? null : "Transport not initialized",
    });
    if (!transportOk) overallFailed = true;

    // 4. Upstream check
    if (!accountUsable) {
      checks.push({
        name: "upstream",
        status: "skip",
        latencyMs: 0,
        detail: quotaExhausted
          ? "Skipped (Codex CLI account quota is exhausted)"
          : "Skipped (Codex CLI account unavailable)",
        error: null,
      });
    } else {
      const upstreamStart = Date.now();
      const acquired = accountPool.acquire();
      if (!acquired) {
        checks.push({
          name: "upstream",
          status: "fail",
          latencyMs: Date.now() - upstreamStart,
          detail: null,
          error: "Codex CLI account is busy; all concurrency slots are in use",
          errorCode: "account_busy",
        });
        overallFailed = true;
      } else {
        try {
          const transport = getTransport();
          const config = getConfig();
          const urls = usageUrls(config.api.base_url);
          const headers = buildHeaders(acquired.token, acquired.accountId);
          let resp: { status: number; body: string } | undefined;
          for (const [index, url] of urls.entries()) {
            try {
              resp = await transport.get(url, headers, 15);
              if (resp.status >= 200 && resp.status < 400) break;
            } catch (err) {
              if (index === urls.length - 1) throw err;
            }
          }
          if (!resp) throw new Error("No usage endpoint available");
          const latency = Date.now() - upstreamStart;
          if (resp.status >= 200 && resp.status < 400) {
            checks.push({
              name: "upstream",
              status: "pass",
              latencyMs: latency,
              detail: `HTTP ${resp.status} (${latency}ms)`,
              error: null,
            });
          } else {
            checks.push({
              name: "upstream",
              status: "fail",
              latencyMs: latency,
              detail: `HTTP ${resp.status}`,
              error: `Upstream returned ${resp.status}`,
            });
            overallFailed = true;
          }
        } catch (err) {
          const latency = Date.now() - upstreamStart;
          checks.push({
            name: "upstream",
            status: "fail",
            latencyMs: latency,
            detail: null,
            error: err instanceof Error ? err.message : String(err),
          });
          overallFailed = true;
        } finally {
          accountPool.releaseWithoutCounting(acquired.entryId);
        }
      }
    }

    return c.json({
      checks,
      overall: overallFailed ? "fail" as const : "pass" as const,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
