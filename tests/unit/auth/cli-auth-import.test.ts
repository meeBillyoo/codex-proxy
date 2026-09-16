import { describe, expect, it } from "vitest";
import { normalizeCliAuth } from "@src/auth/oauth-pkce.js";

describe("normalizeCliAuth", () => {
  it("accepts the legacy top-level token layout", () => {
    expect(normalizeCliAuth({ access_token: "access", refresh_token: "refresh" })).toMatchObject({
      access_token: "access",
      refresh_token: "refresh",
    });
  });

  it("accepts the current nested tokens layout", () => {
    expect(normalizeCliAuth({
      tokens: {
        access_token: "nested-access",
        refresh_token: "nested-refresh",
        id_token: "nested-id",
        account_id: "account-id",
      },
    })).toMatchObject({
      access_token: "nested-access",
      refresh_token: "nested-refresh",
      id_token: "nested-id",
    });
  });

  it("rejects auth files without an access token", () => {
    expect(() => normalizeCliAuth({ tokens: { refresh_token: "refresh" } })).toThrow(
      "CLI auth.json does not contain access_token",
    );
  });
});
