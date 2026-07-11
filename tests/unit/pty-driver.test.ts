import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("pty driver abortPatterns fail fast with explicit reason", async () => {
  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const payload = {
    command: ["/bin/sh", "-lc", "printf 'boot\\n'; sleep 0.05; printf 'fatal marker\\n'; sleep 2"],
    env: readStringEnv(process.env),
    steps: [
      {
        pattern: "THIS_PATTERN_SHOULD_NOT_MATCH",
        regex: false,
        timeoutSeconds: 5,
      },
    ],
    abortPatterns: [
      {
        pattern: "fatal marker",
        regex: false,
        reason: "fatal_marker",
      },
    ],
    timeoutSeconds: 5,
  };

  const startedAt = Date.now();
  const result = await runPythonDriver(driverPath, JSON.stringify(payload));
  const durationMs = Date.now() - startedAt;

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ABORT_PATTERN_MATCHED:fatal_marker/u);
  assert.doesNotMatch(result.stderr, /Timed out waiting/u);
  assert.ok(durationMs < 5_000, `expected fail-fast before timeout, duration=${durationMs}ms`);
});

test("pty driver abortPatterns support maxMatches thresholds", async () => {
  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const payload = {
    command: ["/bin/sh", "-lc", "printf 'loop marker\\n'; sleep 0.05; printf 'loop marker\\n'; sleep 2"],
    env: readStringEnv(process.env),
    steps: [
      {
        pattern: "THIS_PATTERN_SHOULD_NOT_MATCH",
        regex: false,
        timeoutSeconds: 5,
      },
    ],
    abortPatterns: [
      {
        pattern: "loop marker",
        regex: false,
        reason: "repeat_loop",
        maxMatches: 1,
      },
    ],
    timeoutSeconds: 5,
  };

  const startedAt = Date.now();
  const result = await runPythonDriver(driverPath, JSON.stringify(payload));
  const durationMs = Date.now() - startedAt;

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ABORT_PATTERN_MATCHED:repeat_loop/u);
  assert.match(result.stderr, /maxMatches=1/u);
  assert.ok(durationMs < 5_000, `expected threshold fail-fast before timeout, duration=${durationMs}ms`);
});

function readStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function runPythonDriver(
  scriptPath: string,
  payload: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.end(payload, "utf8");
  });
}
