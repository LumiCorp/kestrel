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
  verifyHostedBrowserCapabilitySignature,
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
  },
  ],
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

test("Gateway startup failure terminalizes and cleans only the exact opening operation", async () => {
  const fixture = serviceFixture("opening", "allow");
  const prepared = preparedOpen();
  const accepted = acceptedReceipt(prepared.callId, fixture.session.sessionId);
  const cleaned = await fixture.service.failOpeningOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    {
      ...accepted.instruction,
      prepared,
    },
  );
  assert.equal(cleaned, true);
  assert.deepEqual(fixture.terminalReasons, ["BROWSER_ENGINE_FAILURE"]);
  assert.deepEqual(fixture.deletedMachines, ["machine-1"]);
  assert.equal(fixture.cleanupConfirmed, 1);
});

test("Gateway startup failure cannot delete a ready session or an altered opening identity", async () => {
  const prepared = preparedOpen();
  const ready = serviceFixture("ready", "allow");
  const readyInstruction = acceptedReceipt(
    prepared.callId,
    ready.session.sessionId,
  ).instruction;
  assert.equal(await ready.service.failOpeningOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    { ...readyInstruction, prepared },
  ), false);
  assert.deepEqual(ready.deletedMachines, []);

  const opening = serviceFixture("opening", "allow");
  const openingInstruction = acceptedReceipt(
    prepared.callId,
    opening.session.sessionId,
  ).instruction;
  assert.equal(await opening.service.failOpeningOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    {
      ...openingInstruction,
      machine: { ...openingInstruction.machine, machineId: "machine-other" },
      prepared,
    },
  ), false);
  assert.deepEqual(opening.deletedMachines, []);
});

for (const field of ["organizationId", "environmentId", "projectId", "userId", "threadId", "sessionId", "generation", "operationId", "effectiveAllowlistRevision"] as const) {
  test(`startup failure rejects a signed capability for a different ${field}`, async () => {
    const fixture = serviceFixture("opening", "allow");
    const prepared = preparedOpen();
    const instruction = acceptedReceipt(prepared.callId, fixture.session.sessionId).instruction;
    const capability = issueHostedBrowserOperationCapability({
      privateKeyPem, now,
      claims: {
        version: HOSTED_BROWSER_CAPABILITY_VERSION,
        organizationId: "org-1", environmentId: "env-1", projectId: "project-1",
        userId: "user-1", threadId: "thread-1", sessionId: fixture.session.sessionId,
        generation: 1, operationId: prepared.callId, effectiveAllowlistRevision: "revision-1",
        expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        [field]: field === "generation" ? 2 : "different",
      },
    });
    assert.equal(await fixture.service.failOpeningOperation(prepared,
      { threadId: "thread-1", projectId: "project-1" },
      { ...instruction, prepared, capability }), false);
    assert.deepEqual(fixture.deletedMachines, []);
    assert.deepEqual(fixture.terminalReasons, []);
    assert.equal(fixture.cleanupConfirmed, 0);
  });
}

for (const change of ["capability", "session", "generation", "app", "operation", "prepared"] as const) {
  test(`startup failure rejects altered ${change} instructions`, async () => {
    const fixture = serviceFixture("opening", "allow");
    const prepared = preparedOpen();
    const instruction = { ...acceptedReceipt(prepared.callId, fixture.session.sessionId).instruction, prepared };
    if (change === "capability") instruction.capability = "forged";
    if (change === "session") instruction.sessionId = "different";
    if (change === "generation") instruction.generation = 2;
    if (change === "app") instruction.machine = { ...instruction.machine, appName: "different" };
    if (change === "operation") instruction.operationId = "different";
    if (change === "prepared") instruction.prepared = { ...prepared, callId: "different" };
    assert.equal(await fixture.service.failOpeningOperation(prepared,
      { threadId: "thread-1", projectId: "project-1" }, instruction), false);
    assert.deepEqual(fixture.deletedMachines, []);
    assert.deepEqual(fixture.terminalReasons, []);
    assert.equal(fixture.cleanupConfirmed, 0);
  });
}

test("startup failure cannot delete a session that becomes ready before terminalization", async () => {
  const fixture = serviceFixture("opening", "allow", { readyRaceOnTerminal: true });
  const prepared = preparedOpen();
  const instruction = acceptedReceipt(prepared.callId, fixture.session.sessionId).instruction;
  assert.equal(await fixture.service.failOpeningOperation(prepared,
    { threadId: "thread-1", projectId: "project-1" }, { ...instruction, prepared }), false);
  assert.equal(fixture.session.state, "ready");
  assert.deepEqual(fixture.deletedMachines, []);
  assert.equal(fixture.cleanupConfirmed, 0);
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

test("hosted Browser provisioning waits up to 60 seconds for Machine start", async () => {
  const fixture = serviceFixture("opening", "allow");
  await fixture.service.acceptOperation(preparedOpen(), {
    threadId: "thread-1",
    projectId: "project-1",
  });
  assert.deepEqual(fixture.startedTimeouts, [60]);
});

test("hosted opening retains signed authority after slow readiness and still expires", async () => {
  const fixture = serviceFixture("opening", "allow");
  const instruction = await fixture.service.acceptOperation(preparedOpen(), {
    threadId: "thread-1", projectId: "project-1",
  });
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const verifyAt = (elapsedMs: number) => verifyHostedBrowserCapabilitySignature({
    token: instruction.capability, publicKeyPem,
    now: new Date(now.getTime() + elapsedMs),
  });
  assert.equal(Date.parse(verifyAt(120_000).expiresAt) - now.getTime(), 300_000);
  assert.equal(verifyAt(299_999).operationId, instruction.operationId);
  assert.throws(() => verifyAt(300_000), /expired/u);
});

test("hosted acceptance reports the safe failure stage for unavailable origin authority", async () => {
  const fixture = serviceFixture("opening", "allow", {
    originFailure: true,
  });
  await assert.rejects(
    fixture.service.acceptOperation(preparedOpen(), {
      threadId: "thread-1",
      projectId: "project-1",
    }),
    (error: unknown) =>
      readCode(error) === "BROWSER_SERVICE_UNAVAILABLE" &&
      Boolean(
        error &&
        typeof error === "object" &&
        "details" in error &&
        (error.details as { failureStage?: unknown })?.failureStage ===
          "accept.origin",
      ),
  );
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
  },
  ]);
  assert.equal(fixture.cleanupConfirmed, 0);
});

test("only successful validated open completion promotes the stored session to ready", async () => {
  const fixture = serviceFixture("opening", "allow");
  const prepared = preparedOpen();
  const opening = fixture.session;
  const receipt = acceptedReceipt(prepared.callId, opening.sessionId);
  const result = (await fixture.service.completeAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
    {
      version: "browser_tool_result_v1",
      operation: "browser.open",
      outcome: "opened",
      session: { ...opening, state: "ready" },
    },
  )) as { session: { state: string } };
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
  ), (error: unknown) => readCode(error) === "BROWSER_ENGINE_FAILURE",
  );
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
  ), (error: unknown) => readCode(error) === "BROWSER_ENGINE_FAILURE",
  );
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
  const result = (await fixture.service.completeAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
    {
      version: "browser_tool_result_v1",
      operation: "browser.open",
      outcome: "opened",
      session: forgedLifecycle,
    },
  )) as { session: unknown };
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
  },
  ]);
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
  },
  ]);
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
  const result = (await fixture.service.completeAcceptedOperation(
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
  )) as { artifact: { id: string; url: string } };
  assert.equal(result.artifact.id, "file-browser-authorized");
  assert.equal(result.artifact.url, "/api/files/file-browser-authorized/content",
  );
  assert.equal(fixture.canonicalizedArtifacts[0]?.bytes.toString("hex"), png.toString("hex"),
  );
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

test("hosted download uploads a deterministic Thread draft before dispatch and commits one artifact", async () => {
  const fixture = serviceFixture("ready", "allow");
  const request = {
    version: "browser_download_preparation_v1" as const,
    runId: "run-1",
    threadId: "thread-1",
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      pendingDownloadId: "download-1",
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  };
  const effect = await fixture.service.prepareDownload(request);
  const prepared = preparedDownload(effect);
  const receipt = acceptedReceipt(
    prepared.callId,
    "browser-session-1",
    now,
    new Date(now.getTime() + 30_000),
    "browser.download",
  );
  const instruction = await fixture.service.dispatchAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
  );
  assert.equal(instruction.phase, "invoke");
  assert.equal(fixture.preparedDownloads.length, 1);
  assert.deepEqual(fixture.stagedDownloads, [
    {
    operationId: prepared.callId,
    bytes: Buffer.from("hosted-download"),
    },
  ]);
  const output = await fixture.service.completeAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
    { version: "hosted_browser_download_result_v1", download: effect },
  );
  assert.equal(
    (output as Record<string, unknown>).operation,
    "browser.download",
  );
  assert.equal(
    ((output as Record<string, unknown>).artifact as Record<string, unknown>)
      .kind,
    "browser-download",
  );
  assert.deepEqual(fixture.committedDownloads, [prepared.callId]);
});

test("hosted download distinguishes invalid worker proof from an unknown visibility commit", async () => {
  const fixture = serviceFixture("ready", "allow", { downloadCommitFailure: true,
  });
  const request = {
    version: "browser_download_preparation_v1" as const,
    runId: "run-1",
    threadId: "thread-1",
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      pendingDownloadId: "download-1",
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  };
  const effect = await fixture.service.prepareDownload(request);
  const prepared = preparedDownload(effect);
  const receipt = acceptedReceipt(
    prepared.callId,
    "browser-session-1",
    now,
    new Date(now.getTime() + 30_000),
    "browser.download",
  );
  await fixture.service.dispatchAcceptedOperation(
    prepared,
    { threadId: "thread-1", projectId: "project-1" },
    receipt,
  );
  await assert.rejects(
    fixture.service.completeAcceptedOperation(
      prepared,
      { threadId: "thread-1", projectId: "project-1" },
      receipt,
      { version: "hosted_browser_download_result_v1", download: effect },
    ),
    (error: unknown) => readCode(error) === "BROWSER_ACTION_OUTCOME_UNKNOWN",
  );
  await assert.rejects(
    fixture.service.completeAcceptedOperation(
      prepared,
      { threadId: "thread-1", projectId: "project-1" },
      receipt,
      { version: "hosted_browser_download_result_v1", download: { ...effect, sha256: "a".repeat(64) },
      },
    ),
    (error: unknown) => readCode(error) === "BROWSER_DOWNLOAD_UNAVAILABLE",
  );
  assert.deepEqual(fixture.terminalMarks, []);
});

test("hosted download response-loss replay does not reopen bytes for a reconciled ready file", async () => {
  const fixture = serviceFixture("ready", "allow", {
    downloadFileState: "ready",
  });
  const request = {
    version: "browser_download_preparation_v1" as const,
    runId: "run-1",
    threadId: "thread-1",
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      pendingDownloadId: "download-1",
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  };
  const effect = await fixture.service.prepareDownload(request);
  const prepared = preparedDownload(effect);
  const receipt = acceptedReceipt(
    prepared.callId,
    "browser-session-1",
    now,
    new Date(now.getTime() + 30_000),
    "browser.download",
  );
  await fixture.service.dispatchAcceptedOperation(
    prepared,
    request.authority,
    receipt,
  );
  assert.equal(fixture.openedDownloads, 0);
  assert.deepEqual(fixture.stagedDownloads, []);
});

test("hosted download open failure leaves the deterministic draft for generic cleanup", async () => {
  const fixture = serviceFixture("ready", "allow", {
    downloadOpenFailure: true,
  });
  const request = {
    version: "browser_download_preparation_v1" as const,
    runId: "run-1",
    threadId: "thread-1",
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      pendingDownloadId: "download-1",
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  };
  const effect = await fixture.service.prepareDownload(request);
  const prepared = preparedDownload(effect);
  const receipt = acceptedReceipt(
    prepared.callId,
    "browser-session-1",
    now,
    new Date(now.getTime() + 30_000),
    "browser.download",
  );
  await assert.rejects(
    fixture.service.dispatchAcceptedOperation(
      prepared,
      request.authority,
      receipt,
    ),
    (error: unknown) =>
      readCode(error) === "BROWSER_SERVICE_UNAVAILABLE" &&
      Boolean(
        error &&
        typeof error === "object" &&
        "details" in error &&
        (error.details as { browserOutcomeKnown?: unknown })
          ?.browserOutcomeKnown === true,
      ),
  );
  assert.deepEqual(fixture.preparedDownloadExpiries, [effect.expiresAt]);
  assert.equal(fixture.openedDownloads, 1);
});

test("hosted download preserves a ready-file response-loss outcome as unknown", async () => {
  const fixture = serviceFixture("ready", "allow", {
    downloadUploadFailure: "unknown",
  });
  const request = {
    version: "browser_download_preparation_v1" as const,
    runId: "run-1",
    threadId: "thread-1",
    effectiveInput: {
      sessionId: "browser-session-1",
      generation: 1,
      pendingDownloadId: "download-1",
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  };
  const effect = await fixture.service.prepareDownload(request);
  const prepared = preparedDownload(effect);
  const receipt = acceptedReceipt(
    prepared.callId,
    "browser-session-1",
    now,
    new Date(now.getTime() + 30_000),
    "browser.download",
  );
  await assert.rejects(
    fixture.service.dispatchAcceptedOperation(
      prepared,
      request.authority,
      receipt,
    ),
    (error: unknown) =>
      readCode(error) === "BROWSER_ACTION_OUTCOME_UNKNOWN" &&
      Boolean(
        error &&
        typeof error === "object" &&
        "details" in error &&
        (error.details as { browserOutcomeKnown?: unknown })
          ?.browserOutcomeKnown === false,
      ),
  );
  assert.equal(fixture.openedDownloads, 1);
});

function serviceFixture(
  state: "opening" | "ready",
  decision: "allow" | "deny",
  options: {
    originFailure?: boolean;
    terminalRaceOnReady?: boolean;
    startupWaitFailure?: boolean;
    readyRaceOnTerminal?: boolean;
    terminalOnRead?: boolean;
    machineDeleteFailure?: boolean;
    downloadCommitFailure?: boolean;
    downloadOpenFailure?: boolean;
    downloadFileState?: "upload_required" | "ready";
    downloadUploadFailure?: "known" | "unknown";
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
  const startedTimeouts: number[] = [];
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
  const preparedDownloads: unknown[] = [];
  const stagedDownloads: Array<{ operationId: string; bytes: Buffer }> = [];
  const preparedDownloadExpiries: string[] = [];
  let openedDownloads = 0;
  const committedDownloads: string[] = [];
  const downloadBytes = Buffer.from("hosted-download");
  const service = new HostedBrowserService({
    store: {
      async resolveOrigin() {
        if (options.originFailure) {
          throw new Error("BROWSER_SERVICE_UNAVAILABLE");
        }
        return origin;
      },
      async createOpening() {},
      async attachMachine() {},
      async read(sessionId) {
        if (sessionId !== session.sessionId) return null;
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
        if (options.readyRaceOnTerminal) session = parseBrowserSessionV1({ ...session, state: "ready" });
        if (input.expectedState !== undefined && session.state !== input.expectedState) {
          throw new Error("BROWSER_SESSION_LOST");
        }
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
      async getMachine(input) {
        if (deletedMachines.includes(input.machineId)) return null;
        return {
          id: input.machineId,
          name: input.machineId,
          state: "started",
          region: "iad",
          resolvedImageDigest: imageDigest.split("@").at(-1),
          mounts: [],
          browserSessionId: session.sessionId,
          browserGeneration: session.generation,
        };
      },
      async deleteMachine(input) {
        deletedMachines.push(input.machineId);
        if (options.machineDeleteFailure) {
          throw new Error("machine cleanup unavailable");
        }
      },
      async waitForMachine(input) {
        if (input.state === "started") {
          startedTimeouts.push(input.timeoutSeconds ?? 0);
        }
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
      async uploadDownload(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
        stagedDownloads.push({
          operationId: input.operationId,
          bytes: Buffer.concat(chunks),
        });
        if (options.downloadUploadFailure === "unknown") {
          throw Object.assign(new Error("ready file response lost"), {
            code: "BROWSER_ACTION_OUTCOME_UNKNOWN",
            details: { browserOutcomeKnown: false },
          });
        }
        if (options.downloadUploadFailure === "known") {
          throw new Error("download upload rejected before commit");
        }
      },
      async prepareDownload(input) {
        preparedDownloadExpiries.push(input.expiresAt);
        return options.downloadFileState ?? "upload_required";
      },
      async commitDownload(input) {
        if (options.downloadCommitFailure === true) {
          throw new Error("visibility commit response lost");
        }
        committedDownloads.push(input.operationId);
        return {
          version: "browser_authorized_artifact_v1",
          id: `file-browser-${"d".repeat(64)}`,
          title: input.filename,
          kind: "browser-download",
          mediaType: input.declaredMediaType,
          bytes: input.sizeBytes,
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
        transferredUploads.push({
          operationId: input.operationId,
          bytes: Buffer.concat(chunks),
        });
      },
    },
    downloads: {
      async prepare(input) {
        preparedDownloads.push(input);
        return {
          version: "browser_download_preparation_v1",
          threadId: input.request.threadId,
          sessionId: String(input.request.effectiveInput.sessionId),
          generation: Number(input.request.effectiveInput.generation),
          pendingDownloadId: String(
            input.request.effectiveInput.pendingDownloadId,
          ),
          filename: "report.bin",
          measuredBytes: downloadBytes.byteLength,
          sha256: createHash("sha256").update(downloadBytes).digest("hex"),
          declaredMediaType: "application/octet-stream",
          normalizedSourceOrigin: "https://example.com",
          createdAt: "2026-08-30T11:55:00.000Z",
          expiresAt: "2026-08-30T12:25:00.000Z",
        };
      },
      async open() {
        openedDownloads += 1;
        if (options.downloadOpenFailure)
          throw new Error("worker byte stream unavailable");
        return Readable.from(downloadBytes);
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
        async openStream() {
          return Readable.from(Buffer.from("12345678"));
        },
      };
    },
    now: () => now,
  });
  return {
    service,
    get session() {
      return session;
    },
    terminalReasons,
    deletedMachines,
    get cleanupConfirmed() {
      return cleanupConfirmed;
    },
    get touches() {
      return touches;
    },
    preparedArtifacts,
    authorizedArtifacts,
    canonicalizedArtifacts,
    preparedUploads,
    transferredUploads,
    preparedDownloads,
    stagedDownloads,
    preparedDownloadExpiries,
    get openedDownloads() {
      return openedDownloads;
    },
    committedDownloads,
    stateTransitions,
    terminalMarks,
    startedTimeouts,
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

function preparedUpload(effect: Awaited<ReturnType<HostedBrowserService["prepareUpload"]>>,
) {
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
    },
    ],
    policy: {
      decision: "allow",
      policyRevision: hashCanonical({ revision: 1 }),
      reasonCode: "environment_policy",
    },
    preparedAt: now.toISOString(),
  });
}

function preparedDownload(effect: Awaited<ReturnType<HostedBrowserService["prepareDownload"]>>,
) {
  const descriptor = defaultToolCatalog.getDescriptorRef("browser.download");
  assert.ok(descriptor);
  return parsePreparedToolCallV1({
    version: "v1",
    runId: "run-1",
    sessionId: "runtime-session-1",
    callId: "call-download-1",
    activation: createToolActivationRefV1({
      descriptor,
      registryGeneration: "hosted-service-test",
      scopeFingerprint: fingerprintToolScopeV1({ hostedBrowser: true }),
    }),
    origin: { kind: "trusted_runtime", producerId: "test", adapterId: "test" },
    effectiveInput: {
      sessionId: effect.sessionId,
      generation: effect.generation,
      pendingDownloadId: effect.pendingDownloadId,
    },
    inputAdapters: [{
      adapterId: "kestrel.browser-download-effect:v1",
      metadata: { ...effect },
    },
    ],
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
      authority,
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
