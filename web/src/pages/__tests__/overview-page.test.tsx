/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";
import type { Account } from "../../../../shared/types";
import type { ServerRuntime } from "../../../../shared/hooks/use-status";

const hookMocks = vi.hoisted(() => ({
  useUsageSummary: vi.fn(),
  useResetCredits: vi.fn(),
  useT: vi.fn(),
}));

vi.mock("../../../../shared/hooks/use-usage-stats", () => ({
  useUsageSummary: hookMocks.useUsageSummary,
}));

vi.mock("../../../../shared/hooks/use-reset-credits", () => ({
  useResetCredits: hookMocks.useResetCredits,
}));

vi.mock("../../../../shared/i18n/context", () => ({
  useT: hookMocks.useT,
}));

import { OverviewPage, quotaRemaining, resolveQuotaWindows } from "../OverviewPage";

const account: Account = {
  id: "codex-cli",
  email: "owner@example.com",
  accountId: "acct-1",
  addedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z",
  status: "active",
  planType: "plus",
  quota: {
    plan_type: "plus",
    rate_limit: { used_percent: 27, reset_at: 1_800_000_000, limit_window_seconds: 5 * 60 * 60 },
    secondary_rate_limit: { remaining_percent: 41, reset_at: 1_800_100_000, limit_window_seconds: 7 * 24 * 60 * 60 },
    reset_credits_available: 2,
  },
};

const runtime: ServerRuntime = {
  server_name: "proxy-host",
  server_ip: "192.168.1.8",
  public_ip: "203.0.113.8",
  system: "darwin 25.0",
  os_type: "Darwin",
  os_version: "25.0",
  node_version: "v24.13.0",
  platform: "darwin",
  arch: "arm64",
  cpu_count: 12,
  cpu_usage_percent: 32.5,
  load_average: [1.23, 1, 0.8],
  memory_total_bytes: 16 * 1024 ** 3,
  memory_free_bytes: 6 * 1024 ** 3,
  memory_usage_percent: 62.5,
  disk_total_bytes: 100 * 1024 ** 3,
  disk_free_bytes: 40 * 1024 ** 3,
  disk_usage_percent: 60,
};

describe("OverviewPage", () => {
  beforeEach(() => {
    hookMocks.useT.mockReturnValue((key: string, vars?: Record<string, string | number>) => {
      let value = key;
      for (const [name, replacement] of Object.entries(vars ?? {})) {
        value = value.replace(`{${name}}`, String(replacement));
      }
      return value;
    });
    hookMocks.useUsageSummary.mockReturnValue({
      summary: {
        total_input_tokens: 1_000,
        total_output_tokens: 500,
        total_cached_tokens: 0,
        total_image_input_tokens: 20,
        total_image_output_tokens: 30,
        total_image_request_count: 0,
        total_image_request_failed_count: 0,
        total_estimated_cost_usd: 12.34,
        total_request_count: 88,
        total_accounts: 1,
        active_accounts: 1,
        tracking_started_at: "2026-09-01T00:00:00.000Z",
      },
      loading: false,
      reload: vi.fn().mockResolvedValue(undefined),
    });
    hookMocks.useResetCredits.mockReturnValue({
      snapshot: { available_count: 3, next_expires_at: 1_800_200_000 },
      loading: false,
      reload: vi.fn().mockResolvedValue(true),
    });
  });

  afterEach(cleanup);

  it("presents account, quota, local usage, and host performance as separate sections", () => {
    render(
      <OverviewPage
        account={account}
        authFile="/home/codex/.codex/auth.json"
        loading={false}
        refreshing={false}
        error={null}
        lastUpdated={new Date("2026-09-18T08:00:00.000Z")}
        onReload={vi.fn().mockResolvedValue(true)}
        onRefreshHealth={vi.fn().mockResolvedValue(undefined)}
        runtime={runtime}
        codexCliVersion="codex-cli 1.2.3"
      />,
    );

    expect(screen.getByText("accountInformation")).toBeTruthy();
    expect(screen.getByText("quotaOverview")).toBeTruthy();
    expect(screen.getByText("hostPerformance")).toBeTruthy();
    expect(screen.getAllByText("owner@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("codex-cli 1.2.3")).toBeTruthy();
    expect(screen.getByText("73%")).toBeTruthy();
    expect(screen.getByText("41%")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1,550")).toBeTruthy();
    expect(screen.getByText("$12.34")).toBeTruthy();
    expect(screen.getByText("203.0.113.8")).toBeTruthy();
    expect(screen.getByText("32.5%")).toBeTruthy();
    expect(screen.getByText("62.5%")).toBeTruthy();
    expect(screen.getByText("60.0%")).toBeTruthy();
  });

  it("derives and clamps remaining quota percentages", () => {
    expect(quotaRemaining({ used_percent: 25 })).toBe(75);
    expect(quotaRemaining({ used_percent: 120 })).toBe(0);
    expect(quotaRemaining({ remaining_percent: 140 })).toBe(100);
    expect(quotaRemaining(null)).toBeNull();
  });

  it("uses the weekly primary window when the upstream reports it as the primary bucket", () => {
    const windows = resolveQuotaWindows({
      rate_limit: {
        used_percent: 36,
        remaining_percent: 64,
        reset_at: 1_800_000_000,
        limit_window_seconds: 7 * 24 * 60 * 60,
      },
      secondary_rate_limit: {
        used_percent: 0,
        remaining_percent: 100,
        reset_at: null,
        limit_window_seconds: null,
      },
    });

    expect(quotaRemaining(windows.fiveHour)).toBeNull();
    expect(quotaRemaining(windows.weekly)).toBe(64);
  });

  it("does not render a 5-hour meter when a Pro account only reports a weekly window", () => {
    render(
      <OverviewPage
        account={{
          ...account,
          planType: "pro",
          quota: {
            plan_type: "pro",
            rate_limit: {
              used_percent: 12,
              remaining_percent: 88,
              reset_at: 1_800_000_000,
              limit_window_seconds: 7 * 24 * 60 * 60,
            },
            secondary_rate_limit: null,
            reset_credits_available: null,
          },
        }}
        authFile="/home/codex/.codex/auth.json"
        loading={false}
        refreshing={false}
        error={null}
        lastUpdated={null}
        onReload={vi.fn().mockResolvedValue(true)}
        onRefreshHealth={vi.fn().mockResolvedValue(undefined)}
        runtime={runtime}
        codexCliVersion="codex-cli 1.2.3"
      />,
    );

    expect(screen.queryByText("fiveHourLimit")).toBeNull();
    expect(screen.getByText("weeklyLimit")).toBeTruthy();
    expect(screen.getByText("88%")).toBeTruthy();
  });
});
