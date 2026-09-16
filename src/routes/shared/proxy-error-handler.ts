/**
 * Structured error handler for CodexApiError responses in the proxy handler.
 *
 * Returns an ErrorAction telling the orchestrator whether a transient retry
 * is appropriate or the error should be returned to the client.
 */

import type { AccountPool } from "../../auth/account-pool.js";
import { getRateLimitIdForModel } from "../../auth/quota-utils.js";
import {
  extractRetryAfterSec,
  isBanError,
  isCfChallengeError,
  isCfPathBlockError,
  isQuotaExhaustedError,
  isServerOverloadedError,
  isEarlyServerError,
  isTokenInvalidError,
  isModelNotSupportedError,
} from "../../proxy/error-classification.js";
import type { CodexApiError } from "../../proxy/codex-types.js";
import type { StatusCode } from "hono/utils/http-status";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import { recordCfPathBlock } from "../../auth/cf-path-block-tracker.js";
import { recordCfChallengeCooldown } from "../../auth/cf-challenge-cooldown.js";
import { appendErrorLog } from "../../logs/error-log.js";

/** Consecutive CF path-blocks before the account is auto-disabled. */
const CF_PATH_BLOCK_DISABLE_THRESHOLD = 3;

/** Clamp an HTTP status to a valid error StatusCode, defaulting to 502 for non-error codes. */
export function toErrorStatus(status: number): StatusCode {
  return (status >= 400 && status < 600 ? status : 502) as StatusCode;
}

export interface ErrorAction {
  status: number;
  message: string;
  useFormat429?: boolean;
}

/**
 * Classify a CodexApiError and mutate pool state accordingly.
 *
 * Returns the client-facing error after updating the current account state.
 *
 * @param err           The CodexApiError from upstream
 * @param pool          AccountPool for status mutations
 * @param entryId       Current account entry ID
 * @param model         Requested model name
 * @param tag           Route tag for logging
 */
export function handleCodexApiError(
  err: CodexApiError,
  pool: AccountPool,
  entryId: string,
  model: string,
  tag: string,
  cookieJar?: CookieJar,
): ErrorAction {
  const email = pool.getEntry(entryId)?.email ?? "?";

  // 1. Model not supported on this account's plan
  if (isModelNotSupportedError(err)) {
    console.warn(`[${tag}] Account ${entryId} (${email}) | Model "${model}" not supported`);
    const status = toErrorStatus(err.status);
    return { status, message: err.message };
  }

  console.error(`[${tag}] Account ${entryId} | Codex API error:`, err.message);

  // A server_error frame before any visible output is a transient backend
  // failure. It may be retried once on a fresh connection; never classify it
  // as quota, rate-limit, ban, or overload.
  if (isEarlyServerError(err)) {
    console.warn(`[${tag}] Account ${entryId} (${email}) | 500 early server error`);
    return { status: 500, message: err.message };
  }

  // 2. Rate-limited — write into cachedQuota.rate_limit (single source of
  // truth). applyRateLimit429 internally never shrinks an existing reset_at,
  // so a fresh secondary-window lock survives a stale primary 429.
  if (err.status === 429) {
    const retryAfterSec = extractRetryAfterSec(err.body);
    const limitId = getRateLimitIdForModel(model);
    if (limitId) {
      pool.applyAdditionalRateLimit429(entryId, limitId, { retryAfterSec, countRequest: true });
    } else {
      pool.applyRateLimit429(entryId, { retryAfterSec, countRequest: true });
    }
    const backoffDisplay = retryAfterSec != null ? Math.round(retryAfterSec) : null;
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 429 rate limited` +
        (limitId ? ` [${limitId}]` : "") +
        (backoffDisplay != null ? ` (resets in ${backoffDisplay}s)` : ""),
    );
    return { status: 429, message: err.message, useFormat429: true };
  }

  // 3. Quota exhausted (402 Payment Required)
  if (isQuotaExhaustedError(err)) {
    pool.markStatus(entryId, "quota_exhausted");
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 402 quota exhausted`,
    );
    return { status: 402, message: err.message };
  }

  // 503 server capacity — transient upstream condition. Do not mutate account
  // health or quota state.
  if (isServerOverloadedError(err)) {
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 503 server overloaded`,
    );
    return { status: 503, message: err.message };
  }

  // 4. Cloudflare challenge (403 HTML/challenge response) — cooldown, not ban.
  if (isCfChallengeError(err)) {
    const cooldown = recordCfChallengeCooldown(entryId);
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | Cloudflare challenge 403, ` +
        `cooling down for ${cooldown.delaySeconds}s`,
    );
    return { status: 502, message: "Upstream blocked the request (Cloudflare challenge)" };
  }

  // 5. Ban (non-Cloudflare 403)
  if (isBanError(err)) {
    pool.markStatus(entryId, "banned");
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 403 banned`,
    );
    return { status: 403, message: err.message };
  }

  // 6. Token invalidated / account deactivated
  if (isTokenInvalidError(err)) {
    const isDeactivated = err.message.toLowerCase().includes("deactivated");
    const newStatus = isDeactivated ? "banned" : "expired";
    pool.markStatus(entryId, newStatus);
    console.warn(
      `[${tag}] Account ${entryId} (${email}) | 401 ${isDeactivated ? "deactivated (banned)" : "token invalidated"}`,
    );
    return { status: 401, message: err.message };
  }

  // 7. Cloudflare path block (empty-body 404). CF's Bot Management can
  //    "hide" the /codex/responses path by returning 404 with no body when
  //    the captured __cf_bm cookie no longer matches the request
  //    fingerprint. Clear the cookie jar so a later attempt is clean and
  //    fingerprint-only. After
  //    the threshold is reached within the sliding window, disable the
  //    account so session affinity stops pinning a dying conversation to
  //    it.
  if (isCfPathBlockError(err)) {
    cookieJar?.clear(entryId);
    const blockCount = recordCfPathBlock(entryId);
    if (blockCount >= CF_PATH_BLOCK_DISABLE_THRESHOLD) {
      pool.markStatus(entryId, "disabled");
      console.warn(
        `[${tag}] Account ${entryId} (${email}) | Cloudflare path-block 404 ×${blockCount} — auto-disabling account`,
      );
      appendErrorLog({
        source: "server",
        error: {
          name: "CfPathBlockAutoDisable",
          message: `Account auto-disabled after ${blockCount} consecutive Cloudflare path-block 404s on /codex/responses`,
        },
        context: { entryId, email, model, tag, blockCount },
      });
    } else {
      console.warn(
        `[${tag}] Account ${entryId} (${email}) | Cloudflare path-block 404 ×${blockCount}, cleared cookies and retrying...`,
      );
    }
    return { status: 502, message: "Upstream blocked the request (Cloudflare path-block)" };
  }

  // 8. Generic error — let the route formatter produce the client protocol
  // envelope. Raw upstream bodies are reserved for terminal early
  // `server_error`, where preserving the exact backend payload is useful.
  const status = toErrorStatus(err.status);
  return { status, message: err.message };
}
