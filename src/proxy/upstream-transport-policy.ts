/**
 * Whether proxy-owned Responses requests may use the upstream WebSocket
 * transport.  The switch is intentionally process-wide: it is an emergency
 * compatibility valve for deployments whose upstream network or account
 * rejects the Responses WebSocket upgrade while HTTP SSE still works.
 */
export function isUpstreamResponsesWebSocketEnabled(): boolean {
  return process.env.CODEX_PROXY_DISABLE_WS !== "1";
}

export const UPSTREAM_TRANSPORT_HEADER = "x-codex-proxy-upstream-transport";
export const UPSTREAM_TRANSPORT_HTTP = "http";
export const UPSTREAM_TRANSPORT_WEBSOCKET = "websocket";

export function isWebSocketUpstreamResponse(
  response: Response,
  requestedWebSocket?: boolean,
): boolean {
  const transport = response.headers.get(UPSTREAM_TRANSPORT_HEADER);
  if (transport) return transport === UPSTREAM_TRANSPORT_WEBSOCKET;
  // Backward-compatible default for injected adapters and tests. Production
  // CodexApi responses always carry the internal transport marker.
  return requestedWebSocket !== false;
}
