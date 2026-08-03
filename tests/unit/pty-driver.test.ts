import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";


test("pty driver abortPatterns fail fast with explicit reason", async () => {
  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const payload = {
    command: ["/bin/sh", "-lc", "printf 'boot\\n'; sleep 0.05; printf 'fatal marker\\n'; sleep 2"],
    env: readStringEnv(process.env),
    steps: [
      {
        pattern: "THIS_PATTERN_SHOULD_NOT_MATCH",
        regex: false,
      },
    ],
    abortPatterns: [
      {
        pattern: "fatal marker",
        regex: false,
        reason: "fatal_marker",
      },
    ],
  };

  const result = await runPythonDriver(driverPath, JSON.stringify(payload));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ABORT_PATTERN_MATCHED:fatal_marker/u);
  assert.doesNotMatch(result.stderr, /Timed out waiting/u);
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
  };

  const result = await runPythonDriver(driverPath, JSON.stringify(payload));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ABORT_PATTERN_MATCHED:repeat_loop/u);
  assert.match(result.stderr, /maxMatches=1/u);
});

test("pty driver honors readiness step timeouts", async () => {
  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const payload = {
    command: ["/bin/sh", "-lc", "sleep 2"],
    env: readStringEnv(process.env),
    steps: [
      {
        pattern: "READY",
        regex: false,
        timeoutSeconds: 0.1,
      },
    ],
    abortPatterns: [],
  };

  const result = await runPythonDriver(driverPath, JSON.stringify(payload));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Timed out after 0\.1 seconds waiting for 'READY'/u);
});

test("pty driver reports readiness and rejects an unexpected child exit", async () => {
  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const driver = startInteractivePythonDriver(driverPath, {
    command: ["/bin/sh", "-lc", "printf 'READY\\n'; sleep 0.05; exit 7"],
    env: readStringEnv(process.env),
    steps: [
      {
        pattern: "READY",
        regex: false,
        timeoutSeconds: 1,
      },
    ],
    abortPatterns: [],
    emitStatusEvents: true,
  });

  const result = await driver.result;

  assert.equal(result.exitCode, 1);
  await assert.rejects(
    driver.waitForStderr('"type":"missing"'),
    /PTY driver exited with code 1 before the expected stderr marker/u,
  );
  assert.match(
    result.stderr,
    /__KESTREL_PTY_STATUS__\{"type":"step_matched","stepIndex":0\}/u,
  );
  assert.match(result.stderr, /TUI exited before termination was requested/u);
});

test("pty driver accepts explicit termination after readiness", async () => {
  const driverPath = path.resolve(process.cwd(), "tests/ops/helpers/pty_driver.py");
  const driver = startInteractivePythonDriver(driverPath, {
    command: ["/bin/sh", "-lc", "trap '' INT; printf 'READY\\n'; while :; do sleep 1; done"],
    env: readStringEnv(process.env),
    steps: [
      {
        pattern: "READY",
        regex: false,
        timeoutSeconds: 1,
      },
    ],
    abortPatterns: [],
    emitStatusEvents: true,
  });

  await driver.waitForStderr('"type":"step_matched"');
  driver.sendControl({ type: "terminate" });
  const result = await driver.result;

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(
    result.stderr,
    /__KESTREL_PTY_STATUS__\{"type":"termination","reason":"requested"\}/u,
  );
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

function startInteractivePythonDriver(
  scriptPath: string,
  payload: Record<string, unknown>,
): {
  result: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  sendControl(command: Record<string, unknown>): void;
  waitForStderr(pattern: string): Promise<void>;
} {
  const child = spawn("python3", [scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let terminalError: Error | undefined;
  const stderrWaiters: Array<{
    pattern: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const rejectStderrWaiters = (error: Error) => {
    for (const waiter of stderrWaiters.splice(0)) {
      waiter.reject(error);
    }
  };
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    for (const waiter of stderrWaiters.splice(0)) {
      if (stderr.includes(waiter.pattern)) {
        waiter.resolve();
      } else {
        stderrWaiters.push(waiter);
      }
    }
  });
  const result = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      child.on("error", (error) => {
        terminalError = error;
        rejectStderrWaiters(error);
        reject(error);
      });
      child.on("close", (code) => {
        terminalError ??= new Error(
          `PTY driver exited with code ${code ?? 1} before the expected stderr marker.\n${stderr}`,
        );
        rejectStderrWaiters(terminalError);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });
    },
  );
  child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  return {
    result,
    sendControl(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`, "utf8");
      child.stdin.end();
    },
    async waitForStderr(pattern) {
      if (stderr.includes(pattern)) {
        return;
      }
      if (terminalError !== undefined) {
        throw terminalError;
      }
      await new Promise<void>((resolve, reject) => {
        stderrWaiters.push({ pattern, resolve, reject });
      });
    },
  };
}
