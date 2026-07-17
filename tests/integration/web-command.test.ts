import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  EXECUTION_PROTOCOL_VERSION,
  RUNNER_CAPABILITIES,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
} from "../../packages/protocol/src/index.js";
import { LocalCoreClient } from "../../src/localCore/client.js";
import { resolveLocalCorePaths } from "../../src/localCore/home.js";

const execFileAsync = promisify(execFile);
const CURL_REQUEST_TIMEOUT_SECONDS = "5";
const CURL_STREAM_TIMEOUT_SECONDS = "15";
const KESTREL_SUITE_VERSION = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

test("kestrel web prints env exports and answers curl health checks", async (t) => {
  await ensureCurlAvailable();

  const runner = await startWebRunner(t);
  assert.match(runner.startupOutput, /"type":"runner\.service\.started"/u);
  assert.equal(runner.url, `http://127.0.0.1:${runner.port}`);
  assert.match(runner.token, /^[0-9a-f]{48}$/u);

  const health = await runCurlJson({
    url: `${runner.url}/health`,
  });

  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    version: "runner-health-v1",
    ok: true,
    service: {
      name: "kestrel-runner",
      version: KESTREL_SUITE_VERSION,
    },
    contracts: {
      execution: EXECUTION_PROTOCOL_VERSION,
      command: RUNNER_COMMAND_CONTRACT_VERSION,
      events: RUNNER_EVENT_CONTRACT_VERSION,
    },
    capabilities: [...RUNNER_CAPABILITIES],
  });
});

test("kestrel web rejects unauthenticated curl command requests", async (t) => {
  await ensureCurlAvailable();

  const runner = await startWebRunner(t);
  const unauthorized = await runCurlJson({
    url: `${runner.url}/commands`,
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: "cmd-web-unauthorized",
      type: "runner.ping",
      metadata: {
        actor: {
          actorId: "user-1",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {
        nonce: "ok",
      },
    }),
  });

  assert.equal(unauthorized.status, 401);
  const unauthorizedBody = unauthorized.body as {
    type?: string;
    payload?: { message?: string | undefined } | undefined;
  };
  assert.equal(unauthorizedBody.type, "runner.error");
  assert.match(String(unauthorizedBody.payload?.message ?? ""), /authorization is required/i);
});

test("kestrel web answers authenticated curl runner.ping requests", async (t) => {
  await ensureCurlAvailable();

  const runner = await startWebRunner(t);
  const ping = await runCurlJson({
    url: `${runner.url}/commands`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    body: JSON.stringify({
      id: "cmd-web-ping",
      type: "runner.ping",
      metadata: {
        actor: {
          actorId: "user-1",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {
        nonce: "ok",
      },
    }),
  });

  assert.equal(ping.status, 200);
  const pingBody = ping.body as {
    type?: string;
    id?: string | undefined;
    ts?: string | undefined;
    payload?: { nonce?: string | undefined } | undefined;
  };
  assert.equal(pingBody.type, "runner.pong");
  assert.match(String(pingBody.id ?? ""), /./u);
  assert.match(String(pingBody.ts ?? ""), /\d{4}-\d{2}-\d{2}T/u);
  assert.equal(pingBody.payload?.nonce, "ok");
});

test("kestrel web loads project provider credentials before starting Local Core", async () => {
  const root = await mkdtemp(path.join("/tmp", "kestrel-web-dotenv-"));
  const cwd = path.join(root, "project");
  const coreHome = path.join(root, "core-home");
  const corePaths = resolveLocalCorePaths(coreHome);
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, ".env"), "OPENROUTER_API_KEY=dotenv-openrouter-key\n", "utf8");
  const port = await reservePort();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KESTREL_CORE_HOME: coreHome,
    KESTREL_HOME: coreHome,
    // This test exercises project dotenv capture. macOS Local Core deliberately
    // makes Keychain authoritative, so use the portable ambient-credential
    // boundary instead of depending on credentials from the developer's
    // personal Keychain.
    KESTREL_CORE_PLATFORM: "linux",
    KESTREL_LOCAL_CORE_DIRECT: "0",
    KESTREL_CORE_IDLE_TIMEOUT_MS: "600000",
    FORCE_COLOR: "0",
  };
  delete childEnv.OPENROUTER_API_KEY;
  delete childEnv.KESTREL_DISABLE_DOTENV;
  delete childEnv.KESTREL_LOCAL_CORE_API_SOCKET;
  delete childEnv.KESTREL_LOCAL_CORE_API_TOKEN;

  const child = spawn(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.resolve(process.cwd(), "cli/tui.ts"),
      "web",
      "--port",
      String(port),
    ],
    { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
  const exitPromise = waitForClose(child);

  try {
    await waitForOutput(stdoutChunks, /export KESTREL_RUNNER_SERVICE_TOKEN=/u, 30_000);
    const coreToken = (await readFile(corePaths.apiTokenPath, "utf8")).trim();
    const client = new LocalCoreClient({ socketPath: corePaths.apiSocketPath, token: coreToken });
    const readiness = await client.providerReadiness() as {
      providerReadiness?: { openrouter?: { ready?: boolean | undefined } | undefined } | undefined;
    };
    assert.equal(readiness.providerReadiness?.openrouter?.ready, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
    }
    const exit = await exitPromise;
    await stopLocalCoreFromLock(corePaths.lockPath);
    await rm(root, { recursive: true, force: true });
    assert.equal(exit.code, 0, stderrChunks.join(""));
  }
});

test("kestrel web runs quick chat-lane agent interactions against a fake model backend", async (t) => {
  await ensureCurlAvailable();

  const fakeModel = await startFakeOpenRouterServer();
  t.after(async () => {
    await fakeModel.close();
  });

  const runner = await startWebRunner(t, {
    OPENROUTER_API_KEY: "test-openrouter-key",
    OPENROUTER_MODEL: "openai/gpt-5.2-chat",
    OPENROUTER_BASE_URL: fakeModel.url,
  });

  const listed = await runCurlJson({
    url: `${runner.url}/commands`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    body: JSON.stringify({
      id: "cmd-web-profile-list",
      type: "profile.list",
      metadata: {
        actor: {
          actorId: "user-1",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {},
    }),
  });

  assert.equal(listed.status, 200);
  const listedBody = listed.body as {
    type?: string;
    payload?: {
      profiles?: Array<{
        id?: string | undefined;
        agent?: string | undefined;
        modelProvider?: string | undefined;
        default?: boolean | undefined;
      }> | undefined;
    } | undefined;
  };
  assert.equal(listedBody.type, "profile.listed");
  const availableProfiles = listedBody.payload?.profiles ?? [];
  const selectedProfile =
    availableProfiles.find((item) => item.id === "reference") ??
    availableProfiles.find(
      (item) =>
        item.agent === "reference-react" &&
        item.default === true &&
        (item.modelProvider === "openrouter" || item.modelProvider === undefined),
    );

  assert.notEqual(
    selectedProfile,
    undefined,
    `Expected an openrouter-backed reference-react profile, got ${JSON.stringify(availableProfiles)}`,
  );
  if (selectedProfile === undefined) {
    throw new Error(`Expected an openrouter-backed reference-react profile, got ${JSON.stringify(availableProfiles)}`);
  }
  const profileId = selectedProfile.id;
  const greetingSessionId = `session-web-chat-greeting-${randomUUID()}`;
  const capabilitiesSessionId = `session-web-chat-capabilities-${randomUUID()}`;

  const actorMetadata = {
    actor: {
      actorId: "user-1",
      actorType: "end_user",
      displayName: "Web Runner Test User",
      tenantId: "internal",
    },
    tenantId: "internal",
  };

  const greeting = await runCurlText({
    url: `${runner.url}/commands/stream`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    body: JSON.stringify({
      id: "cmd-web-chat-greeting",
      type: "run.start",
      metadata: actorMetadata,
      payload: {
        profileId,
        turn: {
          sessionId: greetingSessionId,
          message: "hiya",
          eventType: "user.message",
        },
      },
    }),
  });

  assert.equal(greeting.status, 200);
  assert.match(greeting.body, /event: run\.started/u);
  assert.match(greeting.body, /event: run\.completed/u);
  assert.match(greeting.body, /Hello from the fake web runner chat path\./u);

  const capabilities = await runCurlText({
    url: `${runner.url}/commands/stream`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runner.token}`,
    },
    body: JSON.stringify({
      id: "cmd-web-chat-capabilities",
      type: "run.start",
      metadata: actorMetadata,
      payload: {
        profileId,
        turn: {
          sessionId: capabilitiesSessionId,
          message: "what tools do you have",
          eventType: "user.message",
        },
      },
    }),
  });

  assert.equal(capabilities.status, 200);
  assert.match(capabilities.body, /event: run\.started/u);
  assert.match(capabilities.body, /event: run\.completed/u);
  assert.match(capabilities.body, /I can help with chat responses in this deterministic test harness\./u);

  assert.deepEqual(
    fakeModel.requests.map((item) => item.schemaName),
    [
      "tool_call",
      "tool_call",
    ],
  );
  assert.equal(fakeModel.requests.length, 2);
  assert.equal(fakeModel.requests[0]?.userMessage, "hiya");
  assert.equal(fakeModel.requests[1]?.userMessage, "what tools do you have");
});

test("kestrel web forces shutdown after the grace period when an event stream is still connected", async (t) => {
  const runner = await startWebRunner(
    t,
    {
      KESTREL_RUNNER_SERVICE_SHUTDOWN_GRACE_MS: "200",
    },
    false,
  );
  const subscription = await openEventSubscription(runner.url, runner.token, `session-web-shutdown-${randomUUID()}`);
  t.after(() => {
    subscription.close();
  });

  runner.signal("SIGINT");
  const exit = await runner.waitForExit(5000);

  assert.equal(exit.code, 0);
  assert.match(runner.stderrOutput(), /shutting down gracefully/u);
  assert.match(runner.stderrOutput(), /shutdown grace period elapsed; forcing shutdown/u);
  assert.match(runner.stderrOutput(), /runner service stopped/u);
});

test("kestrel web forces shutdown immediately on a second signal", async (t) => {
  const runner = await startWebRunner(
    t,
    {
      KESTREL_RUNNER_SERVICE_SHUTDOWN_GRACE_MS: "5000",
    },
    false,
  );
  const subscription = await openEventSubscription(runner.url, runner.token, `session-web-signal-${randomUUID()}`);
  t.after(() => {
    subscription.close();
  });

  const startedAt = Date.now();
  runner.signal("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 50));
  runner.signal("SIGINT");
  const exit = await runner.waitForExit(2000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(exit.code, 0);
  assert.ok(elapsedMs < 5000, `Expected second signal to force shutdown before grace timeout, got ${elapsedMs}ms.`);
  assert.match(runner.stderrOutput(), /received another shutdown signal; forcing shutdown/u);
  assert.match(runner.stderrOutput(), /runner service stopped/u);
});

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to reserve an ephemeral port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForOutput(chunks: string[], pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const joined = chunks.join("");
    if (pattern.test(joined)) {
      return joined;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for output matching ${pattern.toString()}`);
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function ensureCurlAvailable(): Promise<void> {
  try {
    await execFileAsync("curl", ["--version"], {
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`test:web-runner requires curl to be installed: ${message}`);
  }
}

async function startWebRunner(
  t: TestContext,
  envOverrides: NodeJS.ProcessEnv = {},
  autoShutdownSignal: NodeJS.Signals | false = "SIGINT",
): Promise<{
  port: number;
  url: string;
  token: string;
  startupOutput: string;
  signal(signal: NodeJS.Signals): void;
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrOutput(): string;
}> {
  const repoRoot = process.cwd();
  const kestrelHome = await mkdtemp(path.join(os.tmpdir(), "kestrel-web-command-"));
  const corePaths = resolveLocalCorePaths(kestrelHome);
  const port = await reservePort();
  const coreStderrChunks: string[] = [];
  const core = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve(repoRoot, "src/localCore/daemonMain.ts"),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...envOverrides,
        KESTREL_HOME: kestrelHome,
        // The web-runner fixture supplies isolated ambient credentials. Avoid
        // coupling it to the host developer's macOS Keychain.
        KESTREL_CORE_PLATFORM: "linux",
        KESTREL_DISABLE_DOTENV: "1",
        KESTREL_LOCAL_CORE_DIRECT: "0",
        KESTREL_LOCAL_CORE_DAEMON: "1",
        KESTREL_CORE_VERSION: KESTREL_SUITE_VERSION,
        KESTREL_CORE_OWNER_EXECUTABLE: path.resolve(repoRoot, "src/localCore/daemonMain.ts"),
        KESTREL_CORE_REPO_ROOT: repoRoot,
        KESTREL_CORE_RUN_MIGRATIONS: "1",
        KESTREL_CORE_IDLE_TIMEOUT_MS: "600000",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const coreExitPromise = waitForClose(core);
  core.stderr.on("data", (chunk) => {
    coreStderrChunks.push(chunk.toString("utf8"));
  });
  let coreToken: string;
  try {
    coreToken = await waitForLocalCoreReady({
      socketPath: corePaths.apiSocketPath,
      tokenPath: corePaths.apiTokenPath,
      exitPromise: coreExitPromise,
      stderrChunks: coreStderrChunks,
    });
  } catch (error) {
    if (core.exitCode === null && core.signalCode === null) {
      core.kill("SIGTERM");
    }
    await coreExitPromise;
    await rm(kestrelHome, { recursive: true, force: true });
    throw error;
  }
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve(repoRoot, "cli/tui.ts"),
      "web",
      "--port",
      String(port),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...envOverrides,
        KESTREL_HOME: kestrelHome,
        KESTREL_DISABLE_DOTENV: "1",
        KESTREL_LOCAL_CORE_DIRECT: "0",
        KESTREL_LOCAL_CORE_API_SOCKET: corePaths.apiSocketPath,
        KESTREL_LOCAL_CORE_API_TOKEN: coreToken,
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const exitPromise = waitForClose(child);

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  t.after(async () => {
    if (autoShutdownSignal !== false && child.exitCode === null && child.signalCode === null) {
      child.kill(autoShutdownSignal);
    } else if (autoShutdownSignal === false && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    const exit = await exitPromise;
    if (autoShutdownSignal !== false) {
      assert.equal(exit.code, 0);
      assert.match(stderrChunks.join(""), /runner service stopped/u);
    }
    if (core.exitCode === null && core.signalCode === null) {
      core.kill("SIGTERM");
    }
    await coreExitPromise;
    // The runner may have replaced an incompatible fixture daemon. This
    // isolated home belongs to the test, so stop whichever daemon currently
    // owns its lock before deleting the home.
    await stopLocalCoreFromLock(corePaths.lockPath);
    await rm(kestrelHome, { recursive: true, force: true });
  });

  const startupOutput = await waitForOutput(stdoutChunks, /export KESTREL_RUNNER_SERVICE_TOKEN=/u);
  const url = startupOutput.match(/export KESTREL_RUNNER_SERVICE_URL='([^']+)'/u)?.[1];
  const token = startupOutput.match(/export KESTREL_RUNNER_SERVICE_TOKEN='([^']+)'/u)?.[1];

  if (url === undefined || token === undefined) {
    throw new Error(`Expected launcher output to include URL and token exports.\n${startupOutput}`);
  }

  return {
    port,
    url,
    token,
    startupOutput,
    signal(signal: NodeJS.Signals) {
      child.kill(signal);
    },
    async waitForExit(timeoutMs = 10_000) {
      return await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Timed out waiting ${timeoutMs}ms for kestrel web to exit.`));
          }, timeoutMs);
        }),
      ]);
    },
    stderrOutput() {
      return stderrChunks.join("");
    },
  };
}

async function waitForLocalCoreReady(input: {
  socketPath: string;
  tokenPath: string;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderrChunks: string[];
}): Promise<string> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 30_000) {
    const exited = await Promise.race([
      input.exitPromise.then((result) => ({ result })),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 25)),
    ]);
    if (exited !== undefined) {
      throw new Error(
        `Local Core exited before becoming ready: ${JSON.stringify(exited.result)} ${input.stderrChunks.join("")}`,
      );
    }
    try {
      const normalizedToken = (await readFile(input.tokenPath, "utf8")).trim();
      if (normalizedToken.length === 0) {
        throw new Error("Local Core token was empty.");
      }
      const client = new LocalCoreClient({
        socketPath: input.socketPath,
        token: normalizedToken,
        timeoutMs: 2000,
      });
      await client.status();
      return normalizedToken;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Timed out waiting for Local Core: ${lastError instanceof Error ? lastError.message : String(lastError)} ${input.stderrChunks.join("")}`,
  );
}

async function stopLocalCoreFromLock(lockPath: string): Promise<void> {
  let ownerPid: number | undefined;
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { ownerPid?: unknown };
    ownerPid = typeof lock.ownerPid === "number" ? lock.ownerPid : undefined;
  } catch {
    return;
  }
  if (ownerPid === undefined) {
    return;
  }
  try {
    process.kill(ownerPid, "SIGTERM");
  } catch {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      process.kill(ownerPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Local Core pid ${ownerPid} did not stop.`);
}

async function openEventSubscription(
  runnerUrl: string,
  runnerToken: string,
  sessionId: string,
): Promise<{ close(): void }> {
  const request = await new Promise<ClientRequest>((resolve, reject) => {
    const body = JSON.stringify({
      filter: {
        sessionId,
      },
      metadata: {
        actor: {
          actorId: "user-1",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
    });
    const target = new URL(`${runnerUrl}/events/stream`);
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runnerToken}`,
          "content-length": Buffer.byteLength(body).toString(),
        },
      },
      (response) => {
        req.setTimeout(0);
        response.on("data", () => {
          // Keep the stream flowing until the server closes it.
        });
        resolve(req);
      },
    );
    req.once("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("Timed out waiting for the web runner event subscription."));
    });
    req.end(body);
  });

  return {
    close() {
      request.destroy();
    },
  };
}

async function runCurlJson(input: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const args = ["-sS", "--max-time", CURL_REQUEST_TIMEOUT_SECONDS, "-o", "-", "-w", "\n%{http_code}"];
  if (input.method !== undefined && input.method !== "GET") {
    args.push("-X", input.method);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    args.push("-H", `${name}: ${value}`);
  }
  if (input.body !== undefined) {
    args.push("--data", input.body);
  }
  args.push(input.url);

  const result = await execFileAsync("curl", args, {
    cwd: process.cwd(),
    env: process.env,
  });
  const stdout = result.stdout.trimEnd();
  const newline = stdout.lastIndexOf("\n");
  if (newline === -1) {
    throw new Error(`curl response was missing an HTTP status line for ${input.url}`);
  }

  const rawBody = stdout.slice(0, newline);
  const rawStatus = stdout.slice(newline + 1);
  const status = Number.parseInt(rawStatus, 10);
  if (Number.isFinite(status) === false) {
    throw new Error(`curl response returned invalid HTTP status '${rawStatus}' for ${input.url}`);
  }

  return {
    status,
    body: JSON.parse(rawBody) as Record<string, unknown>,
  };
}

async function runCurlText(input: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const args = ["-sS", "-N", "--max-time", CURL_STREAM_TIMEOUT_SECONDS, "-o", "-", "-w", "\n%{http_code}"];
  if (input.method !== undefined && input.method !== "GET") {
    args.push("-X", input.method);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    args.push("-H", `${name}: ${value}`);
  }
  if (input.body !== undefined) {
    args.push("--data", input.body);
  }
  args.push(input.url);

  const result = await execFileAsync("curl", args, {
    cwd: process.cwd(),
    env: process.env,
  });
  const stdout = result.stdout.trimEnd();
  const newline = stdout.lastIndexOf("\n");
  if (newline === -1) {
    throw new Error(`curl response was missing an HTTP status line for ${input.url}`);
  }

  const rawBody = stdout.slice(0, newline);
  const rawStatus = stdout.slice(newline + 1);
  const status = Number.parseInt(rawStatus, 10);
  if (Number.isFinite(status) === false) {
    throw new Error(`curl response returned invalid HTTP status '${rawStatus}' for ${input.url}`);
  }

  return {
    status,
    body: rawBody,
  };
}

async function startFakeOpenRouterServer(): Promise<{
  url: string;
  requests: Array<{ schemaName: string; userMessage: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ schemaName: string; userMessage: string }> = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((request, response) => {
    void handleFakeOpenRouterRequest(request, response, requests);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to start fake OpenRouter server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleFakeOpenRouterRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<{ schemaName: string; userMessage: string }>,
): Promise<void> {
  const body = await readRequestBody(request);
  const parsed = JSON.parse(body) as {
    metadata?: { schemaName?: string | undefined } | undefined;
    response_format?: { json_schema?: { name?: string | undefined } | undefined } | undefined;
    tools?: unknown[] | undefined;
    messages?: Array<{ content?: string | undefined }> | undefined;
    stream?: boolean | undefined;
  };

  const schemaName = parsed.response_format?.json_schema?.name ?? parsed.metadata?.schemaName ??
    (Array.isArray(parsed.tools) ? "tool_call" : undefined);
  const lastMessage = parsed.messages?.at(-1)?.content;
  const parsedMessage =
    typeof lastMessage === "string"
      ? parseFakeModelMessage(lastMessage)
      : {};
  const userMessage =
    parsedMessage.userMessage ??
    (typeof lastMessage === "string" ? lastMessage : "");

  if (schemaName === undefined) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "missing response schema name" }));
    return;
  }

  requests.push({ schemaName, userMessage });

  const finalMessage = userMessage.includes("tools")
    ? "I can help with chat responses in this deterministic test harness."
    : "Hello from the fake web runner chat path.";
  if (schemaName !== "tool_call" && schemaName !== "kestrel_agent_action") {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `unsupported schema '${schemaName}'` }));
    return;
  }

  const toolCall = {
    id: "call_fake_finalize",
    type: "function",
    function: {
      name: "kestrel_finalize",
      arguments: JSON.stringify({
        status: "goal_satisfied",
        message: finalMessage,
        assistantProgress: "I have completed the deterministic test response.",
      }),
    },
  };

  if (parsed.stream === true) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "close",
    });
    response.end(
      `data: ${JSON.stringify({
        model: "openai/gpt-5.2-chat",
        choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }],
      })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(
    JSON.stringify({
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content: JSON.stringify({
              reason: "This deterministic test path can answer directly without tools.",
            }),
            tool_calls: [
              toolCall,
            ],
          },
        },
      ],
    }),
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFakeModelMessage(content: string): { userMessage?: string | undefined } {
  const contextJson = extractContextJson(content);
  if (contextJson !== undefined) {
    try {
      const parsed = JSON.parse(contextJson) as {
        userMessage?: string | undefined;
        goal?: string | undefined;
        taskInstruction?: string | undefined;
        latestUserTurn?: string | undefined;
      };
      return {
        userMessage: parsed.latestUserTurn ?? parsed.taskInstruction ?? parsed.userMessage ?? parsed.goal,
      };
    } catch {
      return {
        userMessage: content,
      };
    }
  }

  const taskInstruction = extractTaggedTextSection(content, "task_instruction");
  const latestUserTurn = extractTaggedTextSection(content, "latest_user_turn");
  if (taskInstruction !== undefined || latestUserTurn !== undefined) {
    return {
      userMessage: latestUserTurn ?? taskInstruction,
    };
  }

  try {
    const parsed = JSON.parse(content) as {
      userMessage?: string | undefined;
      goal?: string | undefined;
      taskInstruction?: string | undefined;
      latestUserTurn?: string | undefined;
    };
    return {
      userMessage: parsed.latestUserTurn ?? parsed.taskInstruction ?? parsed.userMessage ?? parsed.goal,
    };
  } catch {
    return {
      userMessage: content,
    };
  }
}

function extractContextJson(content: string): string | undefined {
  const startTag = "<context_json>";
  const endTag = "</context_json>";
  const start = content.indexOf(startTag);
  if (start < 0) {
    return ;
  }
  const jsonStart = start + startTag.length;
  const end = content.indexOf(endTag, jsonStart);
  if (end < 0) {
    return ;
  }
  return content.slice(jsonStart, end).trim();
}

function extractTaggedTextSection(content: string, tagName: string): string | undefined {
  const startTag = `<${tagName}>`;
  const endTag = `</${tagName}>`;
  const start = content.indexOf(startTag);
  if (start < 0) {
    return ;
  }
  const valueStart = start + startTag.length;
  const end = content.indexOf(endTag, valueStart);
  if (end < 0) {
    return ;
  }
  const value = content.slice(valueStart, end).trim();
  return value.length > 0 ? value : undefined;
}
