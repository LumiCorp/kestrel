import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  createTerminalBenchDevShellServiceFromEnv,
  TerminalBenchDevShellService,
} from "../../src/devshell/TerminalBenchDevShellService.js";

test("TerminalBenchDevShellService maps process calls to bridge HTTP endpoints", async () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const server = http.createServer(async (request, response) => {
    const body = await readJsonBody(request);
    calls.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      ...(body !== undefined ? { body } : {}),
    });

    response.setHeader("content-type", "application/json");
    if (request.url === "/shell/run") {
      response.end(JSON.stringify({
        status: "COMPLETED",
        stdout: "ran",
        text: "ran",
        truncated: false,
        exitCode: 0,
      }));
      return;
    }
    if (request.url === "/processes/start") {
      response.end(JSON.stringify({
        processId: "proc-1",
        submittedAt: "2026-04-27T00:00:01.000Z",
        startedAt: "2026-04-27T00:00:01.000Z",
        updatedAt: "2026-04-27T00:00:01.000Z",
        status: "RUNNING",
        text: "ready",
        truncated: false,
      }));
      return;
    }
    if (request.url === "/processes/proc-1/write") {
      response.end(JSON.stringify({
        processId: "proc-1",
        status: "ACCEPTED",
        bytesWritten: 7,
      }));
      return;
    }
    if (request.url === "/processes/proc-1/write_and_read") {
      response.end(JSON.stringify({
        processId: "proc-1",
        status: "RUNNING",
        text: "got:move E\n",
        truncated: false,
        cursor: 5,
        nextCursor: 16,
        bytesWritten: 7,
      }));
      return;
    }
    if (request.url === "/processes/proc-1/read?waitMs=10&maxBytes=100") {
      response.end(JSON.stringify({
        status: "COMPLETED",
        exitCode: 0,
        text: "done",
        truncated: false,
      }));
      return;
    }
    if (request.url === "/processes/proc-1/stop") {
      response.end(JSON.stringify({
        status: "STOPPED",
        text: "",
        truncated: false,
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  const baseUrl = await listen(server);
  const service = new TerminalBenchDevShellService(baseUrl);

  assert.equal((await service.runCommand({ workspaceRoot: "/app", command: "pwd" })).text, "ran");
  assert.equal((await service.startProcess({ workspaceRoot: "/app", command: "python3 game.py" })).processId, "proc-1");
  assert.equal((await service.writeProcess({ processId: "proc-1", data: "move N\n" })).status, "ACCEPTED");
  assert.equal((await service.writeAndReadProcess({ processId: "proc-1", data: "move E\n" })).text, "got:move E\n");
  assert.equal((await service.readProcess({ processId: "proc-1", waitMs: 10, maxBytes: 100 })).exitCode, 0);
  assert.equal((await service.stopProcess({ processId: "proc-1" })).status, "STOPPED");

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      "POST /shell/run",
      "POST /processes/start",
      "POST /processes/proc-1/write",
      "POST /processes/proc-1/write_and_read",
      "GET /processes/proc-1/read?waitMs=10&maxBytes=100",
      "POST /processes/proc-1/stop",
    ],
  );

  await close(server);
});

test("TerminalBenchDevShellService returns bridge HTTP failures as lost process results", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ code: "BRIDGE_DOWN", message: "bridge unavailable" }));
  });
  const baseUrl = await listen(server);
  const service = new TerminalBenchDevShellService(baseUrl);

  const result = await service.readProcess({ processId: "proc-1" });

  assert.equal(result.status, "LOST");
  assert.equal(result.processId, "proc-1");
  assert.equal(result.cursor, 0);
  assert.equal(result.nextCursor, 0);
  assert.match(result.text, /bridge unavailable/u);
  assert.match(result.failureReason ?? "", /bridge unavailable/u);

  await close(server);
});

test("TerminalBenchDevShellService returns fetch failures as dev shell run results", async () => {
  const server = http.createServer((_request, response) => {
    response.end("{}");
  });
  const baseUrl = await listen(server);
  await close(server);
  const service = new TerminalBenchDevShellService(baseUrl);

  const result = await service.runCommand({ workspaceRoot: "/app", command: "printf ok" });

  assert.equal(result.status, "LOST");
  assert.equal(result.stdout, "");
  assert.match(result.text, /bridge request failed/u);
  assert.match(result.failureReason ?? "", /bridge request failed/u);
});

test("TerminalBenchDevShellService returns invalid bridge JSON as failed writes", async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("{not-json");
  });
  const baseUrl = await listen(server);
  const service = new TerminalBenchDevShellService(baseUrl);

  const result = await service.writeProcess({ processId: "proc-1", data: "x\n" });

  assert.equal(result.status, "FAILED");
  assert.equal(result.processId, "proc-1");
  assert.equal(result.bytesWritten, 0);
  assert.match(result.message ?? "", /invalid JSON/u);

  await close(server);
});

test("TerminalBenchDevShellService returns expected sandbox denials as failed process results", async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      status: "FAILED",
      exitCode: 126,
      text: "Terminal-Bench protected path is not available to agent shell commands.",
      truncated: false,
      securityMode: "blocked_protected_path",
    }));
  });
  const baseUrl = await listen(server);
  const service = new TerminalBenchDevShellService(baseUrl);

  const result = await service.runCommand({
    workspaceRoot: "/app",
    cwd: "/app",
    command: "cat /protected/ground_truth_map.txt",
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.exitCode, 126);
  assert.equal(result.securityMode, "blocked_protected_path");
  assert.match(result.text, /protected path is not available/u);

  await close(server);
});

test("TerminalBenchDevShellService uses only generic dev shell bridge env", () => {
  const service = createTerminalBenchDevShellServiceFromEnv({
    KESTREL_DEV_SHELL_BRIDGE_URL: "http://127.0.0.1:1234",
  } as NodeJS.ProcessEnv);

  assert.equal(service instanceof TerminalBenchDevShellService, true);
  assert.equal((service as unknown as { baseUrl: URL }).baseUrl.toString(), "http://127.0.0.1:1234/");
  assert.equal(createTerminalBenchDevShellServiceFromEnv({} as NodeJS.ProcessEnv), undefined);
});

async function readJsonBody(request: http.IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("Expected server to listen on a TCP address.");
      }
      resolve(`http://127.0.0.1:${(address as AddressInfo).port}`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
