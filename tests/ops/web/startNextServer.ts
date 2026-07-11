import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const webAppDir = path.join(repoRoot, "apps/web");
const port = process.env.PORT ?? "3105";

rmSync(path.join(webAppDir, ".next"), { recursive: true, force: true });
execFileSync("pnpm", ["exec", "next", "build"], {
  cwd: webAppDir,
  env: process.env,
  stdio: "inherit",
});

const child = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", port], {
  cwd: webAppDir,
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
