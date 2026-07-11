import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
      version: "0.5.1",
    },
    contracts: {
      command: "runner-command-v1",
      events: "dotted-runtime-events-v1",
    },
    capabilities: [
      "events.subscribe",
      "mcp.refresh",
      "operator.control",
      "operator.inspect",
      "profile.read",
      "project.manage",
      "run.cancel",
      "run.resume",
      "run.stream",
      "session.read",
      "task.graph",
      "workspace.checkpoint",
    ],
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
  const exit = await runner.waitForExit(5_000);

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
  const exit = await runner.waitForExit(2_000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(exit.code, 0);
  assert.ok(elapsedMs < 5_000, `Expected second signal to force shutdown before grace timeout, got ${elapsedMs}ms.`);
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
  const port = await reservePort();
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
        KESTREL_LOCAL_CORE_DIRECT: "1",
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
        response.on("data", () => {
          // Keep the stream flowing until the server closes it.
        });
        resolve(req);
      },
    );
    req.once("error", reject);
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
  const args = ["-sS", "--max-time", "5", "-o", "-", "-w", "\n%{http_code}"];
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
  const args = ["-sS", "-N", "--max-time", "5", "-o", "-", "-w", "\n%{http_code}"];
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
              {
                id: "call_fake_finalize",
                type: "function",
                function: {
                  name: "kestrel_finalize",
                  arguments: JSON.stringify({
                    status: "goal_satisfied",
                    message: finalMessage,
                  }),
                },
              },
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
    return undefined;
  }
  const jsonStart = start + startTag.length;
  const end = content.indexOf(endTag, jsonStart);
  if (end < 0) {
    return undefined;
  }
  return content.slice(jsonStart, end).trim();
}

function extractTaggedTextSection(content: string, tagName: string): string | undefined {
  const startTag = `<${tagName}>`;
  const endTag = `</${tagName}>`;
  const start = content.indexOf(startTag);
  if (start < 0) {
    return undefined;
  }
  const valueStart = start + startTag.length;
  const end = content.indexOf(endTag, valueStart);
  if (end < 0) {
    return undefined;
  }
  const value = content.slice(valueStart, end).trim();
  return value.length > 0 ? value : undefined;
}
