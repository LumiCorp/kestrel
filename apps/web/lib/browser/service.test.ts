import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { Readable } from "node:stream";

import { defaultToolCatalog } from "../../../../tools/catalog.js";
import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
  hashCanonical,
} from "../../../../src/kestrel/contracts/tool-contract.js";
import { parsePreparedToolCallV1 } from "../../../../src/kestrel/contracts/tool-invocation.js";
import {
  BROWSER_ARTIFACT_AUTHORIZATION_VERSION,
  parseBrowserSessionV1,
} from "../../../../src/browser/contracts.js";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../../../src/browser/runtimeReleaseManifest.js";
import {
  HOSTED_BROWSER_CAPABILITY_VERSION,
  issueHostedBrowserOperationCapability,
} from "../../../../src/browser/hostedCapability.js";
import type { BrowserEffectiveDomainAuthorityV1 } from "../../../../src/browser/domainAuthority.js";
import type { HostedBrowserResourceRecord } from "./store";
import { HostedBrowserService } from "./service";
import type { HostedBrowserRelayAcceptanceV1 } from "./worker-contract";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const now = new Date("2026-08-30T12:00:00.000Z");
const imageDigest = `registry.fly.io/browser@sha256:${"a".repeat(64)}`;
const origin = {
  organizationId: "org-1",
  environmentId: "env-1",
  projectId: "project-1",
  threadId: "thread-1",
  runId: "run-1",
  turnId: "turn-1",
  userId: "user-1",
};
const authority: BrowserEffectiveDomainAuthorityV1 = {
  version: "browser_effective_domain_authority_v1",
  environmentId: "env-1",
  projectId: "project-1",
  userId: "user-1",
  enabledModes: ["operator"],
  personalGrantsEnabled: true,
  publicDomains: [{
    version: "browser_public_domain_authority_v1",
    scheme: "https",
    canonicalDomain: "example.com",
    includeSubdomains: true,
    port: 443,
  }],
  qaTarget: null,
  effectiveAllowlistRevision: "revision-1",
};

test("hosted completion rejects an open result for a different stored session", async () => {
  const fixture = serviceFixture("ready", "allow");
  const prepared = preparedOpen();
  const receipt = acceptedReceipt(prepared.callId, fixture.session.sessionId);
  const wrongSession = parseBrowserSessionV1({
    ...fixture.session,
    sessionId: "browser-session-other",
  });
  await assert.rejects(
    fixture.service.completeAcceptedOperation(
      prepared,
      { threadId: "thread-1", projectId: "project-1" },
      receipt,
      {
        version: "browser_tool_result_v1",
        operation: "browser.open",
        outcome: "opened",
        session: wrongSession,
      },
    ),
    (error: unknown) => readCode(error) === "BROWSER_ENGINE_FAILURE",
  );
  assert.deepEqual(fixture.terminalReasons, ["BROWSER_ENGINE_FAILURE"]);
  assert.deepEqual(fixture.deletedMachines, ["machine-1"]);
  assert.equal(fixture.touches, 0);
});

test("hosted dispatch cleans an exact opening session when policy revalidation refuses it", async () => {
  const fixture = serviceFixture("opening", "deny");
  const prepared = preparedOpen();
  const receipt = acceptedReceipt(prepared.callId, fixture.session.sessionId);
  await assert.rejects(
    fixture.service.dispatchAcceptedOperation(
      prepared,
      { threadId: "thread-1", projectId: "project-1" },
      receipt,
    ),
    (error: unknown) => readCode(error) === "BROWSER_DESTINATION_BLOCKED",
  );
  assert.deepEqual(fixture.terminalReasons, ["BROWSER_DESTINATION_BLOCKED"]);
  assert.deepEqual(fixture.deletedMachines, ["machine-1"]);
  assert.equal(fixture.cleanupConfirmed, 1);
});

test("hosted dispatch still cleans the exact opening session after its capability expires", async () => {
  const fixture = serviceFixture("opening", "deny");
  const prepared = preparedOpen();
  const receipt = acceptedReceipt(
    prepared.callId,
    fixture.session.sessionId,
    new Date(now.getTime() - 60_000),
    new Date(now.getTime() - 1000),
  );
  await assert.rejects(
    fixture.service.dispatchAcceptedOperation(
      prepared,
      { threadId: "thread-1", projectId: "project-1" },
      receipt,
    ),
    (error: unknown) => readCode(error) === "BROWSER_DESTINATION_BLOCKED",
  );
  assert.deepEqual(fixture.terminalReasons, ["BROWSER_DESTINATION_BLOCKED"]);
  assert.deepEqual(fixture.deletedMachines, ["machine-1"]);
  assert.equal(fixture.cleanupConfirmed, 1);
});

test("hosted worker acceptance leaves an opening session opening", async () => {
  const fixture = serviceFixture("opening", "allow");
  const prepared = preparedOpen();
  const receipt = acceptedReceipt(prepared.callId, fixture.session.sessionId);
  const instruction = await fixture.service.dispatchAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
  );
  assert.equal(instruction.phase, "invoke");
  assert.equal(fixture.session.state, "opening");
  assert.deepEqual(fixture.stateTransitions, []);
  assert.equal(fixture.touches, 0);
});

test("hosted dispatch refuses a session that became terminal after acceptance", async () => {
  const fixture = serviceFixture("opening", "allow", {
    terminalOnRead: true,
  });
  const prepared = preparedOpen();
  await assert.rejects(
    fixture.service.dispatchAcceptedOperation(
      prepared,
      { threadId: "thread-1", projectId: "project-1" },
      acceptedReceipt(prepared.callId, fixture.session.sessionId),
    ),
    (error: unknown) => readCode(error) === "BROWSER_SESSION_LOST",
  );
  assert.equal(fixture.session.state, "lost");
});

test("startup failure confirms cleanup only after terminal intent and deletion", async () => {
  const fixture = serviceFixture("opening", "allow", {
    startupWaitFailure: true,
  });
  await assert.rejects(
    fixture.service.acceptOperation(preparedOpen(), {
      threadId: "thread-1",
      projectId: "project-1",
    }),
    /startup failed/u,
  );
  assert.equal(fixture.session.state, "failed");
  assert.deepEqual(fixture.terminalReasons, ["BROWSER_ENGINE_FAILURE"]);
  assert.deepEqual(fixture.deletedMachines, ["machine-1"]);
  assert.equal(fixture.cleanupConfirmed, 1);
});

test("viewer termination commits the exact terminal generation before machine cleanup", async () => {
  const fixture = serviceFixture("ready", "allow", {
    machineDeleteFailure: true,
  });

  await assert.rejects(
    fixture.service.terminateViewerSession({
      sessionId: fixture.session.sessionId,
      generation: fixture.session.generation,
      reason: "BROWSER_SESSION_LOST",
    }),
    /machine cleanup unavailable/u,
  );
  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.session.terminalReason, "BROWSER_SESSION_LOST");
  assert.deepEqual(fixture.terminalMarks, [{
    expectedGeneration: 1,
    expectedMachineId: "machine-1",
  }]);
  assert.equal(fixture.cleanupConfirmed, 0);
});

test("only successful validated open completion promotes the stored session to ready", async () => {
  const fixture = serviceFixture("opening", "allow");
  const prepared = preparedOpen();
  const opening = fixture.session;
  const receipt = acceptedReceipt(prepared.callId, opening.sessionId);
  const result = await fixture.service.completeAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
    {
      version: "browser_tool_result_v1",
      operation: "browser.open",
      outcome: "opened",
      session: { ...opening, state: "ready" },
    },
  ) as { session: { state: string } };
  assert.equal(result.session.state, "ready");
  assert.equal(fixture.session.state, "ready");
  assert.deepEqual(fixture.stateTransitions, ["ready"]);
  assert.equal(fixture.touches, 1);
});

test("failed open completion never promotes the opening session", async () => {
  const fixture = serviceFixture("opening", "allow");
  const prepared = preparedOpen();
  const receipt = acceptedReceipt(prepared.callId, fixture.session.sessionId);
  await assert.rejects(fixture.service.completeAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
    {
      version: "browser_tool_result_v1",
      operation: "browser.open",
      outcome: "opened",
      session: { ...fixture.session, sessionId: "browser-session-other" },
    },
  ), (error: unknown) => readCode(error) === "BROWSER_ENGINE_FAILURE");
  assert.equal(fixture.session.state, "failed");
  assert.equal(fixture.stateTransitions.includes("ready"), false);
  assert.deepEqual(fixture.deletedMachines, ["machine-1"]);
});

test("unknown open outcome terminates without promoting the opening session", async () => {
  const fixture = serviceFixture("opening", "allow");
  const prepared = preparedOpen();
  const receipt = acceptedReceipt(prepared.callId, fixture.session.sessionId);
  await fixture.service.markAcceptedOperationUnknown(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
  );
  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.stateTransitions.includes("ready"), false);
  assert.deepEqual(fixture.deletedMachines, ["machine-1"]);
});

test("terminal race during open completion cannot resurrect the session", async () => {
  const fixture = serviceFixture("opening", "allow", {
    terminalRaceOnReady: true,
  });
  const prepared = preparedOpen();
  const opening = fixture.session;
  const receipt = acceptedReceipt(prepared.callId, opening.sessionId);
  await assert.rejects(fixture.service.completeAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
    {
      version: "browser_tool_result_v1",
      operation: "browser.open",
      outcome: "opened",
      session: { ...opening, state: "ready" },
    },
  ), (error: unknown) => readCode(error) === "BROWSER_ENGINE_FAILURE");
  assert.equal(fixture.session.state, "lost");
  assert.deepEqual(fixture.stateTransitions, ["lost"]);
  assert.equal(fixture.touches, 0);
  assert.deepEqual(fixture.deletedMachines, ["machine-1"]);
});

test("hosted open completion projects lifecycle and runtime truth from the stored session", async () => {
  const fixture = serviceFixture("ready", "allow");
  const prepared = preparedOpen();
  const storedSession = fixture.session;
  const receipt = acceptedReceipt(prepared.callId, storedSession.sessionId);
  const forgedLifecycle = parseBrowserSessionV1({
    ...storedSession,
    state: "lost",
    terminalReason: "BROWSER_SESSION_LOST",
    engineRevision: "forged-engine:v999",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:01.000Z",
    lastActivityAt: "2020-01-01T00:00:01.000Z",
    idleExpiresAt: "2020-01-01T00:30:00.000Z",
    hardExpiresAt: "2020-01-01T08:00:00.000Z",
  });
  const result = await fixture.service.completeAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
    {
      version: "browser_tool_result_v1",
      operation: "browser.open",
      outcome: "opened",
      session: forgedLifecycle,
    },
  ) as { session: unknown };
  assert.deepEqual(result.session, storedSession);
  assert.deepEqual(fixture.terminalReasons, []);
  assert.deepEqual(fixture.deletedMachines, []);
  assert.equal(fixture.touches, 1);
});

test("hosted capture prepares an exact host-private Thread upload authority", async () => {
  const fixture = serviceFixture("ready", "allow");
  const prepared = preparedCapture();
  const instruction = await fixture.service.prepareCaptureArtifactUpload(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    { byteLength: 9, sha256: "a".repeat(64) },
  );
  assert.equal(instruction.capability, "host-private-capability");
  assert.deepEqual(fixture.preparedArtifacts, [{
    origin,
    sessionId: fixture.session.sessionId,
    generation: fixture.session.generation,
    callId: prepared.callId,
    byteLength: 9,
    sha256: "a".repeat(64),
  }]);
});

test("hosted upload re-resolves the active-turn file before preparation and dedicated transfer", async () => {
  const fixture = serviceFixture("ready", "allow");
  const request = {
    version: "browser_upload_preparation_v1" as const,
    runId: "run-1",
    threadId: "thread-1",
    turnId: "turn-1",
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      snapshotId: "snapshot-1",
      targetRef: "@e1",
      attachmentId: "attachment-1",
    },
    attachment: {
      attachmentId: "attachment-1",
      filename: "evidence.txt",
      declaredMediaType: "text/plain",
      detectedMediaType: "text/plain",
      sizeBytes: 8,
      sha256: "a".repeat(64),
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  };
  const effect = await fixture.service.prepareUpload(request);
  assert.equal(fixture.preparedUploads.length, 1);
  assert.doesNotMatch(JSON.stringify(effect), /sourceUrl|credential|path/u);
  const prepared = preparedUpload(effect);
  const receipt = acceptedReceipt(
    prepared.callId,
    fixture.session.sessionId,
    now,
    new Date(now.getTime() + 30_000),
    "browser.upload",
  );
  const instruction = await fixture.service.dispatchAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
  );
  assert.equal(instruction.phase, "invoke");
  assert.deepEqual(fixture.transferredUploads, [{
    operationId: prepared.callId,
    bytes: Buffer.from("12345678"),
  }]);
});

test("hosted artifact authorization binds the stored generation", async () => {
  const fixture = serviceFixture("ready", "allow");
  const authorized = await fixture.service.authorizeArtifact({
    version: BROWSER_ARTIFACT_AUTHORIZATION_VERSION,
    runId: "run-1",
    threadId: "thread-1",
    callId: "call-capture-1",
    toolName: "browser.capture",
    sessionId: fixture.session.sessionId,
    artifactId: `file-browser-${"a".repeat(64)}`,
    artifactKind: "browser-screenshot",
  });
  assert.equal(authorized?.url, "/api/files/file-browser-authorized/content");
  assert.equal(fixture.authorizedArtifacts[0]?.generation, 1);
  assert.equal(fixture.authorizedArtifacts[0]?.origin.runId, "run-1");
});

test("hosted capture canonicalizes relayed PNG bytes into Thread artifact authority", async () => {
  const fixture = serviceFixture("ready", "allow");
  const prepared = preparedCapture();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sha256 = createHash("sha256").update(png).digest("hex");
  const result = await fixture.service.completeAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    acceptedReceipt(
      prepared.callId,
      fixture.session.sessionId,
      now,
      new Date(now.getTime() + 30_000),
      "browser.capture",
    ),
    {
      version: "hosted_browser_worker_result_v1",
      output: {
        version: "browser_tool_result_v1",
        operation: "browser.capture",
        sessionId: fixture.session.sessionId,
        generation: 1,
        artifact: {
          version: "browser_authorized_artifact_v1",
          id: "file-worker-private",
          title: "Browser screenshot",
          kind: "browser-screenshot",
          mediaType: "image/png",
          bytes: png.byteLength,
          sha256,
        },
        normalizedOrigin: "https://example.com",
        capturedAt: now.toISOString(),
        boundary: "untrusted_browser_content",
      },
      screenshot: {
        mediaType: "image/png",
        byteLength: png.byteLength,
        sha256,
        base64: png.toString("base64"),
      },
    },
  ) as { artifact: { id: string; url: string } };
  assert.equal(result.artifact.id, "file-browser-authorized");
  assert.equal(result.artifact.url, "/api/files/file-browser-authorized/content");
  assert.equal(fixture.canonicalizedArtifacts[0]?.bytes.toString("hex"), png.toString("hex"));
  assert.equal(fixture.touches, 1);
});

test("hosted capture rejects a relayed screenshot whose bytes do not match its digest", async () => {
  const fixture = serviceFixture("ready", "allow");
  const prepared = preparedCapture();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(
    fixture.service.completeAcceptedOperation(
      prepared,
      { threadId: "thread-1", projectId: "project-1" },
      acceptedReceipt(
        prepared.callId,
        fixture.session.sessionId,
        now,
        new Date(now.getTime() + 30_000),
        "browser.capture",
      ),
      {
        version: "hosted_browser_worker_result_v1",
        output: {},
        screenshot: {
          mediaType: "image/png",
          byteLength: png.byteLength,
          sha256: "0".repeat(64),
          base64: png.toString("base64"),
        },
      },
    ),
    (error: unknown) => readCode(error) === "BROWSER_ENGINE_FAILURE",
  );
  assert.equal(fixture.canonicalizedArtifacts.length, 0);
});

test("hosted capture authenticates the operation before storing relayed bytes", async () => {
  const fixture = serviceFixture("ready", "allow");
  const prepared = preparedCapture();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sha256 = createHash("sha256").update(png).digest("hex");
  const receipt = acceptedReceipt(
    prepared.callId,
    fixture.session.sessionId,
    now,
    new Date(now.getTime() + 30_000),
    "browser.capture",
  );
  await assert.rejects(
    fixture.service.completeAcceptedOperation(
      prepared,
      { threadId: "thread-1", projectId: "project-1" },
      {
        ...receipt,
        instruction: {
          ...receipt.instruction,
          capability: `${receipt.instruction.capability}-forged`,
        },
      },
      {
        version: "hosted_browser_worker_result_v1",
        output: {},
        screenshot: {
          mediaType: "image/png",
          byteLength: png.byteLength,
          sha256,
          base64: png.toString("base64"),
        },
      },
    ),
    (error: unknown) => readCode(error) === "BROWSER_ENGINE_FAILURE",
  );
  assert.equal(fixture.canonicalizedArtifacts.length, 0);
});

function serviceFixture(
  state: "opening" | "ready",
  decision: "allow" | "deny",
  options: {
    terminalRaceOnReady?: boolean;
    startupWaitFailure?: boolean;
    terminalOnRead?: boolean;
    machineDeleteFailure?: boolean;
  } = {},
) {
  let session = parseBrowserSessionV1({
    version: "browser_session_v1",
    sessionId: "browser-session-1",
    threadId: "thread-1",
    mode: "operator",
    state,
    engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
    generation: 1,
    effectiveAllowlistRevision: "revision-1",
    createdAt: "2026-08-30T11:00:00.000Z",
    updatedAt: "2026-08-30T11:00:00.000Z",
    lastActivityAt: "2026-08-30T11:00:00.000Z",
    idleExpiresAt: "2026-08-30T12:30:00.000Z",
    hardExpiresAt: "2026-08-30T19:00:00.000Z",
  });
  const resource: HostedBrowserResourceRecord = {
    sessionId: session.sessionId,
    originatingTurnId: "turn-1",
    previewLeaseId: null,
    machineId: "machine-1",
    machineGeneration: 1,
    workerImageDigest: imageDigest,
    proxyAuthorityRevision: "revision-1",
    cleanupRequestedAt: null,
    cleanupConfirmedAt: null,
  };
  const terminalReasons: string[] = [];
  const deletedMachines: string[] = [];
  let cleanupConfirmed = 0;
  let touches = 0;
  const stateTransitions: string[] = [];
  const terminalMarks: Array<{
    expectedGeneration: number | undefined;
    expectedMachineId: string | undefined;
  }> = [];
  const preparedArtifacts: unknown[] = [];
  const authorizedArtifacts: Array<{
    generation: number;
    origin: typeof origin;
  }> = [];
  const canonicalizedArtifacts: Array<{ bytes: Buffer; sha256: string }> = [];
  const preparedUploads: unknown[] = [];
  const transferredUploads: Array<{ operationId: string; bytes: Buffer }> = [];
  const service = new HostedBrowserService({
    store: {
      async resolveOrigin() { return origin; },
      async createOpening() {},
      async attachMachine() {},
      async read() {
        if (
          options.terminalOnRead &&
          !["closed", "expired", "lost", "failed"].includes(session.state)
        ) {
          session = parseBrowserSessionV1({
            ...session,
            state: "lost",
            terminalReason: "BROWSER_SESSION_LOST",
            updatedAt: now.toISOString(),
          });
        }
        return { session, resource };
      },
      async readActiveForThread() { return { session, resource }; },
      async resolveCurrentOrigin() { return origin; },
      async updateSession(next) {
        if (options.terminalRaceOnReady) {
          session = parseBrowserSessionV1({
            ...session,
            state: "lost",
            terminalReason: "BROWSER_SESSION_LOST",
            updatedAt: now.toISOString(),
          });
          stateTransitions.push("lost");
          throw new Error("BROWSER_SESSION_LOST");
        }
        session = next;
        stateTransitions.push(next.state);
      },
      async touchActivity() {
        if (session.state !== "ready") throw new Error("BROWSER_SESSION_LOST");
        touches += 1;
      },
      async adoptRevision() {},
      async markTerminal(input) {
        terminalMarks.push({
          expectedGeneration: input.expectedGeneration,
          expectedMachineId: input.expectedMachineId,
        });
        if (["closed", "expired", "lost", "failed"].includes(session.state)) {
          return session;
        }
        terminalReasons.push(input.reason);
        session = parseBrowserSessionV1({
          ...session,
          state: input.state,
          terminalReason: input.reason,
          updatedAt: input.now.toISOString(),
        });
        stateTransitions.push(input.state);
        return session;
      },
      async confirmCleanup() { cleanupConfirmed += 1; },
      async listForReconciliation() { return []; },
    },
    policy: {
      async resolve() {
        return {
          resolution: {
            version: "browser_policy_resolution_v1",
            decision,
            code: decision === "allow" ? "BROWSER_POLICY_ALLOW" : "BROWSER_DESTINATION_BLOCKED",
            effectiveAllowlistRevision: authority.effectiveAllowlistRevision,
          },
          authority,
        } as never;
      },
    },
    machines: {
      async createBrowserMachine() { throw new Error("not used"); },
      async listBrowserMachines() { return []; },
      async getMachine() { return null; },
      async deleteMachine(input) {
        deletedMachines.push(input.machineId);
        if (options.machineDeleteFailure) {
          throw new Error("machine cleanup unavailable");
        }
      },
      async waitForMachine(input) {
        if (options.startupWaitFailure && input.state === "started") {
          throw new Error("startup failed");
        }
      },
    },
    artifacts: {
      async prepareScreenshotUpload(input) {
        preparedArtifacts.push(input);
        return {
          version: "hosted_browser_artifact_upload_instruction_v1",
          artifactId: `file-browser-${"a".repeat(64)}`,
          artifactKind: "browser-screenshot",
          uploadPath: `/api/runtime/browser-artifacts/file-browser-${"a".repeat(64)}`,
          capability: "host-private-capability",
          byteLength: input.byteLength,
          sha256: input.sha256,
          expiresAt: "2026-08-30T12:01:00.000Z",
        };
      },
      async authorize(input) {
        authorizedArtifacts.push({
          generation: input.generation,
          origin: input.origin,
        });
        return {
          version: "browser_authorized_artifact_v1",
          id: "file-browser-authorized",
          title: "Browser screenshot",
          kind: "browser-screenshot",
          url: "/api/files/file-browser-authorized/content",
          mediaType: "image/png",
          bytes: 9,
          sha256: "a".repeat(64),
        };
      },
      async canonicalizeRelayedScreenshot(input) {
        canonicalizedArtifacts.push({
          bytes: Buffer.from(input.bytes),
          sha256: input.sha256,
        });
        return {
          version: "browser_authorized_artifact_v1",
          id: "file-browser-authorized",
          title: "Browser screenshot",
          kind: "browser-screenshot",
          url: "/api/files/file-browser-authorized/content",
          mediaType: "image/png",
          bytes: input.bytes.byteLength,
          sha256: input.sha256,
        };
      },
    },
    metrics: { emit() {} },
    capabilityPrivateKeyPem: privateKeyPem,
    requestAuthority: {
      organizationId: "org-1",
      environmentId: "env-1",
      userId: "user-1",
    },
    appName: "kestrel-env-test",
    gatewayMachineId: "gateway-machine-1",
    region: "iad",
    runtimeImageDigest: imageDigest,
    routerUrl: "https://router.example.test",
    uploads: {
      async prepare(input) {
        preparedUploads.push(input);
        return {
          version: "browser_upload_preparation_v1",
          turnId: input.request.turnId,
          threadId: input.request.threadId,
          attachmentId: input.request.attachment.attachmentId,
          filename: input.request.attachment.filename,
          declaredMediaType: input.request.attachment.declaredMediaType,
          detectedMediaType: input.request.attachment.detectedMediaType,
          sizeBytes: input.request.attachment.sizeBytes,
          sha256: input.request.attachment.sha256,
          sessionId: String(input.request.effectiveInput.sessionId),
          generation: Number(input.request.effectiveInput.generation),
          snapshotId: String(input.request.effectiveInput.snapshotId),
          documentRevision: "document-1",
          targetRef: String(input.request.effectiveInput.targetRef),
          targetLabel: "Fixture attachment",
        };
      },
      async transfer(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
        transferredUploads.push({ operationId: input.operationId, bytes: Buffer.concat(chunks) });
      },
    },
    async resolveUploadAttachment(input) {
      assert.equal(input.turnId, "turn-1");
      assert.equal(input.attachmentId, "attachment-1");
      return {
        attachmentId: "attachment-1",
        threadId: "thread-1",
        filename: "evidence.txt",
        declaredMediaType: "text/plain",
        detectedMediaType: "text/plain",
        sizeBytes: 8,
        sha256: "a".repeat(64),
        async openStream() { return Readable.from(Buffer.from("12345678")); },
      };
    },
    now: () => now,
  });
  return {
    service,
    get session() { return session; },
    terminalReasons,
    deletedMachines,
    get cleanupConfirmed() { return cleanupConfirmed; },
    get touches() { return touches; },
    preparedArtifacts,
    authorizedArtifacts,
    canonicalizedArtifacts,
    preparedUploads,
    transferredUploads,
    stateTransitions,
    terminalMarks,
  };
}

function preparedOpen() {
  const descriptor = defaultToolCatalog.getDescriptorRef("browser.open");
  assert.ok(descriptor);
  return parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "runtime-session-1",
    callId: "call-open-1",
    activation: createToolActivationRefV1({
      descriptor,
      registryGeneration: "hosted-service-test",
      scopeFingerprint: fingerprintToolScopeV1({ hostedBrowser: true }),
    }),
    origin: { kind: "trusted_runtime", producerId: "test", adapterId: "test" },
    effectiveInput: {
      mode: "operator",
      target: { kind: "public_url", url: "https://example.com/" },
    },
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ revision: 1 }),
      reasonCode: "environment_policy",
    },
    preparedAt: now.toISOString(),
  });
}

function preparedCapture() {
  const descriptor = defaultToolCatalog.getDescriptorRef("browser.capture");
  assert.ok(descriptor);
  return parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "runtime-session-1",
    callId: "call-capture-1",
    activation: createToolActivationRefV1({
      descriptor,
      registryGeneration: "hosted-service-test",
      scopeFingerprint: fingerprintToolScopeV1({ hostedBrowser: true }),
    }),
    origin: { kind: "trusted_runtime", producerId: "test", adapterId: "test" },
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      kind: "screenshot",
    },
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ revision: 1 }),
      reasonCode: "environment_policy",
    },
    preparedAt: now.toISOString(),
  });
}

function preparedUpload(effect: Awaited<ReturnType<HostedBrowserService["prepareUpload"]>>) {
  const descriptor = defaultToolCatalog.getDescriptorRef("browser.upload");
  assert.ok(descriptor);
  return parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "runtime-session-1",
    callId: "call-upload-1",
    activation: createToolActivationRefV1({
      descriptor,
      registryGeneration: "hosted-service-test",
      scopeFingerprint: fingerprintToolScopeV1({ hostedBrowser: true }),
    }),
    origin: { kind: "trusted_runtime", producerId: "test", adapterId: "test" },
    effectiveInput: {
      sessionId: effect.sessionId,
      generation: effect.generation,
      snapshotId: effect.snapshotId,
      targetRef: effect.targetRef,
      attachmentId: effect.attachmentId,
    },
    inputAdapters: [{
      adapterId: "kestrel.browser-upload-effect:v1",
      metadata: { ...effect },
    }],
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ revision: 1 }),
      reasonCode: "environment_policy",
    },
    preparedAt: now.toISOString(),
  });
}

function acceptedReceipt(
  operationId: string,
  sessionId: string,
  capabilityNow = now,
  expiresAt = new Date(now.getTime() + 30_000),
  operation = "browser.open",
): HostedBrowserRelayAcceptanceV1 {
  const capability = issueHostedBrowserOperationCapability({
    privateKeyPem,
    now: capabilityNow,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      userId: "user-1",
      threadId: "thread-1",
      sessionId,
      generation: 1,
      operationId,
      effectiveAllowlistRevision: "revision-1",
      expiresAt: expiresAt.toISOString(),
    },
  });
  return {
    version: "hosted_browser_relay_acceptance_v1",
    receiptId: "receipt-1",
    instruction: {
      version: "hosted_browser_relay_instruction_v1",
      phase: "accept",
      operationId,
      operation,
      sessionId,
      generation: 1,
      capability,
      machine: { appName: "kestrel-env-test", machineId: "machine-1" },
    },
    worker: {
      accepted: true,
      operationId,
      sessionId,
      generation: 1,
      identity: {
        sessionId,
        generation: 1,
        engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
        chromeRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
        imageDigest,
      },
    },
  };
}

function readCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}
