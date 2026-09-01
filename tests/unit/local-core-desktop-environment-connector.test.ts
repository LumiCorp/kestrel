import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LocalCoreClient } from "../../src/localCore/client.js";
import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import { LocalCoreDesktopEnvironmentConfigStore } from "../../src/localCore/desktopEnvironmentConfig.js";
import {
  LocalCoreDesktopEnvironmentManager,
  assertCurrentDesktopLocalModelAdmission,
  redactDesktopRunnerEventForUpload,
} from "../../src/localCore/desktopEnvironmentConnector.js";
import { createLocalCoreModelReadiness } from "../../src/localCore/modelReadiness.js";
import { createDefaultLocalCoreRuntimeConfiguration } from "../../src/localCore/runtimeConfiguration.js";
import { LocalCoreBrowserAuthorityCriticalSection } from "../../src/localCore/api.js";

test("Desktop command dispatch rejects an unpublished or stale local route before runner startup", () => {
  const readiness = createLocalCoreModelReadiness({
    runtimeConfiguration: createDefaultLocalCoreRuntimeConfiguration({
      version: 1,
      provider: "ollama",
      model: "glm-4.5-air",
      modelByStage: {},
      modelCapabilities: { visionInputEnabled: false },
    }),
    profile: { modelProvider: "ollama", model: "glm-4.5-air" },
  });

  assert.throws(
    () =>
      assertCurrentDesktopLocalModelAdmission({
        provider: "ollama",
        model: "glm-4.5-air",
        readiness,
      }),
    /not currently qualified/u,
  );
  assert.throws(
    () =>
      assertCurrentDesktopLocalModelAdmission({
        provider: "ollama",
        model: "glm-4.5-air-updated",
        readiness,
      }),
    /no longer matches/u,
  );
});

test("Desktop Environment reports a claimed command that fails before runner startup", async (context) => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-desktop-environment-connector-"),
  );
  let manager: LocalCoreDesktopEnvironmentManager | undefined;
  context.after(async () => {
    await manager?.close();
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 10,
    });
  });
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const signingKeys = generateKeyPairSync("ed25519");
  const privateKey = signingKeys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicKey = signingKeys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const connectionId = "00000000-0000-4000-8000-000000000001";
  const environmentId = "00000000-0000-4000-8000-000000000002";
  const organizationId = "00000000-0000-4000-8000-000000000003";
  const commandId = "00000000-0000-4000-8000-000000000004";
  const now = new Date().toISOString();
  await new LocalCoreDesktopEnvironmentConfigStore(home).write({
    version: 1,
    enrollments: [],
    environments: [
      {
        connectionId,
        environmentId,
        organizationId,
        baseUrl: "https://kestrel.example/",
        desktopName: "Test Desktop",
        ticketPublicKey: publicKey,
        status: "active",
        capacity: 1,
        workspaces: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  await credentialStore.set(
    `kestrel_one.environment.${connectionId}`,
    JSON.stringify({
      privateKey,
      encryptionPrivateKey: "unused-encryption-private-key",
      connectorCredential: "connector-credential-value",
    }),
  );

  let claimServed = false;
  let runnerStarted = false;
  let completionBody: Record<string, unknown> | undefined;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/commands/claim")) {
      if (claimServed) return new Response(null, { status: 204 });
      claimServed = true;
      return Response.json({
        command: { id: commandId, payload: {} },
        claimToken: "claim-token-value-that-is-long-enough",
        executionTicket: "not-a-signed-ticket",
        provenance: {
          organizationId,
          organizationName: "Test Organization",
          projectId: "00000000-0000-4000-8000-000000000005",
          projectName: "Test Project",
          threadId: "00000000-0000-4000-8000-000000000006",
          threadTitle: "Test Thread",
          requestingUserId: "00000000-0000-4000-8000-000000000007",
          requestingUserName: "Test User",
          workspaceRef: "workspace-ref",
          queuedAt: now,
        },
      });
    }
    if (url.pathname.endsWith(`/commands/${commandId}/complete`)) {
      completionBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      resolveCompletion?.();
      return Response.json({});
    }
    return Response.json({});
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  manager = new LocalCoreDesktopEnvironmentManager({
    homePath: home,
    credentialStore,
    coreVersion: "test",
  });
  const client = {
    async desktopExecutionConfig() {
      return {
        resolvedProfile: {
          modelProvider: "openrouter",
          model: "test-model",
        },
      };
    },
    async sendRunnerCommand() {
      runnerStarted = true;
    },
  } as unknown as LocalCoreClient;

  await manager.start(client);
  await Promise.race([
    completion,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Claim failure was not reported.")),
        1_000,
      ),
    ),
  ]);

  assert.equal(runnerStarted, false);
  assert.equal(completionBody?.status, "failed");
  assert.equal(completionBody?.failureCode, "DESKTOP_COMMAND_INVALID");
});

test("Desktop Environment runner events redact registered local workspace roots before upload", () => {
  const workspacePath = "/workspace/private-client";
  const event = {
    id: "event-1",
    type: "run.tool.completed",
    ts: new Date().toISOString(),
    payload: {
      toolName: "dev.shell.run",
      input: {
        command: "pnpm test",
        cwd: `${workspacePath}/apps/web`,
      },
      output: `Built ${workspacePath}/apps/web/.next/server/app.js`,
    },
  };

  const redacted = redactDesktopRunnerEventForUpload(event as never, [
    {
      workspaceRef: "workspace-ref",
      projectId: "project-id",
      label: "Private Client",
      path: workspacePath,
      available: true,
    },
  ]) as unknown as typeof event;

  assert.equal(JSON.stringify(redacted).includes(workspacePath), false);
  assert.equal(redacted.payload.input.cwd, "[desktop-workspace]/apps/web");
  assert.equal(
    redacted.payload.output,
    "Built [desktop-workspace]/apps/web/.next/server/app.js",
  );
});

test("Desktop Project replacement closes affected Browser authority before changing mappings", async (context) => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-desktop-project-authority-"),
  );
  context.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const removals: string[][] = [];
  let failCleanup = false;
  const criticalSection = new LocalCoreBrowserAuthorityCriticalSection();
  let cleanupReached!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    cleanupReached = resolve;
  });
  let releaseCleanup!: () => void;
  const cleanupRelease = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let holdCleanup = false;
  const manager = new LocalCoreDesktopEnvironmentManager({
    homePath: home,
    credentialStore: new MemoryLocalCoreCredentialStore(),
    coreVersion: "test",
    beforeAuthorityRemoval: async (input) => {
      removals.push([...(input.projectIds ?? [])]);
      if (failCleanup) throw new Error("Browser cleanup failed");
      if (holdCleanup) {
        cleanupReached();
        await cleanupRelease;
      }
    },
    withAuthorityMutation: async (action) => await criticalSection.run(action),
  });
  context.after(() => manager.close());
  const original = {
    id: "project-1",
    path: "/projects/one",
    label: "One",
  };
  await manager.setProjects([original]);
  await manager.setProjects([
    original,
    { id: "project-2", path: "/projects/two", label: "Two" },
  ]);
  assert.deepEqual(removals, []);

  failCleanup = true;
  await assert.rejects(
    manager.setProjects([
      { ...original, path: "/projects/replaced" },
      { id: "project-2", path: "/projects/two", label: "Two" },
    ]),
    /Browser cleanup failed/u,
  );
  failCleanup = false;
  holdCleanup = true;
  const replacement = manager.setProjects([
    { ...original, path: "/projects/replaced" },
    { id: "project-2", path: "/projects/two", label: "Two" },
  ]);
  await cleanup;
  let admitted = false;
  const admission = criticalSection.run(async () => {
    admitted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);
  releaseCleanup();
  await replacement;
  await admission;
  assert.equal(admitted, true);
  assert.deepEqual(removals, [["project-1"], ["project-1"]]);
});

test("Desktop Environment disconnect retains mapping and credential when Browser cleanup fails", async (context) => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-desktop-environment-authority-"),
  );
  context.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const credentialStore = new MemoryLocalCoreCredentialStore();
  const signingKeys = generateKeyPairSync("ed25519");
  const privateKey = signingKeys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicKey = signingKeys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const connectionId = "00000000-0000-4000-8000-000000000011";
  const environmentId = "00000000-0000-4000-8000-000000000012";
  const now = new Date().toISOString();
  const configStore = new LocalCoreDesktopEnvironmentConfigStore(home);
  await configStore.write({
    version: 1,
    enrollments: [],
    environments: [
      {
        connectionId,
        environmentId,
        organizationId: "00000000-0000-4000-8000-000000000013",
        baseUrl: "https://kestrel.example/",
        desktopName: "Test Desktop",
        ticketPublicKey: publicKey,
        status: "active",
        capacity: 1,
        workspaces: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  const credentialId = `kestrel_one.environment.${connectionId}`;
  await credentialStore.set(
    credentialId,
    JSON.stringify({
      privateKey,
      encryptionPrivateKey: "unused-encryption-private-key",
      connectorCredential: "connector-credential-value",
    }),
  );
  let failCleanup = true;
  const removals: string[] = [];
  const criticalSection = new LocalCoreBrowserAuthorityCriticalSection();
  let cleanupReached!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    cleanupReached = resolve;
  });
  let releaseCleanup!: () => void;
  const cleanupRelease = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const manager = new LocalCoreDesktopEnvironmentManager({
    homePath: home,
    credentialStore,
    coreVersion: "test",
    beforeAuthorityRemoval: async (input) => {
      removals.push(String(input.environmentId));
      if (failCleanup) throw new Error("Browser cleanup failed");
      cleanupReached();
      await cleanupRelease;
    },
    withAuthorityMutation: async (action) => await criticalSection.run(action),
  });
  context.after(() => manager.close());

  await assert.rejects(
    manager.disconnect(connectionId),
    /Browser cleanup failed/u,
  );
  assert.equal((await configStore.read()).environments.length, 1);
  assert.notEqual(await credentialStore.get(credentialId), undefined);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({});
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  failCleanup = false;
  const disconnect = manager.disconnect(connectionId);
  await cleanup;
  let admitted = false;
  const admission = criticalSection.run(async () => {
    admitted = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);
  releaseCleanup();
  await disconnect;
  await admission;
  assert.equal(admitted, true);
  assert.deepEqual(removals, [environmentId, environmentId]);
  assert.equal((await configStore.read()).environments.length, 0);
  assert.equal(await credentialStore.get(credentialId), undefined);
});
