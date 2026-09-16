/**
 * Dashboard requests authenticate with the HttpOnly dashboard session.
 * The ENV-only proxy key is intentionally never returned to browser code.
 */
export function useSettings() {
  return { apiKey: null };
}
