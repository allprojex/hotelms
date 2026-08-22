import { defineConfig, type Plugin } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Node's own module loader silently strips a leading shebang line (e.g.
// `#!/usr/bin/env node`) before executing a file — required for every
// scripts/prod/*.mjs CLI entry point, which tests/prod-guards.test.ts
// imports directly (they're written to be runnable both as
// `node scripts/prod/x.mjs` and as plain importable modules for testing).
// Vite's SSR module runner does not replicate that stripping for an .mjs
// file whose transform pipeline it skips (plain JS source, no plugin
// claims it) — it hands the raw file text, shebang included, straight to
// `vm.Script`, which throws "Invalid or unexpected token" on the leading
// `#`. This closes that gap for the test runner only; it never touches
// the files on disk, and only ever strips a genuine leading shebang line.
function stripShebangPlugin(): Plugin {
  return {
    name: "strip-shebang",
    transform(code) {
      if (!code.startsWith("#!")) return null;
      const newlineIndex = code.indexOf("\n");
      return newlineIndex === -1 ? "" : code.slice(newlineIndex + 1);
    },
  };
}

export default defineConfig({
  plugins: [stripShebangPlugin()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
