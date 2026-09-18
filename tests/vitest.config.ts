import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "@src": resolve(projectRoot, "src"),
      "@helpers": resolve(import.meta.dirname, "_helpers"),
      "@fixtures": resolve(import.meta.dirname, "_fixtures"),
    },
  },
  test: {
    root: projectRoot,
    include: ["tests/stress/**/*.test.ts"],
    passWithNoTests: true,
    environment: "node",
    testTimeout: 120_000,
    pool: "forks",
    maxForks: 1,
  },
});
