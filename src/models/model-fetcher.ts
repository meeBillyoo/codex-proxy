/**
 * ModelFetcher — background model list refresh from Codex backend.
 *
 * Phase 8a: converted from module-level singletons to class.
 * Free function wrappers preserve backward compatibility for 7 importers.
 */

import { CodexApi } from "../proxy/codex-api.js";
import { applyBackendModelsForPlan } from "./model-store.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import { jitter } from "../utils/jitter.js";

const REFRESH_INTERVAL_HOURS = 1;
const INITIAL_DELAY_MS = 1_000;
const RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 12;

export class ModelFetcher {
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private hasFetchedOnce = false;
  private stopped = false;
  private pool: AccountPool;
  private cookieJar: CookieJar;

  constructor(pool: AccountPool, cookieJar: CookieJar) {
    this.pool = pool;
    this.cookieJar = cookieJar;
  }

  start(): void {
    this.stopped = false;
    this.hasFetchedOnce = false;
    this.refreshTimer = setTimeout(() => {
      this.attemptInitialFetch(0);
    }, INITIAL_DELAY_MS);
    console.log("[ModelFetcher] Scheduled initial model fetch in 1s");
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      console.log("[ModelFetcher] Stopped model refresh");
    }
  }

  triggerImmediate(): void {
    this.fetchModelsFromBackend()
      .then((success) => {
        if (success) this.hasFetchedOnce = true;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ModelFetcher] Immediate refresh failed: ${msg}`);
      });
  }

  hasFetched(): boolean {
    return this.hasFetchedOnce;
  }

  private async fetchModelsFromBackend(): Promise<boolean> {
    if (!this.pool.isAuthenticated()) return false;

    const acquired = this.pool.acquire();
    if (!acquired) {
      console.warn("[ModelFetcher] Codex CLI account unavailable — skipping model fetch");
      return false;
    }

    const entry = this.pool.getEntry(acquired.entryId);
    const planType = entry?.planType ?? "unknown";
    console.log(`[ModelFetcher] Fetching models for plan: ${planType}`);
    try {
      const api = new CodexApi(acquired.token, acquired.accountId, this.cookieJar, acquired.entryId);
      const models = await api.getModels();
      if (models && models.length > 0) {
        applyBackendModelsForPlan(planType, models);
        console.log(`[ModelFetcher] Plan "${planType}": ${models.length} models`);
        return true;
      }
      console.log(`[ModelFetcher] Plan "${planType}": empty model list — keeping existing`);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ModelFetcher] Model fetch failed: ${message}`);
      return false;
    } finally {
      this.pool.releaseWithoutCounting(acquired.entryId);
    }
  }

  private attemptInitialFetch(attempt: number): void {
    if (this.stopped) return;
    this.fetchModelsFromBackend()
      .then((success) => {
        if (this.stopped) return;
        if (success) {
          this.hasFetchedOnce = true;
          this.scheduleNext();
        } else if (attempt < MAX_RETRIES) {
          console.log(`[ModelFetcher] Codex CLI account not ready, retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`);
          this.refreshTimer = setTimeout(() => {
            this.attemptInitialFetch(attempt + 1);
          }, RETRY_DELAY_MS);
        } else {
          console.warn("[ModelFetcher] Max retries reached, falling back to hourly refresh");
          this.scheduleNext();
        }
      })
      .catch(() => {
        if (!this.stopped) this.scheduleNext();
      });
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const intervalMs = jitter(REFRESH_INTERVAL_HOURS * 3600 * 1000, 0.15);
    this.refreshTimer = setTimeout(async () => {
      try {
        await this.fetchModelsFromBackend();
      } finally {
        if (!this.stopped) this.scheduleNext();
      }
    }, intervalMs);
  }
}

// ── Free function wrappers (backward compatibility) ──────────────────

let _instance: ModelFetcher | null = null;

export function startModelRefresh(
  accountPool: AccountPool,
  cookieJar: CookieJar,
): void {
  _instance?.stop();
  _instance = new ModelFetcher(accountPool, cookieJar);
  _instance.start();
}

export function triggerImmediateRefresh(): void {
  _instance?.triggerImmediate();
}

export function hasFetchedModels(): boolean {
  return _instance?.hasFetched() ?? false;
}

export function stopModelRefresh(): void {
  _instance?.stop();
  _instance = null;
}
