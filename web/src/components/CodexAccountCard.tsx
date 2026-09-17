import type { Account } from "../../../shared/types";
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

function formatNumber(value: number | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0);
}

function formatBytes(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return "—";
  const units = ["B", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function CodexAccountCard(props: CodexAccountCardProps) {
  const t = useT();
  const account = props.account;
  const usage = account?.usage;

  return (
    <section class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-border-dark dark:bg-card-dark md:p-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div class="flex items-center gap-2">
            <span class={`size-2.5 rounded-full ${account?.status === "active" ? "bg-emerald-500" : "bg-amber-500"}`} />
            <h2 class="text-base font-bold text-slate-800 dark:text-text-main">{t("codexCliAccount")}</h2>
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">{t("codexCliAccountDesc")}</p>
        </div>
        <button
          type="button"
          disabled={props.refreshing}
          onClick={() => void props.onReload()}
          class="inline-flex items-center justify-center rounded-lg bg-primary-action px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-action-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {props.refreshing ? t("reloadingAuth") : t("reloadAuth")}
        </button>
      </div>

      <div class="mt-5 grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl bg-slate-50 p-4 dark:bg-bg-dark">
        <div class="text-[0.7rem] font-semibold uppercase tracking-wide text-slate-400">{t("authFile")}</div>
        <code class="mt-1 block break-all text-xs text-slate-700 dark:text-text-main">{props.authFile || "~/.codex/auth.json"}</code>
        </div>
        <div class="rounded-xl bg-slate-50 p-4 dark:bg-bg-dark">
          <div class="text-[0.7rem] font-semibold uppercase tracking-wide text-slate-400">{t("codexCliVersion")}</div>
          <code class="mt-1 block text-sm font-semibold text-slate-700 dark:text-text-main">{props.codexCliVersion ?? "—"}</code>
        </div>
      </div>

      {props.loading ? (
        <p class="mt-5 text-sm text-slate-500 dark:text-text-dim">{t("loadingAccounts")}</p>
      ) : !account ? (
        <div class="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-300">
          <p class="font-semibold">{t("noCliAccount")}</p>
          <p class="mt-1 text-xs">{t("runCodexLogin")}</p>
          {props.error && <p class="mt-2 break-all font-mono text-[0.7rem] opacity-80">{props.error}</p>}
        </div>
      ) : (
        <>
          <dl class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="rounded-xl border border-gray-100 p-3 dark:border-border-dark">
              <dt class="text-[0.7rem] text-slate-400">{t("email")}</dt>
              <dd class="mt-1 truncate text-sm font-semibold text-slate-700 dark:text-text-main">{account.email ?? "—"}</dd>
            </div>
            <div class="rounded-xl border border-gray-100 p-3 dark:border-border-dark">
              <dt class="text-[0.7rem] text-slate-400">{t("plan")}</dt>
              <dd class="mt-1 text-sm font-semibold capitalize text-slate-700 dark:text-text-main">{account.planType ?? "—"}</dd>
            </div>
            <div class="rounded-xl border border-gray-100 p-3 dark:border-border-dark">
              <dt class="text-[0.7rem] text-slate-400">{t("totalRequests")}</dt>
              <dd class="mt-1 text-sm font-semibold text-slate-700 dark:text-text-main">{formatNumber(usage?.request_count)}</dd>
            </div>
            <div class="rounded-xl border border-gray-100 p-3 dark:border-border-dark">
              <dt class="text-[0.7rem] text-slate-400">{t("tokensUsed")}</dt>
              <dd class="mt-1 text-sm font-semibold text-slate-700 dark:text-text-main">{formatNumber((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0))}</dd>
            </div>
          </dl>
          <div class="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-500 dark:text-text-dim">
            <span>{t("status")}: <strong class="text-slate-700 dark:text-text-main">{account.status}</strong></span>
            <span>{t("accountId")}: <code class="text-slate-700 dark:text-text-main">{account.accountId ?? "—"}</code></span>
            {account.expiresAt && <span>{t("expires")}: <strong class="text-slate-700 dark:text-text-main">{new Date(account.expiresAt).toLocaleString()}</strong></span>}
            {props.lastUpdated && <span>{t("updatedAt")}: {props.lastUpdated.toLocaleTimeString()}</span>}
          </div>
          <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="rounded-xl border border-gray-100 p-3 dark:border-border-dark"><div class="text-[0.7rem] text-slate-400">{t("serverPlatform")}</div><div class="mt-1 text-sm font-semibold text-slate-700 dark:text-text-main">{props.runtime ? `${props.runtime.platform} / ${props.runtime.arch}` : "—"}</div></div>
            <div class="rounded-xl border border-gray-100 p-3 dark:border-border-dark"><div class="text-[0.7rem] text-slate-400">{t("serverCpuLoad")}</div><div class="mt-1 text-sm font-semibold text-slate-700 dark:text-text-main">{props.runtime ? `${props.runtime.cpu_count} · ${props.runtime.load_average[0]?.toFixed(2) ?? "—"}` : "—"}</div></div>
            <div class="rounded-xl border border-gray-100 p-3 dark:border-border-dark"><div class="text-[0.7rem] text-slate-400">{t("serverMemory")}</div><div class="mt-1 text-sm font-semibold text-slate-700 dark:text-text-main">{props.runtime ? `${formatBytes(props.runtime.memory_total_bytes - props.runtime.memory_free_bytes)} / ${formatBytes(props.runtime.memory_total_bytes)}` : "—"}</div></div>
            <div class="rounded-xl border border-gray-100 p-3 dark:border-border-dark"><div class="text-[0.7rem] text-slate-400">{t("nodeVersion")}</div><div class="mt-1 text-sm font-semibold text-slate-700 dark:text-text-main">{props.runtime?.node_version ?? "—"}</div></div>
          </div>
        </>
      )}
    </section>
  );
}
