import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { handleRequest } from "../../cli/dev-shell/service.js";
import { LocalDevShellService } from "../../src/devshell/LocalDevShellService.js";
import { DEV_SHELL_SERVICE_PROTOCOL_VERSION } from "../../src/devshell/contracts.js";
import type { DevShellStoreBinding } from "../../src/devshell/storeBinding.js";

test("matching binding identity reaches every developer-shell process operation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dev-shell-request-match-"),
  );
  const binding = { driver: "sqlite" as const, revision: "binding-current" };
  const service = new LocalDevShellService(root, {
    storeBinding: binding,
  }) as any;
  const calls: string[] = [];
  const supervisor = createRecordingSupervisor(calls);
  const server = http.createServer((request, response) => {
    void handleRequest(supervisor as any, binding, request, response);
  });
  await listen(server, service.socketPath);
  service.ensureService = async () => {};

  try {
    await service.runCommand({ workspaceRoot: root, command: "echo ok" });
    await service.startProcess({ workspaceRoot: root, command: "sleep 1" });
    await service.writeProcess({ processId: "process-1", data: "ok\n" });
    await service.writeAndReadProcess({ processId: "process-1", data: "ok\n" });
    await service.readProcess({ processId: "process-1" });
    await service.stopProcess({ processId: "process-1" });
    await service.retainProcess({
      processId: "process-1",
      leaseId: "lease-1",
      kind: "standalone",
      expiresAt: "2026-08-29T12:00:00.000Z",
    });
    await service.promoteProcessRetention({
      processId: "process-1",
      fromLeaseId: "lease-1",
      leaseId: "lease-2",
      kind: "workspace_preview",
      expiresAt: "2026-08-29T12:30:00.000Z",
    });
    await service.inspectProcessRetention({ processId: "process-1" });
    await service.releaseProcessRetention({ leaseId: "lease-2" });

    assert.deepEqual(calls, [
      "run",
      "start",
      "write",
      "write_and_read",
      "read",
      "stop",
      "retain",
      "promote",
      "inspect",
      "release",
    ]);
  } finally {
    await closeServer(server);
  }
});

test("socket-owner swap after health is rejected before supervisor access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-shell-request-swap-"));
  const clientBinding: DevShellStoreBinding = {
    driver: "postgres",
    revision: "binding-client",
    databaseUrl: "postgres://client:secret-client@database.invalid/client",
  };
  const replacementBinding: DevShellStoreBinding = {
    driver: "postgres",
    revision: "binding-replacement",
    databaseUrl:
      "postgres://replacement:secret-replacement@database.invalid/replacement",
  };
  const service = new LocalDevShellService(root, {
    storeBinding: clientBinding,
    startupTimeoutMs: 500,
    pollIntervalMs: 2,
  }) as any;
  const originalServer = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(healthFor(clientBinding)));
  });
  await listen(originalServer, service.socketPath);

  const calls: string[] = [];
  const replacementServer = http.createServer((request, response) => {
    void handleRequest(
      createRecordingSupervisor(calls) as any,
      replacementBinding,
      request,
      response,
    );
  });
  const originalEnsureService = service.ensureService.bind(service);
  service.ensureService = async () => {
    await originalEnsureService();
    await closeServer(originalServer);
    await listen(replacementServer, service.socketPath);
  };

  try {
    await assert.rejects(
      service.runCommand({ workspaceRoot: root, command: "echo must-not-run" }),
      (error: unknown) => {
        const failure = error as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(failure.code, "DEV_SHELL_SERVICE_BINDING_MISMATCH");
        assert.equal(
          failure.details?.failureReason,
          "service_binding_mismatch",
        );
        assert.equal(failure.details?.failurePhase, "command_dispatch");
        assert.equal(
          failure.details?.receivedStoreBindingRevision,
          clientBinding.revision,
        );
        assert.equal(
          failure.details?.expectedStoreBindingRevision,
          replacementBinding.revision,
        );
        assert.match(
          String(failure.details?.nextSuggestedAction),
          /did not run.*retry/is,
        );
        const serialized = JSON.stringify({
          message: failure.message,
          details: failure.details,
        });
        assert.doesNotMatch(serialized, /secret-client|secret-replacement/u);
        assert.doesNotMatch(serialized, /database\.invalid/u);
        return true;
      },
    );
    assert.deepEqual(calls, []);
  } finally {
    await closeServer(originalServer);
    await closeServer(replacementServer);
  }
});

test("matching current identity authorizes one cooperative shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-shell-shutdown-auth-"));
  const binding = { driver: "sqlite" as const, revision: "binding-current" };
  const service = new LocalDevShellService(root, { storeBinding: binding }) as any;
  let shutdownRequests = 0;
  const server = http.createServer((request, response) => {
    void handleRequest(
      createRecordingSupervisor([]) as any,
      binding,
      request,
      response,
      async () => { shutdownRequests += 1; },
    );
  });
  await listen(server, service.socketPath);
  try {
    const result = await service.performRequest("POST", "/service/shutdown");
    assert.deepEqual(result, { status: "shutting_down" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownRequests, 1);
  } finally {
    await closeServer(server);
  }
});

test("a shutting-down service rejects health and command dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-shell-shutdown-reject-"));
  const binding = { driver: "sqlite" as const, revision: "binding-current" };
  const service = new LocalDevShellService(root, { storeBinding: binding }) as any;
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    void handleRequest(
      createRecordingSupervisor(calls) as any,
      binding,
      request,
      response,
      undefined,
      () => true,
    );
  });
  await listen(server, service.socketPath);
  try {
    await assert.rejects(service.performRequest("GET", "/health"));
    await assert.rejects(service.performRequest("POST", "/shell/run", {
      workspaceRoot: root,
      command: "printf blocked",
    }));
    assert.deepEqual(calls, []);
  } finally {
    await closeServer(server);
  }
});

function createRecordingSupervisor(calls: string[]) {
  const processResult = {
    processId: "process-1",
    status: "RUNNING",
    text: "",
    truncated: false,
    cursor: 0,
    nextCursor: 0,
  };
  const retentionResult = {
    status: "active",
    processId: "process-1",
    lifecycle: "retained",
    leases: [],
  };
  return {
    async runCommand() {
      calls.push("run");
      return {
        status: "COMPLETED",
        stdout: "ok",
        text: "ok",
        truncated: false,
        exitCode: 0,
      };
    },
    async startProcess() {
      calls.push("start");
      return processResult;
    },
    async writeProcess() {
      calls.push("write");
      return processResult;
    },
    async writeAndReadProcess() {
      calls.push("write_and_read");
      return processResult;
    },
    async readProcess() {
      calls.push("read");
      return processResult;
    },
    async stopProcess() {
      calls.push("stop");
      return { ...processResult, status: "STOPPED" };
    },
    async retainProcess() {
      calls.push("retain");
      return retentionResult;
    },
    async promoteProcessRetention() {
      calls.push("promote");
      return retentionResult;
    },
    async inspectProcessRetention() {
      calls.push("inspect");
      return retentionResult;
    },
    async releaseProcessRetention() {
      calls.push("release");
      return retentionResult;
    },
  };
}

function healthFor(binding: DevShellStoreBinding): Record<string, unknown> {
  return {
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    servicePid: process.pid,
    storeDriver: binding.driver,
    storeBindingRevision: binding.revision,
    capabilities: {
      processWriteAndRead: true,
      processRetentionLeases: true,
      processRetentionPromotion: true,
    },
  };
}

async function listen(server: http.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  if (server.listening === false) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
