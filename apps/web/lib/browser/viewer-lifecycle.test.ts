import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import {
  composeHostedBrowserViewerLifecycle,
  createCleanupSafeHostedBrowserViewerLifecycle,
} from "./viewer-lifecycle";
import type { HostedBrowserResourceRecord, HostedBrowserStore } from "./store";

test("cleanup-safe lifecycle durably terminalizes exact non-ready Environment authority", async () => {
  const session = browserSession();
  const resource = browserResource();
  const terminalCalls: unknown[] = [];
  const lifecycle = createCleanupSafeHostedBrowserViewerLifecycle({
    store: {
      async read() { return { session, resource }; },
      async resolveCurrentOrigin() {
        return {
          organizationId: "org-1",
          environmentId: "env-1",
          projectId: "project-1",
          threadId: "thread-1",
          runId: "run-1",
          turnId: "turn-1",
          userId: "user-1",
        };
      },
      async markTerminal(input) {
        terminalCalls.push(input);
        return { ...session, state: "lost" as const };
      },
    } as Pick<HostedBrowserStore, "markTerminal" | "read" | "resolveCurrentOrigin">,
    authority: {
      organizationId: "org-1",
      environmentId: "env-1",
      userId: "user-1",
    },
    now: () => new Date("2026-08-30T12:00:00.000Z"),
  });

  await lifecycle.terminateViewerSession({
    sessionId: "session-1",
    generation: 1,
    reason: "BROWSER_SESSION_LOST",
  });

  assert.deepEqual(terminalCalls, [{
    sessionId: "session-1",
    expectedGeneration: 1,
    expectedMachineId: "machine-1",
    state: "lost",
    reason: "BROWSER_SESSION_LOST",
    now: new Date("2026-08-30T12:00:00.000Z"),
  }]);
});

test("non-ready Environment composition never invokes ready-only lifecycle construction", async () => {
  let readyConstructionCalls = 0;
  let cleanupCalls = 0;
  const lifecycle = await composeHostedBrowserViewerLifecycle({
    environmentReady: false,
    async createReady() {
      readyConstructionCalls += 1;
      throw new Error("ready-only composition must not run");
    },
    createCleanupSafe() {
      return {
        async terminateViewerSession() { cleanupCalls += 1; },
      };
    },
  });

  await lifecycle.terminateViewerSession({
    sessionId: "session-1",
    generation: 1,
    reason: "BROWSER_SESSION_LOST",
  });
  assert.equal(readyConstructionCalls, 0);
  assert.equal(cleanupCalls, 1);
});

test("authority loss never invokes ready-only lifecycle construction", async () => {
  let readyConstructionCalls = 0;
  let cleanupCalls = 0;
  const lifecycle = await composeHostedBrowserViewerLifecycle({
    environmentReady: true,
    async createReady() {
      readyConstructionCalls += 1;
      throw new Error("ready-only composition must not run for authority loss");
    },
    createCleanupSafe() {
      return {
        async terminateViewerSession() { cleanupCalls += 1; },
      };
    },
  });

  await lifecycle.terminateViewerSession({
    sessionId: "session-1",
    generation: 1,
    reason: "BROWSER_SESSION_LOST",
  });
  assert.equal(readyConstructionCalls, 0);
  assert.equal(cleanupCalls, 1);
});

test("cleanup-safe lifecycle rejects a different durable authority before terminalization", async () => {
  let terminalCalls = 0;
  const lifecycle = createCleanupSafeHostedBrowserViewerLifecycle({
    store: {
      async read() {
        return { session: browserSession(), resource: browserResource() };
      },
      async resolveCurrentOrigin() {
        return {
          organizationId: "org-1",
          environmentId: "env-1",
          projectId: "project-1",
          threadId: "thread-1",
          runId: "run-1",
          turnId: "turn-1",
          userId: "different-user",
        };
      },
      async markTerminal() {
        terminalCalls += 1;
        return browserSession();
      },
    } as Pick<HostedBrowserStore, "markTerminal" | "read" | "resolveCurrentOrigin">,
    authority: {
      organizationId: "org-1",
      environmentId: "env-1",
      userId: "user-1",
    },
  });

  await assert.rejects(
    lifecycle.terminateViewerSession({
      sessionId: "session-1",
      generation: 1,
      reason: "BROWSER_SESSION_LOST",
    }),
    /BROWSER_SESSION_LOST/u,
  );
  assert.equal(terminalCalls, 0);
});

function browserSession(): BrowserSessionV1 {
  return {
    version: "browser_session_v1",
    sessionId: "session-1",
    threadId: "thread-1",
    mode: "operator",
    state: "human_control",
    engineRevision: "engine-1",
    generation: 1,
    effectiveAllowlistRevision: "revision-1",
    createdAt: "2026-08-30T11:00:00.000Z",
    updatedAt: "2026-08-30T11:00:00.000Z",
    lastActivityAt: "2026-08-30T11:00:00.000Z",
    idleExpiresAt: "2026-08-30T12:30:00.000Z",
    hardExpiresAt: "2026-08-30T19:00:00.000Z",
  };
}

function browserResource(): HostedBrowserResourceRecord {
  return {
    sessionId: "session-1",
    originatingTurnId: "turn-1",
    previewLeaseId: null,
    machineId: "machine-1",
    machineGeneration: 1,
    workerImageDigest: `registry.example/browser@sha256:${"a".repeat(64)}`,
    proxyAuthorityRevision: "revision-1",
    cleanupRequestedAt: null,
    cleanupConfirmedAt: null,
  };
}
