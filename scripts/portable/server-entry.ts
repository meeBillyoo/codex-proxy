/** Public surface bundled into the standalone Lite server. */

export { setPaths } from "../../src/paths.js";
export { startServer } from "../../src/index.js";
export type { ServerHandle, StartOptions } from "../../src/index.js";
export { getConfig } from "../../src/config.js";
// The bundle smoke test calls this to verify bundled CommonJS interop.
export { loadWebSocketModule } from "../../src/proxy/ws-transport.js";
