import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Account, AccountQuotaWindow } from "../../../shared/types";
import type { ServerRuntime } from "../../../shared/hooks/use-status";
import { useUsageSummary } from "../../../shared/hooks/use-usage-stats";
import { useResetCredits } from "../../../shared/hooks/use-reset-credits";
import { useT } from "../../../shared/i18n/context";

interface OverviewPageProps {
  account: Account | null;
  authFile: string;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastUpdated: Date | null;
  onReload: () => Promise<boolean>;
  onRefreshHealth: () => Promise<void>;
  runtime: ServerRuntime | null;
  codexCliVersion: string | null;
}

interface CardProps {
  title: string;
  description: string;
  icon: "account" | "quota" | "host";
  class?: string;
  children: ComponentChildren;
}

const cardClass = "rounded-2xl border border-slate-200/80 bg-white shadow-sm dark:border-border-dark dark:bg-card-dark";

function OverviewIcon({ name }: { name: CardProps["icon"] }) {
  const paths = {
    account: <><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/></>,
    quota: <><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19H2"/></>,
    host: <><rect width="18" height="12" x="3" y="4" rx="2"/><path d="M7 8h.01M7 12h.01M11 8h6M11 12h6M8 20h8M12 16v4"/></>,
  };
  return (
    <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-container text-primary dark:bg-primary-container/70">
      <svg viewBox="0 0 24 24" class="size-[18px]" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {paths[name]}
      </svg>
    </span>
  );
}

function Card({ title, description, icon, class: className = "", children }: CardProps) {
  return (
    <section class={`${cardClass} ${className}`}>
      <div class="flex items-start gap-3 border-b border-slate-100 px-5 py-4 dark:border-border-dark md:px-6">
        <OverviewIcon name={icon} />
        <div class="min-w-0">
          <h2 class="text-sm font-bold text-slate-900 dark:text-text-main">{title}</h2>
          <p class="mt-0.5 text-xs leading-5 text-slate-500 dark:text-text-dim">{description}</p>
        </div>
      </div>
      <div class="p-5 md:p-6">{children}</div>
    </section>
  );
}

function Detail({ label, value, mono = false, hint }: { label: string; value: string; mono?: boolean; hint?: string }) {
  return (
    <div class="min-w-0 rounded-xl bg-slate-50 px-3.5 py-3 dark:bg-bg-dark/70">
      <dt class="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:text-text-dim">{label}</dt>
      <dd class={`mt-1.5 break-words text-sm font-semibold text-slate-800 dark:text-text-main ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
      {hint && <p class="mt-1 text-[11px] leading-4 text-slate-400 dark:text-text-dim">{hint}</p>}
    </div>
  );
}

export function quotaRemaining(window?: AccountQuotaWindow | null): number | null {
  if (!window) return null;
  const value = window.remaining_percent ?? (window.used_percent == null ? null : 100 - window.used_percent);
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function toneForPercentage(value: number | null, remaining: boolean): string {
  if (value == null) return "bg-slate-300 dark:bg-slate-600";
  const severity = remaining ? 100 - value : value;
  if (severity >= 80) return "bg-red-500";
  if (severity >= 50) return "bg-amber-500";
  return "bg-emerald-500";
}

function formatTimestamp(value?: string | number | null): string {
  if (value == null) return "—";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}

function formatBytes(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function QuotaMeter({ label, window }: { label: string; window?: AccountQuotaWindow | null }) {
  const t = useT();
  const remaining = quotaRemaining(window);
  return (
    <div class="rounded-xl border border-slate-200/80 p-4 dark:border-border-dark">
      <div class="flex items-baseline justify-between gap-4">
        <span class="text-xs font-semibold text-slate-600 dark:text-text-dim">{label}</span>
        <span class="text-xl font-bold tabular-nums text-slate-900 dark:text-text-main">{remaining == null ? "—" : `${Math.round(remaining)}%`}</span>
      </div>
      <div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-bg-dark" role="progressbar" aria-label={label} aria-valuenow={remaining ?? 0} aria-valuemin="0" aria-valuemax="100">
        <div class={`h-full rounded-full transition-[width] ${toneForPercentage(remaining, true)}`} style={{ width: `${remaining ?? 0}%` }} />
      </div>
      <p class="mt-2 truncate text-[11px] text-slate-400 dark:text-text-dim">
        {window?.reset_at ? `${t("resetsAt")}: ${formatTimestamp(window.reset_at)}` : t("quotaUnavailable")}
      </p>
    </div>
  );
}

function ResourceMeter({ label, value, detail }: { label: string; value: number | null; detail: string }) {
  const normalized = value == null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, value));
  return (
    <div class="rounded-xl border border-slate-200/80 p-4 dark:border-border-dark">
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-xs font-semibold text-slate-600 dark:text-text-dim">{label}</span>
        <span class="text-base font-bold tabular-nums text-slate-900 dark:text-text-main">{normalized == null ? "—" : `${normalized.toFixed(1)}%`}</span>
      </div>
      <div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-bg-dark" role="progressbar" aria-label={label} aria-valuenow={normalized ?? 0} aria-valuemin="0" aria-valuemax="100">
        <div class={`h-full rounded-full transition-[width] ${toneForPercentage(normalized, false)}`} style={{ width: `${normalized ?? 0}%` }} />
      </div>
      <p class="mt-2 text-[11px] text-slate-400 dark:text-text-dim">{detail}</p>
    </div>
  );
}

function getExpiryCopy(expiresAt: string | null | undefined, t: ReturnType<typeof useT>): { value: string; hint: string } {
  if (!expiresAt) return { value: "—", hint: t("credentialExpiryHint") };
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime())) return { value: "—", hint: t("credentialExpiryHint") };
  const diffDays = Math.ceil((expires.getTime() - Date.now()) / 86_400_000);
  let hint: string;
  if (diffDays > 0) hint = t("daysRemaining", { count: diffDays });
  else if (diffDays === 0) hint = t("expiresToday");
  else hint = t("expiredDaysAgo", { count: Math.abs(diffDays) });
  return { value: expires.toLocaleString(), hint: `${hint} · ${t("credentialExpiryHint")}` };
}

function statusLabel(status: string, t: ReturnType<typeof useT>): string {
  const labels: Record<string, string> = {
    active: t("active"),
    expired: t("expired"),
    quota_exhausted: t("quotaExhausted"),
    refreshing: t("refreshing"),
    disabled: t("disabled"),
    banned: t("banned"),
  };
  return labels[status] ?? status;
}

export function OverviewPage(props: OverviewPageProps) {
  const t = useT();
  const usage = useUsageSummary();
  const resetCredits = useResetCredits();
  const [refreshingAll, setRefreshingAll] = useState(false);
  const account = props.account;
  const runtime = props.runtime;
  const expiry = getExpiryCopy(account?.expiresAt, t);
  const availableResetCredits = resetCredits.snapshot?.available_count ?? account?.quota?.reset_credits_available ?? null;
  const totalTokens = usage.summary
    ? usage.summary.total_input_tokens + usage.summary.total_output_tokens + usage.summary.total_image_input_tokens + usage.summary.total_image_output_tokens
    : null;
  const memoryUsed = runtime ? runtime.memory_total_bytes - runtime.memory_free_bytes : null;
  const diskUsed = runtime?.disk_total_bytes != null && runtime.disk_free_bytes != null
    ? runtime.disk_total_bytes - runtime.disk_free_bytes
    : null;
  const memoryPercent = runtime?.memory_usage_percent ?? (runtime && runtime.memory_total_bytes > 0 ? (memoryUsed! / runtime.memory_total_bytes) * 100 : null);
  const diskPercent = runtime?.disk_usage_percent ?? (runtime?.disk_total_bytes && diskUsed != null ? (diskUsed / runtime.disk_total_bytes) * 100 : null);

  const refreshAll = async () => {
    setRefreshingAll(true);
    await Promise.all([
      props.onReload(),
      props.onRefreshHealth(),
      usage.reload(),
      resetCredits.reload(),
    ]);
    setRefreshingAll(false);
  };

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-slate-950 dark:text-text-main">{t("overview")}</h1>
          <p class="mt-1 text-sm text-slate-500 dark:text-text-dim">{t("overviewSubtitle")}</p>
        </div>
        <div class="flex items-center gap-3">
          {props.lastUpdated && <span class="text-[11px] text-slate-400 dark:text-text-dim">{t("lastUpdated")}: {props.lastUpdated.toLocaleTimeString()}</span>}
          <button type="button" disabled={refreshingAll || props.refreshing} onClick={() => { void refreshAll(); }} class="inline-flex h-9 items-center gap-2 rounded-lg bg-primary-action px-3.5 text-xs font-semibold text-white transition-colors hover:bg-primary-action-hover disabled:cursor-not-allowed disabled:opacity-60">
            <svg viewBox="0 0 24 24" class={`size-4 ${(refreshingAll || props.refreshing) ? "animate-spin" : ""}`} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>
            {(refreshingAll || props.refreshing) ? t("reloadingAuth") : t("refreshOverview")}
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <Card title={t("accountInformation")} description={t("codexCliAccountDesc")} icon="account" class="xl:col-span-5">
          {props.loading ? (
            <div class="space-y-3 animate-pulse"><div class="h-16 rounded-xl bg-slate-100 dark:bg-bg-dark"/><div class="grid grid-cols-2 gap-3"><div class="h-20 rounded-xl bg-slate-100 dark:bg-bg-dark"/><div class="h-20 rounded-xl bg-slate-100 dark:bg-bg-dark"/></div></div>
          ) : !account ? (
            <div class="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-warning-container dark:text-warning">
              <p class="font-semibold">{t("noCliAccount")}</p>
              <p class="mt-1 text-xs leading-5">{t("runCodexLogin")}</p>
              {props.error && <p class="mt-2 break-all font-mono text-[11px]">{props.error}</p>}
            </div>
          ) : (
            <>
              <div class="mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                <div class="min-w-0">
                  <p class="truncate text-sm font-bold text-slate-900 dark:text-text-main">{account.email ?? account.accountId ?? "—"}</p>
                  <p class="mt-0.5 text-xs text-slate-500 dark:text-text-dim">{account.planType ?? account.quota?.plan_type ?? "—"}</p>
                </div>
                <span class={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${account.status === "active" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300"}`}>{statusLabel(account.status, t)}</span>
              </div>
              <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Detail label={t("accountName")} value={account.email ?? "—"} />
                <Detail label={t("plan")} value={account.planType ?? account.quota?.plan_type ?? "—"} />
                <Detail label={t("codexCliVersion")} value={props.codexCliVersion ?? "—"} mono />
                <Detail label={t("authenticationExpiry")} value={expiry.value} hint={expiry.hint} />
                <div class="sm:col-span-2"><Detail label={t("authFile")} value={props.authFile || "~/.codex/auth.json"} mono /></div>
              </dl>
            </>
          )}
        </Card>

        <Card title={t("quotaOverview")} description={t("quotaDescription")} icon="quota" class="xl:col-span-7">
          <div class="grid gap-3 sm:grid-cols-3">
            <QuotaMeter label={t("fiveHourLimit")} window={account?.quota?.rate_limit} />
            <QuotaMeter label={t("weeklyLimit")} window={account?.quota?.secondary_rate_limit} />
            <div class="rounded-xl border border-slate-200/80 p-4 dark:border-border-dark">
              <span class="text-xs font-semibold text-slate-600 dark:text-text-dim">{t("resetCredits")}</span>
              <div class="mt-1.5 text-xl font-bold tabular-nums text-slate-900 dark:text-text-main">{availableResetCredits == null ? "—" : availableResetCredits}</div>
              <p class="mt-4 truncate text-[11px] text-slate-400 dark:text-text-dim">{t("resetCardExpiry")}: {formatTimestamp(resetCredits.snapshot?.next_expires_at)}</p>
            </div>
          </div>

          <div class="mt-5 border-t border-slate-100 pt-5 dark:border-border-dark">
            <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 class="text-xs font-bold text-slate-800 dark:text-text-main">{t("currentPlanUsage")}</h3>
                <p class="mt-0.5 text-[11px] text-slate-400 dark:text-text-dim">{t("localTrackingDisclaimer")}</p>
              </div>
              {usage.summary?.tracking_started_at && <span class="text-[11px] text-slate-400 dark:text-text-dim">{t("usageTrackedSince")}: {formatTimestamp(usage.summary.tracking_started_at)}</span>}
            </div>
            <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Detail label={t("totalRequests")} value={usage.loading ? "…" : new Intl.NumberFormat().format(usage.summary?.total_request_count ?? 0)} />
              <Detail label={t("tokensUsed")} value={usage.loading ? "…" : new Intl.NumberFormat().format(totalTokens ?? 0)} />
              <Detail label={t("estimatedApiCost")} value={usage.loading ? "…" : `$${(usage.summary?.total_estimated_cost_usd ?? 0).toFixed(2)}`} hint={t("estimatedApiCostHint")} />
            </dl>
          </div>
        </Card>

        <Card title={t("hostPerformance")} description={t("hostDescription")} icon="host" class="xl:col-span-12">
          <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label={t("publicIp")} value={runtime?.public_ip ?? runtime?.server_ip ?? "—"} mono hint={!runtime?.public_ip && runtime?.server_ip ? t("lanIpFallback") : undefined} />
            <Detail label={t("operatingSystem")} value={[runtime?.os_type ?? runtime?.platform, runtime?.os_version, runtime?.arch].filter(Boolean).join(" · ") || "—"} />
            <Detail label={t("nodeVersion")} value={runtime?.node_version ?? "—"} mono />
            <Detail label={t("serverName")} value={runtime?.server_name ?? "—"} />
          </dl>
          <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <ResourceMeter label={t("cpuUsage")} value={runtime?.cpu_usage_percent ?? null} detail={runtime ? `${runtime.cpu_count} CPU · load ${runtime.load_average[0]?.toFixed(2) ?? "—"}` : "—"} />
            <ResourceMeter label={t("memoryUsage")} value={memoryPercent} detail={runtime ? `${formatBytes(memoryUsed)} / ${formatBytes(runtime.memory_total_bytes)}` : "—"} />
            <ResourceMeter label={t("storageUsage")} value={diskPercent} detail={runtime ? `${formatBytes(diskUsed)} / ${formatBytes(runtime.disk_total_bytes)}` : "—"} />
          </div>
        </Card>
      </div>
    </div>
  );
}
