import { afterEach, describe, expect, it } from "vitest";
import {
  isUpstreamResponsesWebSocketEnabled,
  isWebSocketUpstreamResponse,
} from "@src/proxy/upstream-transport-policy.js";

const originalDisableWs = process.env.CODEX_PROXY_DISABLE_WS;

afterEach(() => {
  if (originalDisableWs === undefined) {
    delete process.env.CODEX_PROXY_DISABLE_WS;
  } else {
    process.env.CODEX_PROXY_DISABLE_WS = originalDisableWs;
  }
});

describe("upstream Responses transport policy", () => {
  it("enables WebSocket by default and disables it only for the exact emergency value", () => {
    delete process.env.CODEX_PROXY_DISABLE_WS;
    expect(isUpstreamResponsesWebSocketEnabled()).toBe(true);

    process.env.CODEX_PROXY_DISABLE_WS = "0";
    expect(isUpstreamResponsesWebSocketEnabled()).toBe(true);

    process.env.CODEX_PROXY_DISABLE_WS = "1";
    expect(isUpstreamResponsesWebSocketEnabled()).toBe(false);
  });

  it("trusts an explicit transport marker over the originally requested transport", () => {
    expect(isWebSocketUpstreamResponse(new Response("", {
      headers: { "x-codex-proxy-upstream-transport": "http" },
    }), true)).toBe(false);
    expect(isWebSocketUpstreamResponse(new Response("", {
      headers: { "x-codex-proxy-upstream-transport": "websocket" },
    }), false)).toBe(true);
  });
});
