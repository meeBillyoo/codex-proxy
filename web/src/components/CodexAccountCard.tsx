import type { Account, AccountQuotaWindow } from "../../../shared/types";
import { resolveQuotaWindows } from "../pages/OverviewPage";
import { useT } from "../../../shared/i18n/context";
import type { ServerRuntime } from "../../../shared/hooks/use-status";

interface CodexAccountCardProps {
  account: Account | null;
  authFile: string;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastUpdated: Date | null;
  onReload: () => Promise<boolean>;
  runtime?: ServerRuntime | null;
  codexCliVersion?: string | null;
}
const num = (v?: number) => new Intl.NumberFormat().format(v ?? 0);
function bytes(v?: number) {
  if (!v || !Number.isFinite(v)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let n = v,
    i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function remaining(w?: AccountQuotaWindow | null) {
  if (!w) return null;
  const v =
    w.remaining_percent ??
    (w.used_percent == null ? null : 100 - w.used_percent);
  return v == null || !Number.isFinite(v)
    ? null
    : Math.max(0, Math.min(100, v));
}
function reset(v?: number | null) {
  return v ? new Date(v * 1000).toLocaleString() : "—";
}

export function CodexAccountCard(p: CodexAccountCardProps) {
  const t = useT(),
    a = p.account,
    u = a?.usage,
    r = p.runtime;
  const quotaWindows = resolveQuotaWindows(a?.quota);
  const usedMem = r ? r.memory_total_bytes - r.memory_free_bytes : undefined;
  const usedDisk =
    r?.disk_total_bytes && r.disk_free_bytes != null
      ? r.disk_total_bytes - r.disk_free_bytes
      : undefined;
  const bar = (label: string, w: AccountQuotaWindow | null | undefined) => {
    const left = remaining(w);
    return (
      <div class="rounded-xl border border-gray-100 p-4 dark:border-border-dark">
        <div class="flex justify-between">
          <span class="text-sm font-semibold text-slate-700 dark:text-text-main">
            {label}
          </span>
          <span class="text-sm font-bold text-slate-800 dark:text-text-main">
            {left == null ? "—" : `${left.toFixed(0)}%`}
          </span>
        </div>
        <div
          class="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-bg-dark"
          role="progressbar"
          aria-label={label}
          aria-valuenow={left ?? 0}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class={`h-full rounded-full ${left != null && left < 20 ? "bg-red-500" : left != null && left < 50 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${left ?? 0}%` }}
          />
        </div>
        <div class="mt-2 text-xs text-slate-500 dark:text-text-dim">
          {w ? `${t("resetsAt")}: ${reset(w.reset_at)}` : t("quotaUnavailable")}
        </div>
      </div>
    );
  };
  const cells = (items: [string, string][]) =>
    items.map(([label, value]) => (
      <div
        key={label}
        class="rounded-xl border border-gray-100 p-3 dark:border-border-dark"
      >
        <div class="text-xs text-slate-400">{label}</div>
        <div class="mt-1 truncate text-sm font-semibold text-slate-700 dark:text-text-main">
          {value}
        </div>
      </div>
    ));
  return (
    <section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-border-dark dark:bg-card-dark md:p-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div class="flex items-center gap-2">
            <span
              class={`size-2.5 rounded-full ${a?.status === "active" ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <h2 class="text-base font-bold text-slate-800 dark:text-text-main">
              {t("codexCliAccount")}
            </h2>
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">
            {t("codexCliAccountDesc")}
          </p>
        </div>
        <button
          type="button"
          disabled={p.refreshing}
          onClick={() => void p.onReload()}
          class="rounded-lg bg-primary-action px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
        >
          {p.refreshing ? t("reloadingAuth") : t("reloadAuth")}
        </button>
      </div>
      <div class="mt-5 grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl bg-slate-50 p-4 dark:bg-bg-dark">
          <div class="text-[0.7rem] font-semibold uppercase tracking-wide text-slate-400">
            {t("authFile")}
          </div>
          <code class="mt-1 block break-all text-xs text-slate-700 dark:text-text-main">
            {p.authFile || "~/.codex/auth.json"}
          </code>
        </div>
        <div class="rounded-xl bg-slate-50 p-4 dark:bg-bg-dark">
          <div class="text-[0.7rem] font-semibold uppercase tracking-wide text-slate-400">
            {t("codexCliVersion")}
          </div>
          <code class="mt-1 block text-sm font-semibold text-slate-700 dark:text-text-main">
            {p.codexCliVersion ?? "—"}
          </code>
        </div>
      </div>
      {p.loading ? (
        <p class="mt-5 text-sm text-slate-500">{t("loadingAccounts")}</p>
      ) : !a ? (
        <div class="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
          <p class="font-semibold">{t("noCliAccount")}</p>
          <p class="mt-1 text-xs">{t("runCodexLogin")}</p>
          {p.error && (
            <p class="mt-2 break-all font-mono text-[0.7rem]">{p.error}</p>
          )}
        </div>
      ) : (
        <>
          <section class="mt-6">
            <h3 class="text-sm font-bold text-slate-800 dark:text-text-main">
              {t("codexAccountInfo")}
            </h3>
            <dl class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {cells([
                [t("email"), a.email ?? "—"],
                [t("plan"), a.planType ?? a.quota?.plan_type ?? "—"],
                [t("totalRequests"), num(u?.request_count)],
                [
                  t("tokensUsed"),
                  num((u?.input_tokens ?? 0) + (u?.output_tokens ?? 0)),
                ],
              ])}
            </dl>
            <div class="mt-4 text-xs text-slate-500">
              {t("status")}: <strong>{a.status}</strong>
              {p.lastUpdated && (
                <span class="ml-5">
                  {t("updatedAt")}: {p.lastUpdated.toLocaleTimeString()}
                </span>
              )}
            </div>
          </section>
          <section class="mt-6 border-t border-gray-100 pt-5 dark:border-border-dark">
            <h3 class="text-sm font-bold text-slate-800 dark:text-text-main">
              {t("codexAccountQuota")}
            </h3>
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              {bar(t("fiveHourLimit"), quotaWindows.fiveHour)}
              {bar(t("weeklyLimit"), quotaWindows.weekly)}
            </div>
            <div class="mt-3 grid gap-3 sm:grid-cols-3">
              {cells([
                [t("plan"), a.quota?.plan_type ?? a.planType ?? "—"],
                [t("totalRequests"), num(u?.request_count)],
                [
                  t("totalQuota"),
                  a.quota?.credits?.unlimited
                    ? t("unlimited")
                    : num(a.quota?.credits?.balance),
                ],
              ])}
            </div>
          </section>
        </>
      )}
      <section class="mt-6 border-t border-gray-100 pt-5 dark:border-border-dark">
        <h3 class="text-sm font-bold text-slate-800 dark:text-text-main">
          {t("serverResources")}
        </h3>
        <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cells([
            [t("serverName"), r?.server_name ?? "—"],
            [t("serverIp"), r?.server_ip ?? "—"],
            [t("systemVersion"), r?.system ?? "—"],
            [t("processCount"), num(r?.process_count)],
          ])}
        </div>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          {cells([
            [
              t("serverCpuLoad"),
              r
                ? `${r.cpu_count} · ${r.load_average[0]?.toFixed(2) ?? "—"}`
                : "—",
            ],
            [
              t("serverMemory"),
              r ? `${bytes(usedMem)} / ${bytes(r.memory_total_bytes)}` : "—",
            ],
            [
              t("diskUsage"),
              r ? `${bytes(usedDisk)} / ${bytes(r.disk_total_bytes)}` : "—",
            ],
          ])}
        </div>
      </section>
    </section>
  );
}
