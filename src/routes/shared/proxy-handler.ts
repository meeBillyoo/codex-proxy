/**
 * Shared proxy handler — orchestrates the account acquire → retry →
 * stream/collect → release lifecycle common to all API format routes.
 *
 * Delegates to:
 *   - account-acquisition.ts  — acquire / release with idempotent guard
 *   - proxy-egress-log.ts     — upstream request audit log entries
 *   - proxy-error-handler.ts  — CodexApiError classification + pool state mutations
 *   - proxy-implicit-resume-lifecycle.ts — implicit-resume state machine / rollback
 *   - proxy-implicit-resume-request.ts — implicit-resume request apply/restore state
 *   - proxy-request-preparation.ts — request input/default forwarding fields
 *   - proxy-session-context.ts — prompt cache / affinity / implicit-resume derived state
 *   - proxy-retry-recovery.ts — same-account retry recovery decision/application
 *   - proxy-upstream-attempt.ts — one upstream request attempt + egress/rate-limit capture
 *   - proxy-debug-dump.ts     — opt-in request payload diagnostics
 *   - proxy-request-diagnostics.ts — request summary / large payload logs
 *   - proxy-stagger.ts        — request interval staggering
 *   - proxy-ws-context.ts     — WebSocket pool context construction
 *   - streaming-handler.ts    — streaming (SSE) response lifecycle
 *   - non-streaming-handler.ts — collect / retry response lifecycle
 */

import { CodexApi, CodexApiError, PreviousResponseWebSocketError } from "../../proxy/codex-api.js";
import { toQuota } from "../../auth/quota-utils.js";
import { acquireAccount, releaseAccount } from "./account-acquisition.js";
import { handleCodexApiError } from "./proxy-error-handler.js";
import { handleStreaming } from "./streaming-handler.js";
import { handleNonStreaming } from "./non-streaming-handler.js";
import { annotateImageGenOutcome, buildCodexApi } from "./proxy-handler-utils.js";
import type {
  FormatAdapter,
  HandleProxyRequestOptions,
  ProxyRequest,
} from "./proxy-handler-types.js";
import { getSessionAffinityMap } from "../../auth/session-affinity.js";
import { randomUUID } from "crypto";
import {
  respondWithNoAccount,
  respondWithProxyError,
} from "./proxy-error-response.js";
import { createImplicitResumeLifecycle } from "./proxy-implicit-resume-lifecycle.js";
import { captureImplicitResumeRequestState } from "./proxy-implicit-resume-request.js";
import {
  applyProxyRequestForwardingDefaults,
  ensureProxyRequestInputArray,
} from "./proxy-request-preparation.js";
import { logRequestDiagnostics } from "./proxy-request-diagnostics.js";
import {
  applyProxyRetryRecoveryDecision,
  buildProxyRetryRecoveryDecision,
  invalidateRejectedPreviousResponse,
} from "./proxy-retry-recovery.js";
import { classifyRetryAction } from "./proxy-retry-classifier.js";
import { buildProxySessionContext } from "./proxy-session-context.js";
import { staggerIfNeeded } from "./proxy-stagger.js";
import { sendProxyUpstreamAttempt } from "./proxy-upstream-attempt.js";
import { buildWsPoolContext, forgetWsResponseOwner } from "./proxy-ws-context.js";
import {
  containsInvalidEncryptedContentSignal,
  getReasoningReplayCache,
} from "../../proxy/reasoning-replay-cache.js";

export async function handleProxyRequest(options: HandleProxyRequestOptions): Promise<Response> {
  const { c, accountPool, cookieJar, req, fmt } = options;
  c.set("logForwarded", true);

  const affinityMap = getSessionAffinityMap();
  const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
  ensureProxyRequestInputArray(req);
  const originalRequestState = captureImplicitResumeRequestState(req);
  const sessionContext = buildProxySessionContext({ request: req, affinityMap });
  let chainAdvanceTicket = sessionContext.chainAdvanceTicket;
  let recoveryWsKeySuffix: string | undefined;
  let continuityRecoveryCount = 0;

  // turnState is scoped to one Codex turn. Preserve only a value supplied by
  // the current client request; never restore it from cross-turn affinity.
  applyProxyRequestForwardingDefaults({
    request: req,
    promptCacheKey: sessionContext.promptCacheKey,
  });

  const released = new Set<string>();

  const acquired = acquireAccount(accountPool, req.codexRequest.model, fmt.tag);
  if (!acquired) {
    return respondWithNoAccount({ c, req, fmt });
  }

  const entry = accountPool.getEntry(acquired.entryId);
  if (entry?.quotaVerifyRequired) {
    console.log(`[${fmt.tag}] Verifying cached quota for the current CLI account`);
    try {
      const usage = await new CodexApi(
        acquired.token,
        acquired.accountId,
        cookieJar,
        acquired.entryId,
      ).getUsage();
      const quota = toQuota(usage);
      accountPool.updateCachedQuota(acquired.entryId, quota);
      if (quota.rate_limit.limit_reached) {
        releaseAccount(accountPool, acquired.entryId, undefined, released);
        return respondWithNoAccount({ c, req, fmt });
      }
    } catch (err) {
      console.warn(`[${fmt.tag}] Failed to verify current CLI account quota:`, err);
    }
  }

  let { entryId } = acquired;

  const accountDisplayName = (id: string): string | null => {
    const entry = accountPool.getEntry(id);
    if (entry?.label) return entry.label;
    if (entry?.email) return entry.email;
    return id.slice(0, 8);
  };

  let codexApi = buildCodexApi(
    acquired.token,
    acquired.accountId,
    cookieJar,
    entryId,
    acquired.codexFingerprintMode ?? "off",
  );
  let stripAndRetryDone = false;
  const reasoningReplayCache = getReasoningReplayCache();
  const reasoningReplayItems = sessionContext.implicitPrevRespId
    ? reasoningReplayCache.lookup({
        responseId: sessionContext.implicitPrevRespId,
        entryId,
        conversationId: sessionContext.chainConversationId,
        variantHash: sessionContext.variantHash,
      })
    : [];

  const implicitResume = createImplicitResumeLifecycle({
    request: req,
    snapshot: originalRequestState,
    affinityMap,
    tag: fmt.tag,
    implicitPrevRespId: sessionContext.implicitPrevRespId,
    continuationInputStart: sessionContext.continuationInputStart,
    reasoningReplayItems,
    resumeEvaluationInput: sessionContext.resumeEvaluationInput,
    acquiredEntryId: entryId,
  });
  implicitResume.logSkippedWarnings();
  implicitResume.activate();

  const diagnostics = logRequestDiagnostics({
    tag: fmt.tag,
    entryId,
    requestId,
    request: req,
    chainConversationId: sessionContext.chainConversationId,
    promptCacheKey: sessionContext.promptCacheKey,
    variantHash: sessionContext.variantHash,
    explicitPrevRespId: sessionContext.explicitPrevRespId,
    implicitPrevRespId: sessionContext.implicitPrevRespId,
    prevRespId: sessionContext.prevRespId,
    resumeActive: implicitResume.evaluation.active,
    resumeReason: implicitResume.evaluation.reason,
    preferredEntryId: sessionContext.preferredEntryId,
  });

  // Guard: when implicit resume fails due to missing tool calls, block runaway
  // full-history replays that would burn massive token budgets silently.
  // Relaxed thresholds: legitimate client-driven full replays (e.g. after
  // Codex CLI /compact) regularly hit 300-800KB / 100-800 items, and the
  // previous 250KB / 80-item gate was 413'ing them. Real runaway loops
  // typically blow past several MB before the issue becomes obvious.
  const PAYLOAD_GUARD_BYTES = 2_000_000;
  const PAYLOAD_GUARD_ITEMS = 1000;
  if (
    implicitResume.evaluation.reason === "missing_tool_calls" ||
    implicitResume.evaluation.reason === "unanswered_tool_calls"
  ) {
    const inputItemCount = req.codexRequest.input?.length ?? 0;
    if (diagnostics.payloadBytes > PAYLOAD_GUARD_BYTES || inputItemCount > PAYLOAD_GUARD_ITEMS) {
      console.warn(
        `[${fmt.tag}] ⛔ Payload guard: blocking ${(diagnostics.payloadBytes / 1024).toFixed(0)}KB / ${inputItemCount} items ` +
        `full-history replay (resume=${implicitResume.evaluation.reason}). ` +
        `Client should compact the conversation.`,
      );
      releaseAccount(accountPool, entryId, undefined, released);
      return respondWithProxyError({
        c, req, fmt,
        status: 413,
        message:
          `Context too large for full-history replay ` +
          `(${(diagnostics.payloadBytes / 1024).toFixed(0)}KB, ${inputItemCount} items). ` +
          `Implicit resume failed: ${implicitResume.evaluation.reason}. ` +
          `Please compact or restart the conversation.`,
      });
    }
  }

  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  await staggerIfNeeded(acquired.prevSlotMs);

  const buildPoolCtx = (forEntryId: string = entryId) =>
    buildWsPoolContext({
      useWebSocket: req.codexRequest.useWebSocket,
      conversationId: sessionContext.chainConversationId,
      entryId: forEntryId,
      variantHash: sessionContext.variantHash,
      requestId,
      tag: fmt.tag,
      poolKeySuffix: recoveryWsKeySuffix,
    });

  for (;;) {
    try {
      const { rawResponse, upstreamTurnState } = await sendProxyUpstreamAttempt({
        accountPool,
        api: codexApi,
        request: req,
        entryId,
        account: accountDisplayName(entryId),
        abortSignal: abortController.signal,
        buildPoolCtx,
        requestId,
        tag: fmt.tag,
        conversationId: sessionContext.chainConversationId,
        implicitResumeActive: implicitResume.isActive(),
        resumeReason: implicitResume.resumeReasonForAttempt(),
      });

      // ── Streaming path ──
      if (req.isStreaming) {
        return handleStreaming({
          c,
          accountPool,
          req,
          fmt,
          api: codexApi,
          response: rawResponse,
          entryId,
          abortController,
          released,
          requestId,
          affinityMap,
          conversationId: sessionContext.chainConversationId,
          turnState: upstreamTurnState,
          usageHint: implicitResume.getUsageHint(),
          variantHash: sessionContext.variantHash,
          chainAdvanceTicket,
          implicitResumeActive: implicitResume.isActive(),
        });
      }

      // ── Non-streaming path (with empty-response retry) ──
      return await handleNonStreaming({
        c,
        accountPool,
        cookieJar,
        req,
        fmt,
        initialApi: codexApi,
        initialResponse: rawResponse,
        entryId,
        abortController,
        released,
        requestId,
        affinityMap,
        conversationId: sessionContext.chainConversationId,
        turnState: upstreamTurnState,
        getUsageHint: () => implicitResume.getUsageHint(),
        restoreImplicitResumeRequest: implicitResume.restore,
        buildPoolCtx,
        setActiveAccount: (nextEntryId, nextApi) => {
          entryId = nextEntryId;
          codexApi = nextApi;
        },
        variantHash: sessionContext.variantHash,
        chainAdvanceTicket,
      });
    } catch (err) {
      invalidateRejectedPreviousResponse({
        err,
        previousResponseId: req.codexRequest.previous_response_id,
        affinityMap,
        forgetResponseOwner: forgetWsResponseOwner,
      });
      if (containsInvalidEncryptedContentSignal(err)) {
        reasoningReplayCache.evictByIdentity({
          entryId,
          conversationId: sessionContext.chainConversationId,
          variantHash: sessionContext.variantHash,
        });
      }
      const retryAction = classifyRetryAction(
        err,
        {
          stripAndRetryDone,
          implicitResumeActive: implicitResume.isActive(),
          previousResponseId: req.codexRequest.previous_response_id,
          explicitPreviousResponseId: Boolean(sessionContext.explicitPrevRespId),
        },
        (e) => implicitResume.canReplayAfterError(e),
      );

      switch (retryAction.type) {
        case "not_codex_error":
          releaseAccount(accountPool, entryId, annotateImageGenOutcome(undefined, req.expectsImageGen), released);
          throw err;

        case "implicit_resume_replay": {
          if (!implicitResume.replayFullInputAfterError(err)) throw err;
          stripAndRetryDone = true;
          const staleId = sessionContext.implicitPrevRespId;
          const continuityReason = err instanceof PreviousResponseWebSocketError
            ? err.continuityReason
            : undefined;

          // A busy owner is a live sibling branch. Keep the parent head and
          // original ticket so only the first sibling completion advances it.
          // Missing/dead owners are stale: invalidate and rebuild from a root.
          if (staleId && continuityReason !== "busy") {
            affinityMap.forget(staleId);
            forgetWsResponseOwner(staleId);
            chainAdvanceTicket = affinityMap.captureChainAdvance(
              sessionContext.chainConversationId,
              sessionContext.variantHash,
              null,
            );
          }

          // A unique pooled key avoids the busy canonical connection while
          // establishing a new response owner.
          recoveryWsKeySuffix =
            `recovery-${requestId.slice(0, 8)}-${++continuityRecoveryCount}`;
          continue;
        }

        case "strip_and_retry": {
          stripAndRetryDone = true;
          const decision = buildProxyRetryRecoveryDecision({
            err, tag: fmt.tag, entryId, stripAndRetryDone: false,
            previousResponseId: req.codexRequest.previous_response_id,
          });
          applyProxyRetryRecoveryDecision({
            decision,
            request: req,
            affinityMap,
            restoreImplicitResumeRequest: implicitResume.restore,
          });
          if (decision.action === "retry" && decision.staleId) {
            forgetWsResponseOwner(decision.staleId);
            chainAdvanceTicket = affinityMap.captureChainAdvance(
              sessionContext.chainConversationId,
              sessionContext.variantHash,
              null,
            );
            recoveryWsKeySuffix =
              `recovery-${requestId.slice(0, 8)}-${++continuityRecoveryCount}`;
          }
          continue;
        }

        case "error_handler_decides": {
          const decision = handleCodexApiError(
            err as CodexApiError, accountPool, entryId, req.codexRequest.model, fmt.tag, cookieJar,
          );
          releaseAccount(
            accountPool,
            entryId,
            annotateImageGenOutcome(undefined, req.expectsImageGen),
            released,
          );
          return respondWithProxyError({
            c, req, fmt,
            status: decision.status,
            message: decision.message,
            ...(decision.useFormat429 ? { useFormat429: true } : {}),
          });
        }
      }
    }
  }
}
