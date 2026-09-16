import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@src": resolve(import.meta.dirname, "src"),
      "@helpers": resolve(import.meta.dirname, "tests/_helpers"),
      "@fixtures": resolve(import.meta.dirname, "tests/_fixtures"),
      "react/jsx-dev-runtime": "preact/jsx-runtime",
      "react/jsx-runtime": "preact/jsx-runtime",
      react: "preact/compat",
    },
  },
  test: {
    environment: "node",
    include: [
      "shared/**/*.{test,spec}.ts",
      "tests/unit/**/*.{test,spec}.ts",
      "tests/integration/**/*.{test,spec}.ts",
      "tests/contract/**/*.{test,spec}.ts",
      "tests/e2e/**/*.{test,spec}.ts",
    ],
  },
});
