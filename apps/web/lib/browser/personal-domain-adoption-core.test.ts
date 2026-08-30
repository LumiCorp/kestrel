import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserSessionV1 } from "../../../../src/browser/contracts.js";
import { adoptHostedBrowserPersonalDomainRevisionWithDependencies } from "./personal-domain-adoption-core";
import type { HostedBrowserResourceRecord } from "./store";

const scope = {
  organizationId: "org-1",
  environmentId: "env-1",
  userId: "user-1",
  personalRevision: 4,
};

function record(state: "ready" | "failed" = "ready") {
  const session = parseBrowserSessionV1({
    version: "browser_session_v1",
    sessionId: "browser-session-1",
    threadId: "thread-1",
    mode: "operator",
    state,
    engineRevision: "agent-browser:v1.0.0",
    generation: 2,
    effectiveAllowlistRevision: "revision-old",
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
    lastActivityAt: "2026-08-30T12:00:00.000Z",
    idleExpiresAt: "2026-08-30T12:30:00.000Z",
    hardExpiresAt: "2026-08-30T20:00:00.000Z",
    ...(state === "failed" ? { terminalReason: "BROWSER_ENGINE_FAILURE" } : {}),
  });
  const resource: HostedBrowserResourceRecord = {
    sessionId: session.sessionId,
    originatingTurnId: "turn-1",
    previewLeaseId: null,
    machineId: "machine-1",
    machineGeneration: 2,
    workerImageDigest: `registry.example/browser@sha256:${"a".repeat(64)}`,
    proxyAuthorityRevision: "revision-old",
    cleanupRequestedAt: state === "failed" ? new Date() : null,
    cleanupConfirmedAt: null,
  };
  return { session, resource };
}

function fixture(
  options: {
    state?: "ready" | "failed";
    installFailure?: boolean;
    originUserId?: string;
  } = {},
) {
  const operations: string[] = [];
  const current = record(options.state);
  const service = {
    async resolvePolicy() {
      operations.push("policy:revision-new");
      return {
        version: "browser_policy_resolution_v1",
        decision: "allow",
        policyRevision: "revision-new",
        sessionMode: "operator",
      };
    },
    async prepareAllowlistAdoption(input: {
      effectiveAllowlistRevision: string;
    }) {
      operations.push(`prepare:${input.effectiveAllowlistRevision}`);
      return {
        version: "hosted_browser_revision_instruction_v1",
        sessionId: current.session.sessionId,
        generation: current.session.generation,
        revision: input.effectiveAllowlistRevision,
        cause: "personal_revocation",
        authority: {
          version: "browser_effective_domain_authority_v1",
          environmentId: "env-1",
          projectId: "project-1",
          userId: "user-1",
          enabledModes: ["operator"],
          personalGrantsEnabled: true,
          publicDomains: [],
          qaTarget: null,
          effectiveAllowlistRevision: input.effectiveAllowlistRevision,
        },
        capability: "capability",
        machine: { appName: "environment-app", machineId: "machine-1" },
      } as const;
    },
    async completeAllowlistAdoption(
      input: { effectiveAllowlistRevision: string },
      adopted: { revision: string; closedUnauthorizedConnections: number },
    ) {
      operations.push(`complete:${adopted.revision}`);
      assert.equal(adopted.revision, input.effectiveAllowlistRevision);
      return {
        version: "browser_allowlist_adoption_receipt_v1",
        sessionId: current.session.sessionId,
        effectiveAllowlistRevision: adopted.revision,
        closedUnauthorizedConnections: adopted.closedUnauthorizedConnections,
      } as const;
    },
  };
  return {
    operations,
    dependencies: {
      records: [current],
      async resolveOrigin() {
        operations.push("origin");
        return {
          organizationId: "org-1",
          environmentId: "env-1",
          projectId: "project-1",
          threadId: "thread-1",
          runId: "run-1",
          userId: options.originUserId ?? "user-1",
        };
      },
      async resolveService() {
        return service as never;
      },
      async install(input: { instruction: { revision: string } }) {
        operations.push(`install:${input.instruction.revision}`);
        if (options.installFailure) throw new Error("transport ambiguous");
        return {
          revision: input.instruction.revision,
          closedUnauthorizedConnections: 2,
        };
      },
      async destroy() {
        operations.push("destroy");
      },
    },
  };
}

test("personal revision installs in the exact worker before the control-plane CAS", async () => {
  const current = fixture();
  const result = await adoptHostedBrowserPersonalDomainRevisionWithDependencies(
    scope,
    current.dependencies as never,
  );
  assert.deepEqual(current.operations, [
    "origin",
    "policy:revision-new",
    "prepare:revision-new",
    "install:revision-new",
    "complete:revision-new",
  ]);
  assert.deepEqual(result, {
    personalRevision: 4,
    adoptedSessions: [
      {
        sessionId: "browser-session-1",
        effectiveRevision: "revision-new",
        closedUnauthorizedConnections: 2,
      },
    ],
  });
});

test("ambiguous install destroys the exact session before adoption can succeed", async () => {
  const current = fixture({ installFailure: true });
  await assert.rejects(
    adoptHostedBrowserPersonalDomainRevisionWithDependencies(
      scope,
      current.dependencies as never,
    ),
    /transport ambiguous/u,
  );
  assert.deepEqual(current.operations, [
    "origin",
    "policy:revision-new",
    "prepare:revision-new",
    "install:revision-new",
    "destroy",
  ]);
});

test("a terminal cleanup-pending session is destroyed on settings retry", async () => {
  const current = fixture({ state: "failed" });
  const result = await adoptHostedBrowserPersonalDomainRevisionWithDependencies(
    scope,
    current.dependencies as never,
  );
  assert.deepEqual(current.operations, ["destroy"]);
  assert.deepEqual(result, { personalRevision: 4, adoptedSessions: [] });
});

test("an identity mismatch destroys the discovered exact session", async () => {
  const current = fixture({ originUserId: "user-other" });
  await assert.rejects(
    adoptHostedBrowserPersonalDomainRevisionWithDependencies(
      scope,
      current.dependencies as never,
    ),
    /BROWSER_SESSION_LOST/u,
  );
  assert.deepEqual(current.operations, ["origin", "destroy"]);
});
