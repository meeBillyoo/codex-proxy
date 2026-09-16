import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Detect whether an ES module is the process entry point.
 *
 * PM2 replaces process.argv[1] with its wrapper script, but exposes the
 * actual application entry point through pm_exec_path.
 */
export function isDirectRun(
  moduleUrl: string,
  argvEntry = process.argv[1],
  pmExecPath = process.env.pm_exec_path,
): boolean {
  const modulePath = resolve(fileURLToPath(moduleUrl));
  return [pmExecPath, argvEntry].some((entry) => entry != null && resolve(entry) === modulePath);
}
