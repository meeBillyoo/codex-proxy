import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { existsSync, readFileSync, statfsSync } from "fs";
import os from "os";
import { execFileSync } from "child_process";
import { resolve } from "path";
import type { AccountPool } from "../../auth/account-pool.js";
import { getConfig, getFingerprint } from "../../config.js";
import { getConfigDir, getDataDir, getBinDir, isEmbedded } from "../../paths.js";
import { getTransportInfo } from "../../tls/transport.js";
import { getProxyUrl } from "../../tls/proxy.js";
import { isLocalhostRequest } from "../../utils/is-localhost.js";

const PUBLIC_IP_CACHE_MS = 60 * 60 * 1000;
let publicIpCache: { value: string | null; expiresAt: number } | null = null;
let publicIpRequest: Promise<string | null> | null = null;

function percentage(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Number(((used / total) * 100).toFixed(1))));
}

async function sampleCpuUsage(): Promise<number | null> {
  const read = () => os.cpus().reduce(
    (totals, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      totals.idle += cpu.times.idle;
      totals.total += total;
      return totals;
    },
    { idle: 0, total: 0 },
  );
  const before = read();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const after = read();
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  return percentage(totalDelta - idleDelta, totalDelta);
}

async function getPublicIp(): Promise<string | null> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return null;
  if (publicIpCache && publicIpCache.expiresAt > Date.now()) return publicIpCache.value;
  if (publicIpRequest) return publicIpRequest;

  publicIpRequest = (async () => {
    try {
      const response = await fetch("https://api.ipify.org?format=json", {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const data = await response.json() as { ip?: unknown };
      return typeof data.ip === "string" && data.ip.trim() ? data.ip.trim() : null;
    } catch {
      return null;
    }
  })();

  try {
    const value = await publicIpRequest;
    publicIpCache = {
      value,
      expiresAt: Date.now() + (value ? PUBLIC_IP_CACHE_MS : 5 * 60 * 1000),
    };
    return value;
  } finally {
    publicIpRequest = null;
  }
}

export function createHealthRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  const cliVersion = (() => {
    try {
      return execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 2000 }).trim() || null;
    } catch {
      return null;
    }
  })();

  app.get("/health", async (c) => {
    const authenticated = accountPool.isAuthenticated();
    const account = accountPool.getAccount();
    const capacitySummary = accountPool.getCapacitySummary();
    const interfaces = os.networkInterfaces();
    const serverIp = Object.values(interfaces)
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === "IPv4" && !entry.internal)?.address ?? null;
    let disk = { total_bytes: 0, free_bytes: 0 };
    try {
      const stats = statfsSync(getDataDir());
      disk = { total_bytes: Number(stats.blocks) * Number(stats.bsize), free_bytes: Number(stats.bavail) * Number(stats.bsize) };
    } catch {}
    let processCount = 1;
    try {
      processCount = execFileSync("ps", ["-e", "-o", "pid="], { encoding: "utf8", timeout: 1000 }).trim().split("\n").filter(Boolean).length || 1;
    } catch {}
    const memoryTotalBytes = os.totalmem();
    const memoryFreeBytes = os.freemem();
    const [cpuUsagePercent, publicIp] = await Promise.all([
      sampleCpuUsage(),
      getPublicIp(),
    ]);
    return c.json({
      status: "ok",
      authenticated,
      account: {
        available: account !== null,
        status: account?.status ?? null,
        email: account?.email ?? null,
        plan_type: account?.planType ?? null,
      },
      concurrency: {
        ...capacitySummary,
      },
      uptime_seconds: Math.floor(process.uptime()),
      runtime: {
        server_name: os.hostname(),
        server_ip: serverIp,
        public_ip: publicIp,
        system: `${os.platform()} ${os.release()}`,
        os_type: os.type(),
        os_version: os.release(),
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu_count: os.cpus().length,
        cpu_usage_percent: cpuUsagePercent,
        load_average: os.loadavg(),
        memory_total_bytes: memoryTotalBytes,
        memory_free_bytes: memoryFreeBytes,
        memory_usage_percent: percentage(memoryTotalBytes - memoryFreeBytes, memoryTotalBytes),
        disk_total_bytes: disk.total_bytes,
        disk_free_bytes: disk.free_bytes,
        disk_usage_percent: percentage(disk.total_bytes - disk.free_bytes, disk.total_bytes),
        process_count: processCount,
      },
      codex_cli: { version: cliVersion },
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/debug/fingerprint", (c) => {
    const isProduction = process.env.NODE_ENV === "production";
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    const isLocalhost = isLocalhostRequest(remoteAddr);
    if (isProduction && !isLocalhost) {
      c.status(404);
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } });
    }

    const config = getConfig();
    const fp = getFingerprint();

    const ua = fp.user_agent_template
      .replace("{version}", config.client.app_version)
      .replace("{platform}", config.client.platform)
      .replace("{arch}", config.client.arch);

    const promptsDir = resolve(getConfigDir(), "prompts");
    const prompts: Record<string, boolean> = {
      "desktop-context.md": existsSync(resolve(promptsDir, "desktop-context.md")),
      "title-generation.md": existsSync(resolve(promptsDir, "title-generation.md")),
      "pr-generation.md": existsSync(resolve(promptsDir, "pr-generation.md")),
      "automation-response.md": existsSync(resolve(promptsDir, "automation-response.md")),
    };

    let updateState = null;
    const statePath = resolve(getDataDir(), "update-state.json");
    if (existsSync(statePath)) {
      try {
        updateState = JSON.parse(readFileSync(statePath, "utf-8"));
      } catch {}
    }

    return c.json({
      headers: {
        "User-Agent": ua,
        originator: config.client.originator,
      },
      client: {
        app_version: config.client.app_version,
        build_number: config.client.build_number,
        platform: config.client.platform,
        arch: config.client.arch,
      },
      api: {
        base_url: config.api.base_url,
      },
      model: {
        default: config.model.default,
      },
      codex_fields: {
        developer_instructions: "loaded from config/prompts/desktop-context.md",
        approval_policy: "never",
        sandbox: "workspace-write",
        personality: null,
        ephemeral: null,
      },
      prompts_loaded: prompts,
      update_state: updateState,
    });
  });

  app.get("/debug/diagnostics", (c) => {
    const remoteAddr = getConnInfo(c).remote.address ?? "";
    const isLocalhost = isLocalhostRequest(remoteAddr);
    if (process.env.NODE_ENV === "production" && !isLocalhost) {
      c.status(404);
      return c.json({ error: { message: "Not found", type: "invalid_request_error" } });
    }

    const transport = getTransportInfo();
    const account = accountPool.getAccount();

    return c.json({
      transport: {
        type: transport.type,
        initialized: transport.initialized,
        impersonate: transport.impersonate,
      },
      proxy: { url: getProxyUrl() },
      account: {
        available: account !== null,
        status: account?.status ?? null,
        authenticated: accountPool.isAuthenticated(),
      },
      paths: {
        bin: getBinDir(),
        config: getConfigDir(),
        data: getDataDir(),
      },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        embedded: isEmbedded(),
      },
    });
  });

  return app;
}
