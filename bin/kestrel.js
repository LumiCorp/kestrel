#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const binPath = fs.realpathSync(fileURLToPath(import.meta.url));
const require = createRequire(pathToFileURL(binPath).href);
const tsxImport = require.resolve("tsx");
const repoRoot = path.resolve(path.dirname(binPath), "..");
const entrypoint = path.join(repoRoot, "cli", "tui.ts");
const invokedAs = path.basename(process.argv[1] ?? "kestrel");
const repoEnv = loadRepoDotEnv(path.join(repoRoot, ".env"));
const childEnv = {
  ...repoEnv,
  ...process.env,
};
applySourcePostgresBundleEnv(childEnv, repoRoot);

const child = spawn(
  process.execPath,
  ["--import", tsxImport, entrypoint, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...childEnv,
      KESTREL_ENTRYPOINT_ALIAS: invokedAs,
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`[kestrel] failed to launch CLI: ${error.message}`);
  process.exit(1);
});

function loadRepoDotEnv(envPath) {
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    return parseDotEnv(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseDotEnv(content) {
  const values = {};

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equals).trim();
    const rawValue = trimmed.slice(equals + 1).trim();
    if (key.length === 0) {
      continue;
    }

    values[key] = unquote(rawValue);
  }

  return values;
}

function applySourcePostgresBundleEnv(env, root) {
  if (typeof env.KESTREL_LOCAL_CORE_POSTGRES_BUNDLE === "string" && env.KESTREL_LOCAL_CORE_POSTGRES_BUNDLE.trim().length > 0) {
    return;
  }
  const bundlePath = path.join(root, "apps", "desktop", "resources", "postgres-bundle");
  if (fs.existsSync(bundlePath)) {
    env.KESTREL_LOCAL_CORE_POSTGRES_BUNDLE = bundlePath;
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
