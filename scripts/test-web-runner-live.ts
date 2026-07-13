import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { loadShellAndDotEnv } from "../cli/config/EnvLoader.js";

async function main(): Promise<void> {
  await loadShellAndDotEnv(process.cwd(), {
    preferDotEnvKeys: [
      "OPENROUTER_API_KEY",
      "OPENROUTER_MODEL",
      "OPENROUTER_BASE_URL",
      "OPENROUTER_SITE_URL",
      "OPENROUTER_APP_NAME",
      "KESTREL_RUNNER_SERVICE_HOST",
      "KESTREL_RUNNER_SERVICE_PORT",
      "KESTREL_RUNNER_SERVICE_TOKEN",
    ],
  });

  assertEnv("OPENROUTER_API_KEY");

  const runner = await startWebRunner();
  try {
    process.stdout.write(`[live-web-runner] started ${runner.url}\n`);

    const health = await fetchJson(`${runner.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });

    const profileId = await resolveOpenRouterReferenceProfile(runner.url, runner.token);
    process.stdout.write(`[live-web-runner] using profile ${profileId}\n`);

    await runMemoryContinuityTest({
      baseUrl: runner.url,
      token: runner.token,
      profileId,
    });
    await runToolFollowUpTest({
      baseUrl: runner.url,
      token: runner.token,
      profileId,
    });
  } finally {
    await runner.close();
  }
}

async function resolveOpenRouterReferenceProfile(baseUrl: string, token: string): Promise<string> {
  const response = await fetchJson(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      id: `cmd-profile-list-${randomUUID()}`,
      type: "profile.list",
      metadata: {
        actor: {
          actorId: "live-web-runner",
          actorType: "operator",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {},
    }),
  });

  assert.equal(response.status, 200);
  const body = response.body as {
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
  assert.equal(body.type, "profile.listed");

  const profiles = body.payload?.profiles ?? [];
  const selected =
    profiles.find((item) => item.id === "reference") ??
    profiles.find(
      (item) =>
        item.agent === "reference-react" &&
        item.default === true &&
        (item.modelProvider === "openrouter" || item.modelProvider === undefined),
    );

  assert.notEqual(
    selected,
    undefined,
    `Expected an openrouter-backed reference-react profile, got ${JSON.stringify(profiles)}`,
  );
  return selected.id as string;
}

async function runLiveTurn(input: {
  baseUrl: string;
  token: string;
  profileId: string;
  sessionId: string;
  message: string;
  history?: Array<{
    role: "user" | "assistant" | "system";
    text: string;
    timestamp: string;
  }> | undefined;
}): Promise<{
  runId: string;
  text: string;
  modelCalls: number;
  toolCalls: number;
}> {
  const response = await fetch(`${input.baseUrl}/commands/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.token}`,
      connection: "close",
    },
    body: JSON.stringify({
      id: `cmd-live-web-runner-${randomUUID()}`,
      type: "run.start",
      metadata: {
        actor: {
          actorId: "live-web-runner-user",
          actorType: "end_user",
          displayName: "Live Web Runner Smoke Test",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {
        profileId: input.profileId,
        turn: {
          sessionId: input.sessionId,
          message: input.message,
          eventType: "user.message",
          ...(input.history !== undefined ? { history: input.history } : {}),
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  const events = parseSseEvents(body);
  const terminal = findTerminalEvent(events);

  if (terminal.event === "run.failed") {
    const payload = terminal.data as {
      error?: { code?: string | undefined; message?: string | undefined } | undefined;
    };
    throw new Error(
      `Live web-runner turn failed: ${payload.error?.code ?? "RUN_FAILED"} ${payload.error?.message ?? ""}`.trim(),
    );
  }

  const payload = terminal.data as {
    payload?: {
      result?: {
        output?: {
          runId?: string | undefined;
          status?: string | undefined;
          telemetry?: {
            modelCalls?: number | undefined;
            toolCalls?: number | undefined;
          } | undefined;
        } | undefined;
        assistantText: string | null;
        finalizedPayload?: unknown;
      } | undefined;
    } | undefined;
  };

  const result = payload.payload?.result;
  assert.equal(result?.output?.status, "COMPLETED");

  const text = result?.assistantText ?? undefined;
  assert.match(String(text ?? ""), /\S/u);
  assert.ok((result?.output?.telemetry?.modelCalls ?? 0) > 0, "Expected at least one model call.");

  return {
    runId: String(result?.output?.runId ?? ""),
    text: text as string,
    modelCalls: result?.output?.telemetry?.modelCalls ?? 0,
    toolCalls: result?.output?.telemetry?.toolCalls ?? 0,
  };
}

async function runMemoryContinuityTest(input: {
  baseUrl: string;
  token: string;
  profileId: string;
}): Promise<void> {
  const sessionId = `session-live-web-runner-memory-${randomUUID()}`;
  const secret = `teal-penguin-${randomUUID().slice(0, 8)}`;
  const history: Array<{
    role: "user" | "assistant" | "system";
    text: string;
    timestamp: string;
  }> = [];
  const pushTurn = (userText: string, assistantText: string) => {
    const timestamp = new Date().toISOString();
    history.push(
      { role: "user", text: userText, timestamp },
      { role: "assistant", text: assistantText, timestamp },
    );
  };
  const rememberMessage =
    `Please remember this exact launch code for this conversation: ${secret}. Reply with a short acknowledgment only.`;

  const remember = await runLiveTurn({
    ...input,
    sessionId,
    message: rememberMessage,
  });
  logLiveTurn("memory.remember", remember);
  pushTurn(rememberMessage, remember.text);

  const recallMessage = "What exact launch code did I ask you to remember? Reply with only the code.";

  const recall = await runLiveTurn({
    ...input,
    sessionId,
    message: recallMessage,
    history,
  });
  logLiveTurn("memory.recall", recall);
  pushTurn(recallMessage, recall.text);

  assert.match(recall.text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const constrainMessage = "What color was in that launch code? Answer with just the color word.";

  const constrain = await runLiveTurn({
    ...input,
    sessionId,
    message: constrainMessage,
    history,
  });
  logLiveTurn("memory.extract", constrain);

  assert.match(constrain.text.toLowerCase(), /\bteal\b/u);
}

async function runToolFollowUpTest(input: {
  baseUrl: string;
  token: string;
  profileId: string;
}): Promise<void> {
  const sessionId = `session-live-web-runner-tool-${randomUUID()}`;
  const history: Array<{
    role: "user" | "assistant" | "system";
    text: string;
    timestamp: string;
  }> = [];
  const pushTurn = (userText: string, assistantText: string) => {
    const timestamp = new Date().toISOString();
    history.push(
      { role: "user", text: userText, timestamp },
      { role: "assistant", text: assistantText, timestamp },
    );
  };
  const lookupMessage =
    "Use the free.time.current tool to get the current time in Etc/UTC. Report the timezone and the observed datetime in one short sentence.";

  const lookup = await runLiveTurn({
    ...input,
    sessionId,
    message: lookupMessage,
  });
  logLiveTurn("tool.lookup", lookup);
  pushTurn(lookupMessage, lookup.text);

  assert.ok(lookup.toolCalls > 0, "Expected the live time lookup turn to call at least one tool.");
  assert.match(lookup.text, /\butc\b/i);

  const followUpMessage =
    "Using the result you just got, repeat the timezone and say whether it was UTC. Keep it to one short sentence.";

  const followUp = await runLiveTurn({
    ...input,
    sessionId,
    message: followUpMessage,
    history,
  });
  logLiveTurn("tool.follow_up", followUp);

  assert.match(followUp.text, /\butc\b/i);
  assert.match(followUp.text.toLowerCase(), /\byes\b|\bit was utc\b|\bwas utc\b|\bindeed utc\b|\bis utc\b/u);
}

function logLiveTurn(label: string, result: {
  runId: string;
  text: string;
  modelCalls: number;
  toolCalls: number;
}): void {
  process.stdout.write(
    `[live-web-runner] ${label} completed runId=${result.runId} modelCalls=${result.modelCalls} toolCalls=${result.toolCalls} text=${JSON.stringify(result.text)}\n`,
  );
}

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const blocks = body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  return blocks.map((block) => {
    const event = block
      .split("\n")
      .find((line) => line.startsWith("event: "))
      ?.slice("event: ".length);
    const dataLine = block
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);

    if (event === undefined || dataLine === undefined) {
      throw new Error(`Malformed SSE block:\n${block}`);
    }

    return {
      event,
      data: JSON.parse(dataLine) as unknown,
    };
  });
}

function findTerminalEvent(events: Array<{ event: string; data: unknown }>): { event: string; data: unknown } {
  const terminal = [...events].reverse().find((item) => item.event === "run.completed" || item.event === "run.failed");
  if (terminal === undefined) {
    throw new Error(`Expected terminal run event, got:\n${events.map((item) => item.event).join(", ")}`);
  }
  return terminal;
}

function assertEnv(name: string): void {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for live web-runner smoke tests.`);
  }
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  const body = await response.json() as Record<string, unknown>;
  return {
    status: response.status,
    body,
  };
}

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

async function startWebRunner(): Promise<{
  url: string;
  token: string;
  close(): Promise<void>;
}> {
  const kestrelHome = await mkdtemp(path.join(os.tmpdir(), "kestrel-live-web-runner-"));
  const port = await reservePort();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve(process.cwd(), "cli/tui.ts"),
      "web",
      "--port",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KESTREL_HOME: kestrelHome,
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

  const startupOutput = await waitForOutput(stdoutChunks, /export KESTREL_RUNNER_SERVICE_TOKEN=/u);
  const url = startupOutput.match(/export KESTREL_RUNNER_SERVICE_URL='([^']+)'/u)?.[1];
  const token = startupOutput.match(/export KESTREL_RUNNER_SERVICE_TOKEN='([^']+)'/u)?.[1];
  assert.match(String(url ?? ""), /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(String(token ?? ""), /^[0-9a-f]{48}$/u);

  return {
    url: url as string,
    token: token as string,
    async close() {
      child.kill("SIGINT");
      const exit = await exitPromise;
      await rm(kestrelHome, { recursive: true, force: true });
      assert.equal(exit.code, 0, `kestrel web exited unexpectedly: ${stderrChunks.join("")}`);
    },
  };
}

async function waitForOutput(chunks: string[], pattern: RegExp, timeoutMs = 15_000): Promise<string> {
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

void main().catch((error) => {
  process.stderr.write(`[live-web-runner] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
