import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../..");
const outputDirectory = resolve(root, "portable-release");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(scriptDir, "server-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: resolve(outputDirectory, "server-bundle.mjs"),
  external: [],
  target: "node24",
  sourcemap: true,
  banner: {
    js: `import { createRequire as __cpCreateRequire } from "module";\nimport { fileURLToPath as __cpFileURLToPath } from "url";\nimport { dirname as __cpDirname } from "path";\nconst require = __cpCreateRequire(import.meta.url);\nconst __filename = __cpFileURLToPath(import.meta.url);\nconst __dirname = __cpDirname(__filename);`,
  },
});

console.log("[esbuild] portable-release/server-bundle.mjs built successfully");
