import { useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Account, AccountQuotaWindow } from "../../../shared/types";
import type { ServerRuntime } from "../../../shared/hooks/use-status";
import {
  useUsageHistory,
  useUsageSummary,
  type UsageDataPoint,
} from "../../../shared/hooks/use-usage-stats";
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

interface PanelProps {
  title: string;
  description: string;
  children: ComponentChildren;
  class?: string;
}

const panelClass =
  "rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-border-dark dark:bg-card-dark";

function Panel({
  title,
  description,
  children,
  class: className = "",
}: PanelProps) {
  return (
    <section class={`${panelClass} ${className}`}>
      <div class="border-b border-slate-100 px-5 py-4 dark:border-border-dark md:px-6">
        <h2 class="text-sm font-bold text-slate-900 dark:text-text-main">
          {title}
        </h2>
        <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-text-dim">
          {description}
        </p>
      </div>
      <div class="p-5 md:p-6">{children}</div>
    </section>
  );
}

function formatTimestamp(value?: string | number | null): string {
  if (value == null) return "—";
  const date =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
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

export function quotaRemaining(
  window?: AccountQuotaWindow | null,
): number | null {
  if (!window) return null;
  const value =
    window.remaining_percent ??
    (window.used_percent == null ? null : 100 - window.used_percent);
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

const FIVE_HOUR_WINDOW_MAX_SECONDS = 6 * 60 * 60;
const WEEKLY_WINDOW_MIN_SECONDS = 24 * 60 * 60;

function hasWindowDuration(window?: AccountQuotaWindow | null): boolean {
  return (
    typeof window?.limit_window_seconds === "number" &&
    window.limit_window_seconds > 0
  );
}

function isWeeklyWindow(window?: AccountQuotaWindow | null): boolean {
  return (
    hasWindowDuration(window) &&
    window!.limit_window_seconds! >= WEEKLY_WINDOW_MIN_SECONDS
  );
}

function isFiveHourWindow(window?: AccountQuotaWindow | null): boolean {
  return (
    hasWindowDuration(window) &&
    window!.limit_window_seconds! <= FIVE_HOUR_WINDOW_MAX_SECONDS
  );
}

/** Classify quota windows by duration because upstream field order is not stable. */
export function resolveQuotaWindows(quota?: Account["quota"] | null): {
  fiveHour: AccountQuotaWindow | null;
  weekly: AccountQuotaWindow | null;
} {
  const primary = quota?.rate_limit ?? null;
  const secondary = quota?.secondary_rate_limit ?? null;
  const primaryIsWeekly = isWeeklyWindow(primary);
  const primaryIsFiveHour =
    isFiveHourWindow(primary) || !hasWindowDuration(primary);
  const secondaryIsWeekly = isWeeklyWindow(secondary);
  const secondaryIsFiveHour = isFiveHourWindow(secondary);

  return {
    fiveHour: primaryIsWeekly
      ? secondaryIsFiveHour
        ? secondary
        : null
      : primaryIsFiveHour
        ? primary
        : null,
    weekly: primaryIsWeekly ? primary : secondaryIsWeekly ? secondary : null,
  };
}

function toneForPercentage(value: number | null, remaining: boolean): string {
  if (value == null) return "bg-slate-300 dark:bg-slate-600";
  const severity = remaining ? 100 - value : value;
  if (severity >= 80) return "bg-red-500";
  if (severity >= 50) return "bg-amber-500";
  return "bg-emerald-500";
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

function getExpiryCopy(
  expiresAt: string | null | undefined,
  t: ReturnType<typeof useT>,
): { value: string; hint: string; days: number | null } {
  if (!expiresAt)
    return { value: "—", hint: t("credentialExpiryHint"), days: null };
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime()))
    return { value: "—", hint: t("credentialExpiryHint"), days: null };
  const days = Math.ceil((expires.getTime() - Date.now()) / 86_400_000);
  const hint =
    days > 0
      ? t("daysRemaining", { count: days })
      : days === 0
        ? t("expiresToday")
        : t("expiredDaysAgo", { count: Math.abs(days) });
  return {
    value: expires.toLocaleString(),
    hint: `${hint} · ${t("credentialExpiryHint")}`,
    days,
  };
}

function Detail({
  label,
  value,
  mono = false,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div class="min-w-0 rounded-lg bg-slate-50 px-3.5 py-3 dark:bg-bg-dark/70">
      <dt class="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:text-text-dim">
        {label}
      </dt>
      <dd
        class={`mt-1.5 break-words text-sm font-semibold text-slate-800 dark:text-text-main ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
      {hint && (
        <p class="mt-1 text-[11px] leading-4 text-slate-400 dark:text-text-dim">
          {hint}
        </p>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  tone = "neutral",
  progress,
  trend,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "neutral" | "success" | "warning" | "info";
  progress?: number | null;
  trend?: string;
}) {
  const valueTone =
    tone === "success"
      ? "text-emerald-500"
      : tone === "warning"
        ? "text-amber-400"
        : tone === "info"
          ? "text-sky-400"
          : "text-slate-900 dark:text-text-main";
  const barTone =
    tone === "warning"
      ? "bg-amber-400"
      : tone === "info"
        ? "bg-sky-400"
        : "bg-primary";
  return (
    <section class="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-border-dark dark:bg-card-dark">
      <div class="flex items-center justify-between gap-3">
        <span class="text-xs font-semibold text-slate-500 dark:text-text-dim">
          {label}
        </span>
        {trend && (
          <span class={`text-[11px] font-semibold ${valueTone}`}>{trend}</span>
        )}
      </div>
      <div class={`mt-3 text-2xl font-bold tabular-nums ${valueTone}`}>
        {value}
      </div>
      {progress != null && (
        <div
          class="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-bg-dark"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            class={`h-full rounded-full ${barTone}`}
            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          />
        </div>
      )}
      <p class="mt-2 truncate text-[11px] text-slate-400 dark:text-text-dim">
        {hint}
      </p>
    </section>
  );
}

function ResourceMeter({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | null;
  detail: string;
}) {
  const normalized =
    value == null || !Number.isFinite(value)
      ? null
      : Math.max(0, Math.min(100, value));
  return (
    <div>
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-xs font-semibold text-slate-600 dark:text-text-dim">
          {label}
        </span>
        <span class="text-sm font-bold tabular-nums text-slate-900 dark:text-text-main">
          {normalized == null ? "—" : `${normalized.toFixed(1)}%`}
        </span>
      </div>
      <div
        class="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-bg-dark"
        role="progressbar"
        aria-label={label}
        aria-valuenow={normalized ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          class={`h-full rounded-full ${toneForPercentage(normalized, false)}`}
          style={{ width: `${normalized ?? 0}%` }}
        />
      </div>
      <p class="mt-1.5 text-[11px] text-slate-400 dark:text-text-dim">
        {detail}
      </p>
    </div>
  );
}

function MiniUsageChart({
  data,
  loading,
}: {
  data: UsageDataPoint[];
  loading: boolean;
}) {
  const t = useT();
  const points = useMemo(() => {
    if (data.length === 0) return null;
    const width = 520;
    const height = 150;
    const inset = 8;
    const max = Math.max(...data.map((item) => item.request_count), 1);
    const toX = (index: number) =>
      inset + (index / Math.max(data.length - 1, 1)) * (width - inset * 2);
    const toY = (value: number) =>
      height - inset - (value / max) * (height - inset * 2);
    const path = data
      .map(
        (item, index) =>
          `${index === 0 ? "M" : "L"} ${toX(index).toFixed(1)} ${toY(item.request_count).toFixed(1)}`,
      )
      .join(" ");
    return { width, height, path, max };
  }, [data]);

  if (loading)
    return (
      <div class="flex h-[150px] items-center justify-center text-xs text-slate-400 dark:text-text-dim">
        {t("overviewUsageLoading")}
      </div>
    );
  if (!points)
    return (
      <div class="flex h-[150px] items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-400 dark:border-border-dark dark:text-text-dim">
        {t("overviewUsageEmpty")}
      </div>
    );
  return (
    <div>
      <div class="mb-2 flex items-center justify-between text-[11px] text-slate-400 dark:text-text-dim">
        <span>{t("overviewUsageRequestsPerHour")}</span>
        <span>
          {t("overviewUsageMax", {
            count: new Intl.NumberFormat().format(points.max),
          })}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${points.width} ${points.height}`}
        class="h-[150px] w-full"
        role="img"
        aria-label={t("overviewUsageChartLabel")}
      >
        <defs>
          <linearGradient id="overview-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="var(--chart-blue)" />
            <stop offset="1" stop-color="transparent" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1="8"
            x2={points.width - 8}
            y1={points.height * fraction}
            y2={points.height * fraction}
            stroke="currentColor"
            class="text-slate-200 dark:text-border-dark"
            stroke-width="1"
          />
        ))}
        <path
          d={points.path}
          fill="none"
          stroke="var(--chart-blue)"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d={`${points.path} L ${points.width - 8} ${points.height - 8} L 8 ${points.height - 8} Z`}
          fill="url(#overview-chart-fill)"
          opacity=".22"
        />
      </svg>
      <div class="mt-1 flex justify-between text-[10px] text-slate-400 dark:text-text-dim">
        <span>
          {data[0]
            ? new Date(data[0].timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
            : ""}
        </span>
        <span>{t("overviewHours24")}</span>
        <span>{t("overviewNow")}</span>
      </div>
    </div>
  );
}

function AttentionPanel({
  weeklyRemaining,
  expiry,
  memoryPercent,
  diskPercent,
  cpuPercent,
  t,
}: {
  weeklyRemaining: number | null;
  expiry: ReturnType<typeof getExpiryCopy>;
  memoryPercent: number | null;
  diskPercent: number | null;
  cpuPercent: number | null;
  t: ReturnType<typeof useT>;
}) {
  const items: Array<{
    tone: "warning" | "info";
    title: string;
    detail: string;
  }> = [];
  if (weeklyRemaining != null && weeklyRemaining <= 65)
    items.push({
      tone: "warning",
      title: t("overviewWeeklyAttention", {
        percent: Math.round(weeklyRemaining),
      }),
      detail: t("overviewWeeklyAttentionHint"),
    });
  if (expiry.days != null && expiry.days <= 30)
    items.push({
      tone: "info",
      title:
        expiry.days < 0
          ? t("overviewCredentialExpired")
          : t("overviewCredentialAttention", { days: expiry.days }),
      detail: t("overviewCredentialAttentionHint"),
    });
  if (
    (cpuPercent ?? 0) >= 80 ||
    (memoryPercent ?? 0) >= 85 ||
    (diskPercent ?? 0) >= 85
  )
    items.push({
      tone: "warning",
      title: t("overviewHostAttention"),
      detail: t("overviewHostAttentionHint"),
    });
  return (
    <Panel
      title={t("overviewAttentionTitle")}
      description={t("overviewAttentionDescription")}
      class="h-full xl:col-span-5"
    >
      {items.length === 0 ? (
        <div class="flex min-h-[164px] flex-col items-center justify-center rounded-lg border border-dashed border-emerald-200 bg-emerald-50/60 p-5 text-center dark:border-emerald-900/70 dark:bg-emerald-950/20">
          <span class="flex size-9 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
            ✓
          </span>
          <p class="mt-3 text-sm font-semibold text-slate-800 dark:text-text-main">
            {t("overviewAllHealthy")}
          </p>
          <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">
            {t("overviewAllHealthyHint")}
          </p>
        </div>
      ) : (
        <div class="space-y-3">
          {items.map((item) => (
            <div
              key={item.title}
              class={`rounded-lg border p-3 ${item.tone === "warning" ? "border-amber-300/70 bg-amber-50 dark:border-amber-900/70 dark:bg-amber-950/20" : "border-sky-300/70 bg-sky-50 dark:border-sky-900/70 dark:bg-sky-950/20"}`}
            >
              <div class="flex items-start gap-2">
                <span
                  class={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${item.tone === "warning" ? "bg-amber-500 text-white" : "bg-sky-500 text-white"}`}
                >
                  {item.tone === "warning" ? "!" : "i"}
                </span>
                <div>
                  <p class="text-xs font-semibold text-slate-800 dark:text-text-main">
                    {item.title}
                  </p>
                  <p class="mt-1 text-[11px] leading-4 text-slate-500 dark:text-text-dim">
                    {item.detail}
                  </p>
                </div>
              </div>
            </div>
          ))}
          <a
            href="#/logs"
            class="inline-flex pt-1 text-xs font-semibold text-primary hover:underline"
          >
            {t("overviewViewEvents")} ›
          </a>
        </div>
      )}
    </Panel>
  );
}

export function OverviewPage(props: OverviewPageProps) {
  const t = useT();
  const quotaWindows = resolveQuotaWindows(props.account?.quota);
  const usage = useUsageSummary();
  const usageHistory = useUsageHistory("hourly", 24);
  const resetCredits = useResetCredits();
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const account = props.account;
  const runtime = props.runtime;
  const expiry = getExpiryCopy(account?.expiresAt, t);
  const fiveHourRemaining = quotaRemaining(quotaWindows.fiveHour);
  const weeklyRemaining = quotaRemaining(quotaWindows.weekly);
  const primaryQuotaRemaining = fiveHourRemaining ?? weeklyRemaining;
  const primaryQuotaLabel = quotaWindows.fiveHour
    ? t("fiveHourLimit")
    : quotaWindows.weekly
      ? t("weeklyLimit")
      : t("quotaOverview");
  const availableResetCredits =
    resetCredits.snapshot?.available_count ??
    account?.quota?.reset_credits_available ??
    null;
  const totalTokens = usage.summary
    ? usage.summary.total_input_tokens +
      usage.summary.total_output_tokens +
      usage.summary.total_image_input_tokens +
      usage.summary.total_image_output_tokens
    : null;
  const memoryUsed = runtime
    ? runtime.memory_total_bytes - runtime.memory_free_bytes
    : null;
  const diskUsed =
    runtime?.disk_total_bytes != null && runtime.disk_free_bytes != null
      ? runtime.disk_total_bytes - runtime.disk_free_bytes
      : null;
  const memoryPercent =
    runtime?.memory_usage_percent ??
    (runtime && runtime.memory_total_bytes > 0
      ? (memoryUsed! / runtime.memory_total_bytes) * 100
      : null);
  const diskPercent =
    runtime?.disk_usage_percent ??
    (runtime?.disk_total_bytes && diskUsed != null
      ? (diskUsed / runtime.disk_total_bytes) * 100
      : null);
  const cpuPercent = runtime?.cpu_usage_percent ?? null;
  const hostHealthy =
    (cpuPercent == null || cpuPercent < 80) &&
    (memoryPercent == null || memoryPercent < 85) &&
    (diskPercent == null || diskPercent < 85);
  const accountHealthy = account?.status === "active";

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      await Promise.all([
        props.onReload(),
        props.onRefreshHealth(),
        usage.reload(),
        usageHistory.reload(),
        resetCredits.reload(),
      ]);
    } finally {
      setRefreshingAll(false);
    }
  };

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-slate-950 dark:text-text-main">
            {t("overview")}
          </h1>
          <p class="mt-1 text-sm text-slate-500 dark:text-text-dim">
            {t("overviewSubtitle")}
          </p>
        </div>
        <div class="flex items-center gap-3">
          <span
            class={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${accountHealthy && hostHealthy ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"}`}
          >
            <span
              class={`size-1.5 rounded-full ${accountHealthy && hostHealthy ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            {accountHealthy && hostHealthy
              ? t("overviewServiceHealthy")
              : t("overviewServiceAttention")}
          </span>
          {props.lastUpdated && (
            <span class="hidden text-[11px] text-slate-400 dark:text-text-dim sm:inline">
              {t("lastUpdated")}: {props.lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            disabled={refreshingAll || props.refreshing}
            onClick={() => {
              void refreshAll();
            }}
            class="inline-flex h-9 items-center gap-2 rounded-lg bg-primary-action px-3.5 text-xs font-semibold text-white transition-colors hover:bg-primary-action-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg
              viewBox="0 0 24 24"
              class={`size-4 ${refreshingAll || props.refreshing ? "animate-spin" : ""}`}
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
            </svg>
            {refreshingAll || props.refreshing
              ? t("reloadingAuth")
              : t("refreshOverview")}
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={quotaWindows.fiveHour ? t("fiveHourLimit") : t("resetCredits")}
          value={
            quotaWindows.fiveHour
              ? fiveHourRemaining == null
                ? "—"
                : `${Math.round(fiveHourRemaining)}%`
              : availableResetCredits == null
                ? "—"
                : String(availableResetCredits)
          }
          tone={
            fiveHourRemaining != null && fiveHourRemaining < 50
              ? "warning"
              : "success"
          }
          progress={quotaWindows.fiveHour ? fiveHourRemaining : null}
          hint={
            quotaWindows.fiveHour?.reset_at
              ? `${t("resetsAt")}: ${formatTimestamp(quotaWindows.fiveHour.reset_at)}`
              : quotaWindows.fiveHour
                ? t("quotaUnavailable")
                : `${t("resetCardExpiry")}: ${formatTimestamp(resetCredits.snapshot?.next_expires_at)}`
          }
        />
        <KpiCard
          label={t("weeklyLimit")}
          value={
            weeklyRemaining == null ? "—" : `${Math.round(weeklyRemaining)}%`
          }
          tone={
            weeklyRemaining != null && weeklyRemaining <= 65
              ? "warning"
              : "success"
          }
          progress={weeklyRemaining}
          hint={
            quotaWindows.weekly?.reset_at
              ? `${t("resetsAt")}: ${formatTimestamp(quotaWindows.weekly.reset_at)}`
              : t("quotaUnavailable")
          }
        />
        <KpiCard
          label={t("overviewRecentRequests")}
          value={
            usageHistory.loading
              ? "…"
              : new Intl.NumberFormat().format(
                  usageHistory.dataPoints.reduce(
                    (sum, point) => sum + point.request_count,
                    0,
                  ),
                )
          }
          tone="info"
          trend={
            usageHistory.dataPoints.length > 1
              ? t("overviewLast24Hours")
              : undefined
          }
          hint={t("overviewRecentRequestsHint")}
        />
        <KpiCard
          label={t("overviewHostHealth")}
          value={
            accountHealthy && hostHealthy
              ? t("overviewHealthy")
              : t("overviewAttention")
          }
          tone={accountHealthy && hostHealthy ? "success" : "warning"}
          hint={
            runtime
              ? `${t("cpuUsage")} ${cpuPercent == null ? "—" : `${Math.round(cpuPercent)}%`} · ${t("memoryUsage")} ${memoryPercent == null ? "—" : `${Math.round(memoryPercent)}%`}`
              : t("overviewHostUnavailable")
          }
        />
      </div>

      <div class="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <Panel
          title={t("overviewAccountQuotaTitle")}
          description={t("overviewAccountQuotaDescription")}
          class="xl:col-span-7"
        >
          {props.loading ? (
            <div class="space-y-3 animate-pulse">
              <div class="h-16 rounded-lg bg-slate-100 dark:bg-bg-dark" />
              <div class="grid grid-cols-3 gap-3">
                <div class="h-20 rounded-lg bg-slate-100 dark:bg-bg-dark" />
                <div class="h-20 rounded-lg bg-slate-100 dark:bg-bg-dark" />
                <div class="h-20 rounded-lg bg-slate-100 dark:bg-bg-dark" />
              </div>
            </div>
          ) : !account ? (
            <div class="rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-warning-container dark:text-warning">
              <p class="font-semibold">{t("noCliAccount")}</p>
              <p class="mt-1 text-xs leading-5">{t("runCodexLogin")}</p>
              {props.error && (
                <p class="mt-2 break-all font-mono text-[11px]">
                  {props.error}
                </p>
              )}
            </div>
          ) : (
            <>
              <div class="flex items-center justify-between gap-3 rounded-lg border border-emerald-100 bg-emerald-50/70 px-4 py-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                <div class="flex min-w-0 items-center gap-3">
                  <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white">
                    {(account.email ?? account.accountId ?? "?")
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                  <div class="min-w-0">
                    <p class="truncate text-sm font-bold text-slate-900 dark:text-text-main">
                      {account.email ?? account.accountId ?? "—"}
                    </p>
                    <p class="mt-0.5 text-xs text-slate-500 dark:text-text-dim">
                      {account.planType ?? account.quota?.plan_type ?? "—"} ·{" "}
                      {props.codexCliVersion ?? "—"}
                    </p>
                  </div>
                </div>
                <span
                  class={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${account.status === "active" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300"}`}
                >
                  {statusLabel(account.status, t)}
                </span>
              </div>
              <dl class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Detail
                  label={t("authenticationExpiry")}
                  value={
                    expiry.days == null
                      ? "—"
                      : expiry.days < 0
                        ? t("expired")
                        : t("daysRemaining", { count: expiry.days })
                  }
                  hint={expiry.hint}
                />
                <Detail
                  label={t("resetCredits")}
                  value={
                    availableResetCredits == null
                      ? "—"
                      : String(availableResetCredits)
                  }
                  hint={`${t("resetCardExpiry")}: ${formatTimestamp(resetCredits.snapshot?.next_expires_at)}`}
                />
                <Detail
                  label={t("usageTrackedSince")}
                  value={
                    usage.summary?.tracking_started_at
                      ? formatTimestamp(usage.summary.tracking_started_at)
                      : "—"
                  }
                />
              </dl>
              <div class="mt-5 border-t border-slate-100 pt-5 dark:border-border-dark">
                <div class="mb-3 flex items-end justify-between gap-2">
                  <div>
                    <h3 class="text-xs font-bold text-slate-800 dark:text-text-main">
                      {t("overviewQuotaTrend")}
                    </h3>
                    <p class="mt-1 text-[11px] text-slate-400 dark:text-text-dim">
                      {t("localTrackingDisclaimer")}
                    </p>
                  </div>
                  <span class="text-[11px] text-slate-400 dark:text-text-dim">
                    {primaryQuotaRemaining == null
                      ? "—"
                      : `${Math.round(primaryQuotaRemaining)}%`}
                  </span>
                </div>
                <div class="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-bg-dark">
                  <div
                    class={`h-full rounded-full ${toneForPercentage(primaryQuotaRemaining, true)}`}
                    style={{ width: `${primaryQuotaRemaining ?? 0}%` }}
                  />
                </div>
                <div class="mt-2 flex justify-between text-[11px] text-slate-400 dark:text-text-dim">
                  <span>{primaryQuotaLabel}</span>
                  <span>
                    {(quotaWindows.fiveHour ?? quotaWindows.weekly)?.reset_at
                      ? `${t("resetsAt")}: ${formatTimestamp((quotaWindows.fiveHour ?? quotaWindows.weekly)?.reset_at)}`
                      : t("quotaUnavailable")}
                  </span>
                </div>
              </div>
            </>
          )}
        </Panel>

        <Panel
          title={t("overviewUsageTitle")}
          description={t("overviewUsageDescription")}
          class="xl:col-span-5"
        >
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-2">
            <Detail
              label={t("totalRequests")}
              value={
                usage.loading
                  ? "…"
                  : new Intl.NumberFormat().format(
                      usage.summary?.total_request_count ?? 0,
                    )
              }
            />
            <Detail
              label={t("tokensUsed")}
              value={
                usage.loading
                  ? "…"
                  : new Intl.NumberFormat().format(totalTokens ?? 0)
              }
            />
            <Detail
              label={t("estimatedApiCost")}
              value={
                usage.loading
                  ? "…"
                  : `$${(usage.summary?.total_estimated_cost_usd ?? 0).toFixed(2)}`
              }
              hint={t("estimatedApiCostHint")}
            />
            <Detail
              label={t("overviewActiveAccounts")}
              value={
                usage.loading
                  ? "…"
                  : `${usage.summary?.active_accounts ?? 0} / ${usage.summary?.total_accounts ?? 0}`
              }
            />
          </div>
          <div class="mt-5 border-t border-slate-100 pt-4 dark:border-border-dark">
            <MiniUsageChart
              data={usageHistory.dataPoints}
              loading={usageHistory.loading}
            />
          </div>
        </Panel>

        <Panel
          title={t("hostPerformance")}
          description={t("hostDescription")}
          class="xl:col-span-7"
        >
          <div class="space-y-5">
            <ResourceMeter
              label={t("cpuUsage")}
              value={cpuPercent}
              detail={
                runtime
                  ? `${runtime.cpu_count} CPU · load ${runtime.load_average[0]?.toFixed(2) ?? "—"}`
                  : "—"
              }
            />
            <ResourceMeter
              label={t("memoryUsage")}
              value={memoryPercent}
              detail={
                runtime
                  ? `${formatBytes(memoryUsed)} / ${formatBytes(runtime.memory_total_bytes)}`
                  : "—"
              }
            />
            <ResourceMeter
              label={t("storageUsage")}
              value={diskPercent}
              detail={
                runtime
                  ? `${formatBytes(diskUsed)} / ${formatBytes(runtime.disk_total_bytes)}`
                  : "—"
              }
            />
          </div>
          <div class="mt-5 border-t border-slate-100 pt-4 text-[11px] text-slate-400 dark:border-border-dark dark:text-text-dim">
            <span class="font-mono">
              {runtime?.public_ip ?? runtime?.server_ip ?? "—"}
            </span>{" "}
            · {runtime?.os_type ?? runtime?.platform ?? "—"}{" "}
            {runtime?.os_version ?? ""} ·{" "}
            <span class="font-mono">{runtime?.node_version ?? "—"}</span>
          </div>
        </Panel>

        <AttentionPanel
          weeklyRemaining={weeklyRemaining}
          expiry={expiry}
          memoryPercent={memoryPercent}
          diskPercent={diskPercent}
          cpuPercent={cpuPercent}
          t={t}
        />
      </div>

      <section class="rounded-xl border border-slate-200/80 bg-white dark:border-border-dark dark:bg-card-dark">
        <button
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
          class="flex w-full items-center gap-3 px-5 py-4 text-left md:px-6"
        >
          <svg
            class={`size-4 text-slate-400 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          <span class="text-sm font-bold text-slate-800 dark:text-text-main">
            {t("overviewConnectionDetails")}
          </span>
          <span class="text-xs text-slate-400 dark:text-text-dim">
            {t("overviewConnectionDetailsHint")}
          </span>
          <span class="ml-auto text-xs font-semibold text-primary">
            {detailsOpen ? t("collapse") : t("expandAll")} ›
          </span>
        </button>
        {detailsOpen && (
          <dl class="grid grid-cols-1 gap-3 border-t border-slate-100 p-5 dark:border-border-dark md:grid-cols-2 md:p-6">
            <Detail
              label={t("authFile")}
              value={props.authFile || "~/.codex/auth.json"}
              mono
            />
            <Detail
              label={t("serverName")}
              value={runtime?.server_name ?? "—"}
            />
            <Detail
              label={t("operatingSystem")}
              value={
                [
                  runtime?.os_type ?? runtime?.platform,
                  runtime?.os_version,
                  runtime?.arch,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"
              }
            />
            <Detail
              label={t("processCount")}
              value={
                runtime?.process_count == null
                  ? "—"
                  : String(runtime.process_count)
              }
            />
          </dl>
        )}
      </section>
    </div>
  );
}
