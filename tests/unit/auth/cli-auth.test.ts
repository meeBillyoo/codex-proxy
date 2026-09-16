import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { importCliAuth } from "@src/auth/cli-auth.js";

let testDir: string | null = null;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = null;
});

describe("importCliAuth", () => {
  it.each([
    {
      name: "legacy top-level tokens",
      auth: {
        access_token: "legacy-access",
        id_token: "legacy-id",
      },
    },
    {
      name: "current nested tokens",
      auth: {
        auth_mode: "chatgpt",
        tokens: {
          access_token: "nested-access",
          id_token: "nested-id",
          account_id: "account-1",
        },
      },
    },
  ])("imports $name", ({ auth }) => {
    testDir = mkdtempSync(join(tmpdir(), "codex-proxy-cli-auth-"));
    const codexHome = join(testDir, ".codex");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(auth));
    process.env.CODEX_HOME = codexHome;

    const imported = importCliAuth();

    const expected = "tokens" in auth ? auth.tokens : auth;
    expect(imported).toEqual({
      auth_mode: "auth_mode" in auth ? auth.auth_mode : undefined,
      access_token: expected.access_token,
      id_token: expected.id_token,
      expires_at: undefined,
      account_id: "account_id" in expected ? expected.account_id : undefined,
    });
  });
});
