/**
 * Runtime for the one Codex CLI account owned by the current OS user.
 * Credentials always come from `$CODEX_HOME/auth.json` (or `~/.codex/auth.json`).
 * Only non-secret usage and quota state is persisted by this application.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { getConfig } from "../config.js";
import { getDataDir } from "../paths.js";
import { jitter } from "../utils/jitter.js";
import { getCliAuthPath, importCliAuth } from "./cli-auth.js";
import { extractChatGptAccountId, extractUserProfile, isTokenExpired } from "./jwt-utils.js";
import { hasReachedCachedQuota } from "./quota-skip.js";
import { safeEqual } from "./safe-equal.js";
import type { AccountEntry, AccountInfo, AccountUsage, AcquiredAccount, CodexQuota } from "./types.js";

const ENTRY_ID = "codex-cli";
const STATE_FILE = "codex-account-state.json";
const ACQUIRE_LOCK_TTL_MS = 5 * 60 * 1000;

interface PersistedAccountState {
  version: 1;
  usage: AccountUsage;
  cachedQuota: CodexQuota | null;
  quotaFetchedAt: string | null;
  trackingStartedAt?: string;
}

export interface CliAccountReloadResult {
  account: AccountInfo;
  auth_file: string;
}

export interface AccountCapacitySummary {
  max_concurrent_per_account: number;
  total_slots: number;
  used_slots: number;
  available_slots: number;
}

function emptyUsage(): AccountUsage {
  return {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    empty_response_count: 0,
    last_used: null,
    window_request_count: 0,
    window_input_tokens: 0,
    window_output_tokens: 0,
    window_cached_tokens: 0,
    window_counters_reset_at: null,
    limit_window_seconds: null,
  };
}

function loadState(): PersistedAccountState {
  const filePath = resolve(getDataDir(), STATE_FILE);
  try {
    if (!existsSync(filePath)) {
      return { version: 1, usage: emptyUsage(), cachedQuota: null, quotaFetchedAt: null };
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<PersistedAccountState>;
    return {
      version: 1,
      usage: { ...emptyUsage(), ...(parsed.usage ?? {}) },
      cachedQuota: parsed.cachedQuota ?? null,
      quotaFetchedAt: parsed.quotaFetchedAt ?? null,
      trackingStartedAt: parsed.trackingStartedAt,
    };
  } catch (error) {
    console.warn(`[Auth] Failed to read ${STATE_FILE}: ${error instanceof Error ? error.message : error}`);
    return { version: 1, usage: emptyUsage(), cachedQuota: null, quotaFetchedAt: null };
  }
}

export class AccountPool {
  private entry: AccountEntry | null = null;
  private activeSlots: number[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly state = loadState();

  constructor() {
    try {
      this.reloadFromCli();
    } catch (error) {
      console.warn(`[Auth] Codex CLI account unavailable: ${error instanceof Error ? error.message : error}`);
    }
  }

  reloadFromCli(): CliAccountReloadResult {
    const cliAuth = importCliAuth();
    const token = cliAuth.access_token!;
    const profile = extractUserProfile(token);
    const tokenAccountId = extractChatGptAccountId(token);
    const accountId = tokenAccountId ?? cliAuth.account_id ?? null;
    const prior = this.entry;

    this.entry = {
      id: ENTRY_ID,
      token,
      email: profile?.email ?? null,
      accountId,
      organizationId: null,
      accountIdSource: tokenAccountId ? "access_token" : accountId ? "id_token" : null,
      userId: profile?.chatgpt_user_id ?? null,
      label: null,
      codexFingerprintMode: "off",
      planType: profile?.chatgpt_plan_type ?? null,
      status: isTokenExpired(token) ? "expired" : "active",
      usage: prior?.usage ?? this.state.usage,
      addedAt: prior?.addedAt ?? this.state.trackingStartedAt ?? new Date().toISOString(),
      cachedQuota: prior?.cachedQuota ?? this.state.cachedQuota,
      quotaFetchedAt: prior?.quotaFetchedAt ?? this.state.quotaFetchedAt,
      quotaVerifyRequired: prior?.quotaVerifyRequired,
    };

    void import("../proxy/ws-pool.js")
      .then((mod) => mod.getWsPool().evictByEntryId(ENTRY_ID))
      .catch(() => {});

    return { account: this.toInfo(this.entry), auth_file: getCliAuthPath() };
  }

  getAuthFilePath(): string {
    return getCliAuthPath();
  }

  acquire(options?: { model?: string }): AcquiredAccount | null {
    const entry = this.entry;
    if (!entry) return null;
    this.refreshStatus(entry);
    if (entry.status !== "active") return null;
    if (getConfig().quota.skip_exhausted && hasReachedCachedQuota(entry, options?.model)) return null;

    const now = Date.now();
    this.activeSlots = this.activeSlots.filter((startedAt) => now - startedAt <= ACQUIRE_LOCK_TTL_MS);
    const maxConcurrent = getConfig().auth.max_concurrent_per_account ?? 3;
    if (this.activeSlots.length >= maxConcurrent) return null;
    const prevSlotMs = this.activeSlots.at(-1) ?? null;
    this.activeSlots.push(now);
    return { entryId: ENTRY_ID, token: entry.token, accountId: entry.accountId, codexFingerprintMode: "off", prevSlotMs };
  }

  release(entryId: string, usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    estimated_cost_usd?: number;
    image_input_tokens?: number;
    image_output_tokens?: number;
    image_request_attempted?: boolean;
    image_request_succeeded?: boolean;
  }): void {
    this.releaseSlot(entryId);
    const entry = this.entry;
    if (!entry || entryId !== ENTRY_ID) return;
    const current = entry.usage;
    current.request_count++;
    current.last_used = new Date().toISOString();
    current.window_request_count = (current.window_request_count ?? 0) + 1;
    if (usage) {
      current.input_tokens += usage.input_tokens ?? 0;
      current.output_tokens += usage.output_tokens ?? 0;
      current.cached_tokens = (current.cached_tokens ?? 0) + (usage.cached_tokens ?? 0);
      current.estimated_cost_usd = (current.estimated_cost_usd ?? 0) + (usage.estimated_cost_usd ?? 0);
      current.image_input_tokens = (current.image_input_tokens ?? 0) + (usage.image_input_tokens ?? 0);
      current.image_output_tokens = (current.image_output_tokens ?? 0) + (usage.image_output_tokens ?? 0);
      current.window_input_tokens = (current.window_input_tokens ?? 0) + (usage.input_tokens ?? 0);
      current.window_output_tokens = (current.window_output_tokens ?? 0) + (usage.output_tokens ?? 0);
      current.window_cached_tokens = (current.window_cached_tokens ?? 0) + (usage.cached_tokens ?? 0);
      current.window_estimated_cost_usd = (current.window_estimated_cost_usd ?? 0) + (usage.estimated_cost_usd ?? 0);
      current.window_image_input_tokens = (current.window_image_input_tokens ?? 0) + (usage.image_input_tokens ?? 0);
      current.window_image_output_tokens = (current.window_image_output_tokens ?? 0) + (usage.image_output_tokens ?? 0);
      if (usage.image_request_attempted) {
        if (usage.image_request_succeeded) {
          current.image_request_count = (current.image_request_count ?? 0) + 1;
          current.window_image_request_count = (current.window_image_request_count ?? 0) + 1;
        } else {
          current.image_request_failed_count = (current.image_request_failed_count ?? 0) + 1;
          current.window_image_request_failed_count = (current.window_image_request_failed_count ?? 0) + 1;
        }
      }
    }
    this.schedulePersist();
  }

  releaseWithoutCounting(entryId: string): void {
    this.releaseSlot(entryId);
  }

  private releaseSlot(entryId: string): void {
    if (entryId === ENTRY_ID) this.activeSlots.shift();
  }

  hasAvailableAccount(): boolean {
    const entry = this.entry;
    if (!entry) return false;
    this.refreshStatus(entry);
    return entry.status === "active" && (!getConfig().quota.skip_exhausted || !hasReachedCachedQuota(entry));
  }

  markStatus(entryId: string, status: AccountEntry["status"]): void {
    if (!this.entry || entryId !== ENTRY_ID) return;
    this.entry.status = status;
    if (status !== "active") {
      this.activeSlots = [];
      void import("../proxy/ws-pool.js").then((mod) => mod.getWsPool().evictByEntryId(ENTRY_ID)).catch(() => {});
    }
    this.schedulePersist();
  }

  applyRateLimit429(entryId: string, options?: { retryAfterSec?: number; resetsAtSec?: number; countRequest?: boolean }): void {
    const entry = this.entry;
    if (!entry || entryId !== ENTRY_ID) return;
    const nowSec = Date.now() / 1000;
    const backoff = getConfig().auth.rate_limit_backoff_seconds;
    const nextReset = options?.resetsAtSec
      ?? (options?.retryAfterSec != null ? nowSec + jitter(options.retryAfterSec, 0.2) : nowSec + jitter(backoff, 0.2));
    const quota = entry.cachedQuota ?? this.emptyQuota(entry, nextReset);
    quota.rate_limit = { ...quota.rate_limit, allowed: false, limit_reached: true, used_percent: 100, remaining_percent: 0, reset_at: Math.max(quota.rate_limit.reset_at ?? 0, nextReset) };
    entry.cachedQuota = quota;
    entry.quotaFetchedAt = new Date().toISOString();
    if (options?.countRequest) this.recordRequestOnly(entry);
    this.schedulePersist();
  }

  applyAdditionalRateLimit429(entryId: string, limitId: string, options?: { retryAfterSec?: number; resetsAtSec?: number; countRequest?: boolean }): void {
    const entry = this.entry;
    if (!entry || entryId !== ENTRY_ID) return;
    const nowSec = Date.now() / 1000;
    const backoff = getConfig().auth.rate_limit_backoff_seconds;
    const nextReset = options?.resetsAtSec
      ?? (options?.retryAfterSec != null ? nowSec + jitter(options.retryAfterSec, 0.2) : nowSec + jitter(backoff, 0.2));
    const quota = entry.cachedQuota ?? this.emptyQuota(entry, null);
    const prior = quota.rate_limits_by_limit_id?.[limitId];
    quota.rate_limits_by_limit_id = {
      ...(quota.rate_limits_by_limit_id ?? {}),
      [limitId]: {
        limit_id: limitId,
        limit_name: prior?.limit_name ?? limitId,
        allowed: false,
        limit_reached: true,
        used_percent: 100,
        remaining_percent: 0,
        reset_at: Math.max(prior?.reset_at ?? 0, nextReset),
        limit_window_seconds: prior?.limit_window_seconds ?? entry.usage.limit_window_seconds ?? null,
        secondary_rate_limit: prior?.secondary_rate_limit ?? null,
      },
    };
    entry.cachedQuota = quota;
    entry.quotaFetchedAt = new Date().toISOString();
    if (options?.countRequest) this.recordRequestOnly(entry);
    this.schedulePersist();
  }

  recordEmptyResponse(entryId: string): void {
    if (!this.entry || entryId !== ENTRY_ID) return;
    this.entry.usage.empty_response_count++;
    this.schedulePersist();
  }

  updateCachedQuota(entryId: string, quota: CodexQuota): void {
    const entry = this.entry;
    if (!entry || entryId !== ENTRY_ID) return;
    entry.cachedQuota = {
      ...quota,
      credits: quota.credits ?? entry.cachedQuota?.credits,
      reset_credits_available: quota.reset_credits_available ?? entry.cachedQuota?.reset_credits_available,
    };
    entry.quotaFetchedAt = new Date().toISOString();
    entry.quotaVerifyRequired = false;
    this.schedulePersist();
  }

  syncRateLimitWindow(entryId: string, newResetAt: number | null, limitWindowSeconds: number | null): void {
    const entry = this.entry;
    if (!entry || entryId !== ENTRY_ID || newResetAt == null) return;
    const usage = entry.usage;
    const oldResetAt = usage.window_reset_at;
    if (oldResetAt != null && oldResetAt !== newResetAt) {
      const windowSec = limitWindowSeconds ?? usage.limit_window_seconds ?? 0;
      if (Math.abs(newResetAt - oldResetAt) >= (windowSec > 0 ? windowSec * 0.5 : 3600)) {
        usage.window_request_count = 0;
        usage.window_input_tokens = 0;
        usage.window_output_tokens = 0;
        usage.window_cached_tokens = 0;
        usage.window_estimated_cost_usd = 0;
        usage.window_image_input_tokens = 0;
        usage.window_image_output_tokens = 0;
        usage.window_image_request_count = 0;
        usage.window_image_request_failed_count = 0;
        usage.window_counters_reset_at = new Date().toISOString();
      }
    }
    usage.window_reset_at = newResetAt;
    if (limitWindowSeconds != null) usage.limit_window_seconds = limitWindowSeconds;
    this.schedulePersist();
  }

  getAccount(): AccountInfo | null {
    return this.entry ? this.toInfo(this.entry) : null;
  }

  getCurrentEntry(): AccountEntry | null {
    return this.entry;
  }

  getEntry(entryId: string): AccountEntry | undefined {
    return entryId === ENTRY_ID ? this.entry ?? undefined : undefined;
  }

  isAuthenticated(): boolean {
    return this.hasAvailableAccount();
  }

  getUserInfo(): { email?: string; accountId?: string; planType?: string } | null {
    const entry = this.entry;
    if (!entry) return null;
    return { email: entry.email ?? undefined, accountId: entry.accountId ?? undefined, planType: entry.planType ?? undefined };
  }

  validateProxyApiKey(key: string): boolean {
    const configured = process.env.PROXY_API_KEY?.trim();
    return Boolean(configured && safeEqual(key, configured));
  }

  getCapacitySummary(): AccountCapacitySummary {
    const max = getConfig().auth.max_concurrent_per_account ?? 3;
    const used = this.activeSlots.length;
    return { max_concurrent_per_account: max, total_slots: max, used_slots: used, available_slots: Math.max(0, max - used) };
  }

  destroy(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistNow();
    this.activeSlots = [];
  }

  private recordRequestOnly(entry: AccountEntry): void {
    entry.usage.request_count++;
    entry.usage.window_request_count = (entry.usage.window_request_count ?? 0) + 1;
    entry.usage.last_used = new Date().toISOString();
  }

  private emptyQuota(entry: AccountEntry, resetAt: number | null): CodexQuota {
    return {
      plan_type: entry.planType ?? "unknown",
      rate_limit: { allowed: resetAt == null, limit_reached: resetAt != null, used_percent: resetAt == null ? null : 100, reset_at: resetAt, limit_window_seconds: entry.usage.limit_window_seconds ?? null },
      secondary_rate_limit: null,
      code_review_rate_limit: null,
    };
  }

  private refreshStatus(entry: AccountEntry): void {
    if (entry.status === "banned" || entry.status === "disabled") return;
    entry.status = isTokenExpired(entry.token) ? "expired" : "active";
  }

  private toInfo(entry: AccountEntry): AccountInfo {
    this.refreshStatus(entry);
    let expiresAt: string | null = null;
    try {
      const payload = JSON.parse(Buffer.from(entry.token.split(".")[1], "base64url").toString("utf-8")) as { exp?: number };
      if (payload.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
    } catch {}
    return {
      id: entry.id,
      email: entry.email,
      accountId: entry.accountId,
      organizationId: entry.organizationId,
      accountIdSource: entry.accountIdSource,
      userId: entry.userId,
      label: null,
      codexFingerprintMode: "off",
      planType: entry.planType,
      status: entry.status,
      usage: entry.usage,
      addedAt: entry.addedAt,
      expiresAt,
      quota: entry.cachedQuota ?? undefined,
      quotaFetchedAt: entry.quotaFetchedAt,
      quotaVerifyRequired: entry.quotaVerifyRequired,
    };
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 250);
  }

  private persistNow(): void {
    const entry = this.entry;
    if (!entry) return;
    const filePath = resolve(getDataDir(), STATE_FILE);
    const tmpPath = `${filePath}.tmp`;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify({
        version: 1,
        usage: entry.usage,
        cachedQuota: entry.cachedQuota,
        quotaFetchedAt: entry.quotaFetchedAt,
        trackingStartedAt: entry.addedAt,
      } satisfies PersistedAccountState));
      renameSync(tmpPath, filePath);
    } catch (error) {
      console.error(`[Auth] Failed to persist ${STATE_FILE}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
