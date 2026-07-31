import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";



test("AppRoot source-run JSX uses the repository config from an external workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "kestrel-cli-source-run-"));
  try {
    const repoRoot = process.cwd();
    const result = await runProcess(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--test",
        "--test-name-pattern=AppRoot keeps chat visible",
        path.join(repoRoot, "tests/unit/cli-app-root.test.ts"),
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
        },
      },
    );

    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /React is not defined/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}
