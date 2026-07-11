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
const entrypoint = path.join(repoRoot, "src", "localCore", "daemonMain.ts");

const child = spawn(
  process.execPath,
  ["--import", tsxImport, entrypoint, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
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
  console.error(`[kestrel-core] failed to launch daemon: ${error.message}`);
  process.exit(1);
});
