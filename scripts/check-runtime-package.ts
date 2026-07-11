import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface NpmPackFile {
  path: string;
}

interface NpmPackResult {
  files: NpmPackFile[];
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const npmCacheDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-runtime-pack-cache-"));

const forbiddenPrefixes = [
  "apps/",
  "packages/",
  "tests/",
  "docs/",
  ".github/",
  "benchmarks/",
  "coding-agent-review/",
  "node_modules/",
] as const;

const requiredFiles = [
  "package.json",
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "bin/kestrel.js",
  "bin/kcron.js",
  "cli/tui.ts",
  "src/index.ts",
  "agents/reference-react/src/index.ts",
  "tools/index.ts",
  "db/migrations/001_sessions_runs.sql",
  "scripts/start.ts",
  "scripts/migrate.ts",
  "README.md",
  "LICENSE",
] as const;

try {
  const output = execFileSync(
    resolveNpmCommand(),
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const results = JSON.parse(output) as NpmPackResult[];
  assert.equal(results.length, 1, "npm pack must describe exactly one runtime package.");

  const filePaths = new Set(results[0]?.files.map((file) => file.path) ?? []);
  assert.ok(filePaths.size > 0, "npm pack returned an empty runtime package.");

  for (const filePath of filePaths) {
    const forbiddenPrefix = forbiddenPrefixes.find((prefix) => filePath.startsWith(prefix));
    assert.equal(
      forbiddenPrefix,
      undefined,
      `runtime package contains forbidden path '${filePath}'`,
    );
    assert.ok(
      isSensitiveOrTestPath(filePath) === false,
      `runtime package contains unsafe path '${filePath}'`,
    );
  }

  for (const requiredFile of requiredFiles) {
    assert.ok(filePaths.has(requiredFile), `runtime package is missing '${requiredFile}'`);
  }

  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    main?: string;
    types?: string;
  };
  assert.equal(manifest.main, "dist/src/index.js");
  assert.equal(manifest.types, "dist/src/index.d.ts");
  assert.equal(manifest.dependencies?.["@kestrel-agents/protocol"], "0.5.1");
  assert.ok(filePaths.has(manifest.main), `runtime package main '${manifest.main}' is not packed`);
  assert.ok(filePaths.has(manifest.types), `runtime package types '${manifest.types}' are not packed`);

  console.log(`runtime release-check passed (${filePaths.size} files)`);
} finally {
  rmSync(npmCacheDir, { recursive: true, force: true });
}

function isSensitiveOrTestPath(filePath: string): boolean {
  const normalized = `/${filePath.toLowerCase()}`;
  return (
    /\/(?:__tests__|tests?)(?:\/|$)/u.test(normalized) ||
    /\.(?:test|spec)\.[^/]+$/u.test(normalized) ||
    /\/(?:\.env(?:\.[^/]*)?|\.auth)(?:\/|$)/u.test(normalized) ||
    /\/(?:secrets?|credentials?)(?:\/|$)/u.test(normalized) ||
    /\/(?:storage-state|auth-state)(?:\.[^/]*)?$/u.test(normalized) ||
    /\/(?:\.vitest|coverage|playwright-report)(?:\/|$)/u.test(normalized) ||
    /\/__pycache__(?:\/|$)/u.test(normalized) ||
    /\.pyc$/u.test(normalized)
  );
}

function resolveNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
