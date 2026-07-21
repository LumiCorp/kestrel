import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createRunnerServiceServer } from "../../../cli/runner/RunnerService.js";
import {
  createProfileProvider,
  createSdkE2eRuntimeFactory,
  packPackage,
  runChildProcess,
  writePnpmWorkspaceOverrides,
} from "./helpers.js";
import { contractTest } from "../../helpers/contract-test.js";


contractTest("runtime.process", "installed @kestrel-agents/next package builds and runs inside a real Next app fixture", async (t) => {
  const abortedSessions: string[] = [];
  const server = await createRunnerServiceServer({
    profileProvider: createProfileProvider(),
    runtimeFactory: createSdkE2eRuntimeFactory({
      onAbort(sessionId) {
        abortedSessions.push(sessionId);
      },
    }),
  });
  t.after(async () => {
    await server.close();
  });

  const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-next-app-pack-"));
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-next-app-fixture-"));
  const storeDir = path.join(os.tmpdir(), "kestrel-next-app-pnpm-store");
  t.after(() => {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const protocolTarball = packPackage(path.join(process.cwd(), "packages/protocol"), packDir);
  const sdkTarball = packPackage(path.join(process.cwd(), "packages/sdk"), packDir);
  const nextTarball = packPackage(path.join(process.cwd(), "packages/next"), packDir);

  writeFixtureApp(fixtureDir, { protocolTarball, sdkTarball, nextTarball });

  await runChildProcess("pnpm", ["install"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      npm_config_store_dir: storeDir,
    },
  });
  await runChildProcess("pnpm", ["build"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      RUNNER_URL: server.url,
    },
  });

  const port = await reservePort();
  const app = spawn("pnpm", ["exec", "next", "start", "-p", String(port)], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      RUNNER_URL: server.url,
    },
    stdio: "pipe",
  });
  let appStdout = "";
  let appStderr = "";
  let appExitCode: number | null = null;
  let appExitSignal: NodeJS.Signals | null = null;
  app.stdout.on("data", (chunk) => {
    appStdout += String(chunk);
  });
  app.stderr.on("data", (chunk) => {
    appStderr += String(chunk);
  });
  app.once("exit", (code, signal) => {
    appExitCode = code;
    appExitSignal = signal;
  });
  t.after(() => {
    app.kill("SIGTERM");
  });

  await waitForHttp(`http://127.0.0.1:${port}`, () => ({
    exitCode: appExitCode,
    exitSignal: appExitSignal,
    stdout: appStdout,
    stderr: appStderr,
  }));

  const jsonResponse = await fetch(`http://127.0.0.1:${port}/api/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "next-fixture-request",
      "x-correlation-id": "next-fixture-correlation",
    },
    body: JSON.stringify({
      sessionId: "next-fixture-json",
      message: "hello from next fixture",
    }),
  });
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get("x-kestrel-request-id"), "next-fixture-request");
  assert.equal(jsonResponse.headers.get("x-kestrel-correlation-id"), "next-fixture-correlation");
  assert.equal((await jsonResponse.json() as { type: string }).type, "run.completed");

  const webhookResponse = await fetch(`http://127.0.0.1:${port}/api/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "next-fixture-webhook",
      message: "webhook payload",
    }),
  });
  assert.equal(webhookResponse.status, 200);
  assert.equal((await webhookResponse.json() as { type: string }).type, "run.completed");

  const streamController = new AbortController();
  const streamResponse = await fetch(`http://127.0.0.1:${port}/api/agent/stream`, {
    method: "POST",
    signal: streamController.signal,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "next-fixture-stream",
      message: "cancel me",
    }),
  });
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body?.getReader();
  assert.ok(reader, "stream route should expose a response body");
  await reader.read();
  streamController.abort();

  await waitFor(() => abortedSessions.includes("next-fixture-stream"), 10_000, "Next fixture did not propagate request abort to the runner.");
});

function writeFixtureApp(
  fixtureDir: string,
  tarballs: {
    protocolTarball: string;
    sdkTarball: string;
    nextTarball: string;
  },
): void {
  mkdirSync(path.join(fixtureDir, "app", "api", "agent", "stream"), { recursive: true });
  mkdirSync(path.join(fixtureDir, "app", "api", "agent"), { recursive: true });
  mkdirSync(path.join(fixtureDir, "app", "api", "webhook"), { recursive: true });
  mkdirSync(path.join(fixtureDir, "lib"), { recursive: true });

  writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({
    name: "kestrel-next-runtime-fixture",
    private: true,
    type: "module",
    packageManager: "pnpm@9.12.2",
    pnpm: {
      overrides: {
        "@kestrel-agents/protocol": tarballs.protocolTarball,
        "@kestrel-agents/sdk": tarballs.sdkTarball,
      },
    },
    dependencies: {
      next: "15.5.3",
      react: "19.2.4",
      "react-dom": "19.2.4",
      "@kestrel-agents/protocol": tarballs.protocolTarball,
      "@kestrel-agents/sdk": tarballs.sdkTarball,
      "@kestrel-agents/next": tarballs.nextTarball,
    },
    scripts: {
      build: "next build",
      start: "next start",
    },
  }, null, 2));
  writePnpmWorkspaceOverrides(fixtureDir, {
    "@kestrel-agents/protocol": tarballs.protocolTarball,
    "@kestrel-agents/sdk": tarballs.sdkTarball,
  }, {
    allowBuilds: {
      sharp: true,
    },
  });

  writeFileSync(path.join(fixtureDir, "next.config.mjs"), "export default {};\n");
  writeFileSync(path.join(fixtureDir, "app", "layout.js"), `
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`);
  writeFileSync(path.join(fixtureDir, "app", "page.js"), "export default function Page() { return 'ok'; }\n");
  writeFileSync(path.join(fixtureDir, "lib", "agent.js"), `
import { createAgent } from "@kestrel-agents/sdk";

export const agent = createAgent({
  id: "next-fixture-agent",
  profileId: "reference",
  target: { kind: "remote", baseUrl: process.env.RUNNER_URL },
});

export function resolveContext() {
  return {
    actor: {
      actorId: "next-fixture-user",
      actorType: "end_user",
      tenantId: "acme",
    },
    tenantId: "acme",
  };
}
`);
  writeFileSync(path.join(fixtureDir, "app", "api", "agent", "route.js"), `
import { createJsonRunRouteHandler } from "@kestrel-agents/next";
import { agent, resolveContext } from "../../../lib/agent.js";

export const POST = createJsonRunRouteHandler({
  agent,
  resolveContext,
});
`);
  writeFileSync(path.join(fixtureDir, "app", "api", "agent", "stream", "route.js"), `
import { createStreamRunRouteHandler } from "@kestrel-agents/next";
import { agent, resolveContext } from "../../../../lib/agent.js";

export const POST = createStreamRunRouteHandler({
  agent,
  resolveContext,
});
`);
  writeFileSync(path.join(fixtureDir, "app", "api", "webhook", "route.js"), `
import { createWebhookRunRouteHandler } from "@kestrel-agents/next";
import { agent, resolveContext } from "../../../lib/agent.js";

export const POST = createWebhookRunRouteHandler({
  agent,
  resolveContext,
  mapPayload(payload) {
    return {
      sessionId: payload.sessionId,
      message: payload.message,
    };
  },
});
`);
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHttp(
  url: string,
  readProcessState: () => {
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  },
): Promise<void> {
  await waitFor(async () => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      const state = readProcessState();
      if (state.exitCode !== null || state.exitSignal !== null) {
        throw new Error([
          `Next fixture exited before serving ${url}.`,
          `exitCode=${state.exitCode ?? "null"}`,
          `signal=${state.exitSignal ?? "null"}`,
          state.stdout.length > 0 ? `stdout:\n${state.stdout}` : "",
          state.stderr.length > 0 ? `stderr:\n${state.stderr}` : "",
        ].filter((line) => line.length > 0).join("\n"));
      }
      return false;
    }
  }, 30_000, `Next fixture did not start at ${url}.`);
}

async function waitFor(
  condition: (() => boolean | Promise<boolean>),
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}
