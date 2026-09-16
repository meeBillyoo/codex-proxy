import { describe, expect, it } from "vitest";
import { isDirectRun } from "@src/utils/is-direct-run.js";

const moduleUrl = "file:///opt/codex-proxy/dist/index.js";

describe("isDirectRun", () => {
  it("detects a normal node entry point", () => {
    expect(isDirectRun(moduleUrl, "/opt/codex-proxy/dist/index.js", undefined)).toBe(true);
  });

  it("detects the real entry point exposed by PM2", () => {
    expect(isDirectRun(moduleUrl, "/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js", "/opt/codex-proxy/dist/index.js"))
      .toBe(true);
  });

  it("does not run when imported by another application", () => {
    expect(isDirectRun(moduleUrl, "/opt/codex-proxy/dist/electron-main.js", undefined)).toBe(false);
  });
});
