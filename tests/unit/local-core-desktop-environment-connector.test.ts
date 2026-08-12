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
  redactDesktopRunnerEventForUpload,
} from "../../src/localCore/desktopEnvironmentConnector.js";

test(
  "Desktop Environment reports a claimed command that fails before runner startup",
  async (context) => {
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
      if (url.pathname.includes("/runtime-releases/")) {
        return new Response(null, { status: 204 });
      }
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
  },
);

test(
  "Desktop Environment delivers Runtime release independently of run capacity",
  async (context) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-release-"));
    let manager: LocalCoreDesktopEnvironmentManager | undefined;
    context.after(async () => {
      await manager?.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
    });
    const credentialStore = new MemoryLocalCoreCredentialStore();
    const signingKeys = generateKeyPairSync("ed25519");
    const connectionId = "00000000-0000-4000-8000-000000000011";
    const environmentId = "00000000-0000-4000-8000-000000000012";
    const organizationId = "00000000-0000-4000-8000-000000000013";
    const releaseId = "00000000-0000-4000-8000-000000000014";
    const threadId = "00000000-0000-4000-8000-000000000015";
    const now = new Date().toISOString();
    await new LocalCoreDesktopEnvironmentConfigStore(home).write({
      version: 1,
      enrollments: [],
      environments: [{
        connectionId, environmentId, organizationId,
        baseUrl: "https://kestrel.example/", desktopName: "Release Desktop",
        ticketPublicKey: signingKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        status: "active", capacity: 1, workspaces: [], createdAt: now, updatedAt: now,
      }],
    });
    await credentialStore.set(
      `kestrel_one.environment.${connectionId}`,
      JSON.stringify({
        privateKey: signingKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        encryptionPrivateKey: "unused",
        connectorCredential: "connector-credential-value",
      }),
    );
    let releaseClaimed = false;
    let completionBody: Record<string, unknown> | undefined;
    let resolveCompletion: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (request, init) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/commands/claim")) return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/runtime-releases/claim")) {
        if (releaseClaimed) return new Response(null, { status: 204 });
        releaseClaimed = true;
        return Response.json({
          release: {
            id: releaseId, runtimeId: "codex", bindingId: "binding-release",
            participantId: "runtime:codex", threadId, environmentId,
            actorUserId: "00000000-0000-4000-8000-000000000016",
          },
          claimToken: "runtime-release-claim-token-long-enough",
          claimExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        });
      }
      if (url.pathname.endsWith(`/runtime-releases/${releaseId}/complete`)) {
        completionBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        resolveCompletion?.();
        return Response.json({ state: "released" });
      }
      return Response.json({});
    };
    context.after(() => { globalThis.fetch = originalFetch; });
    manager = new LocalCoreDesktopEnvironmentManager({ homePath: home, credentialStore, coreVersion: "test" });
    const client = {
      async desktopExecutionConfig() {
        return { resolvedProfile: { modelProvider: "openrouter", model: "test" } };
      },
      async sendRunnerCommand(line: string, input: { onLine(line: string): void }) {
        const command = JSON.parse(line) as { id: string; payload: Record<string, unknown> };
        assert.equal(command.id, releaseId);
        input.onLine(JSON.stringify({
          id: crypto.randomUUID(), type: "runtime.released", ts: new Date().toISOString(),
          commandId: releaseId, sessionId: threadId, threadId,
          payload: command.payload,
        }));
      },
    } as unknown as LocalCoreClient;
    await manager.start(client);
    await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Release was not completed.")), 1_000)),
    ]);
    const outcome = completionBody?.outcome as Record<string, unknown> | undefined;
    assert.equal(outcome?.status, "released");
    assert.equal((outcome?.event as Record<string, unknown>)?.commandId, releaseId);
  },
);

test(
  "Desktop Environment runner events redact registered local workspace roots before upload",
  () => {
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
  },
);
