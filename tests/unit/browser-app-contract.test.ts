import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_APP_CONTRACT_FIXTURE,
  getBrowserToolContract,
} from "../../src/browser/browserAppContract.fixture.js";
import {
  BROWSER_FAILURE_CODES,
  BROWSER_SERVICE_PORT_VERSION,
  BROWSER_TOOL_NAMES,
  browserFailure,
  parseBrowserSessionV1,
  projectBrowserAuditInput,
  projectBrowserAuditOutput,
  validateBrowserResultAuthority,
  type BrowserServicePort,
} from "../../src/browser/contracts.js";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../src/browser/runtimeReleaseManifest.js";
import {
  compileToolJsonSchemaV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import type { PreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import { derivePreparedToolApprovalAuthorityRevisionV1 } from "../../src/io/ToolInvocationSupport.js";
import {
  buildRunToolEvent,
  buildRunToolUpdate,
} from "../../src/engine/RuntimeIO.js";
import { UnifiedToolRegistry } from "../../tools/runtime/UnifiedToolRegistry.js";
import { defaultToolCatalog } from "../../tools/catalog.js";

const session = {
  version: "browser_session_v1",
  sessionId: "browser-session-1",
  threadId: "thread-1",
  mode: "operator",
  state: "ready",
  engineRevision: "agent-browser:v0.35.0",
  generation: 1,
  effectiveAllowlistRevision: "allowlist-1",
  createdAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:01.000Z",
  lastActivityAt: "2026-08-29T12:00:01.000Z",
  idleExpiresAt: "2026-08-29T12:30:00.000Z",
  hardExpiresAt: "2026-08-29T20:00:00.000Z",
};

const validInputs: Record<
  (typeof BROWSER_TOOL_NAMES)[number],
  Record<string, unknown>
> = {
  "browser.open": {
    mode: "operator",
    target: { kind: "public_url", url: "https://example.com" },
  },
  "browser.request_grant": {
    sessionId: "browser-session-1",
    generation: 1,
    destination: "https://example.com",
  },
  "browser.snapshot": { sessionId: "browser-session-1", generation: 1 },
  "browser.inspect": {
    sessionId: "browser-session-1",
    generation: 1,
    kind: "console_errors",
  },
  "browser.navigate": {
    sessionId: "browser-session-1",
    generation: 1,
    kind: "reload",
  },
  "browser.interact": {
    sessionId: "browser-session-1",
    generation: 1,
    snapshotId: "snapshot-1",
    documentRevision: "document-1",
    tabId: "tab-1",
    action: { kind: "click", ref: "ref-1" },
  },
  "browser.tabs": {
    sessionId: "browser-session-1",
    generation: 1,
    operation: "list",
  },
  "browser.capture": {
    sessionId: "browser-session-1",
    generation: 1,
    kind: "screenshot",
  },
  "browser.upload": {
    sessionId: "browser-session-1",
    generation: 1,
    snapshotId: "snapshot-1",
    targetRef: "ref-1",
    attachmentId: "attachment-1",
  },
  "browser.download": {
    sessionId: "browser-session-1",
    generation: 1,
    pendingDownloadId: "download-1",
  },
  "browser.request_takeover": {
    sessionId: "browser-session-1",
    generation: 1,
    reason: "Authentication required",
  },
  "browser.close": { sessionId: "browser-session-1", generation: 1 },
};

const commonOperationOutput = (operation: string) => ({
  version: "browser_tool_result_v1",
  operation,
  sessionId: "browser-session-1",
  generation: 1,
});

const validOutputs: Record<
  (typeof BROWSER_TOOL_NAMES)[number],
  Record<string, unknown>
> = {
  "browser.open": {
    version: "browser_tool_result_v1",
    operation: "browser.open",
    outcome: "opened",
    session,
  },
  "browser.request_grant": {
    version: "browser_tool_result_v1",
    operation: "browser.request_grant",
    sessionId: "browser-session-1",
    outcome: "already_allowed",
    canonicalWildcard: "*.example.com",
    effectiveAllowlistRevision: "allowlist-1",
  },
  "browser.snapshot": {
    ...commonOperationOutput("browser.snapshot"),
    snapshotId: "snapshot-1",
    documentRevision: "document-1",
    normalizedOrigin: "https://example.com",
    capturedAt: "2026-08-29T12:00:00.000Z",
    boundary: "untrusted_browser_content",
    title: "Example",
    content: "button ref=ref-1",
    complete: true,
  },
  "browser.inspect": {
    ...commonOperationOutput("browser.inspect"),
    snapshotId: "snapshot-1",
    documentRevision: "document-1",
    normalizedOrigin: "https://example.com",
    capturedAt: "2026-08-29T12:00:00.000Z",
    boundary: "untrusted_browser_content",
    kind: "console_errors",
    content: "",
    complete: true,
  },
  "browser.navigate": {
    ...commonOperationOutput("browser.navigate"),
    outcome: "completed",
    normalizedOrigin: "https://example.com",
  },
  "browser.interact": {
    ...commonOperationOutput("browser.interact"),
    outcome: "completed",
    documentRevision: "document-2",
  },
  "browser.tabs": {
    ...commonOperationOutput("browser.tabs"),
    capturedAt: "2026-08-29T12:00:00.000Z",
    boundary: "untrusted_browser_content",
    activeTabId: "tab-1",
    tabs: [
      {
        tabId: "tab-1",
        normalizedOrigin: "https://example.com",
        title: "Example",
        active: true,
      },
    ],
  },
  "browser.capture": {
    ...commonOperationOutput("browser.capture"),
    artifact: {
      id: "artifact-1",
      title: "Screenshot",
      kind: "browser-screenshot",
      mediaType: "image/png",
      bytes: 10,
      sha256: "a".repeat(64),
    },
    normalizedOrigin: "https://example.com",
    capturedAt: "2026-08-29T12:00:00.000Z",
    boundary: "untrusted_browser_content",
  },
  "browser.upload": {
    ...commonOperationOutput("browser.upload"),
    outcome: "uploaded",
    attachmentId: "attachment-1",
  },
  "browser.download": {
    ...commonOperationOutput("browser.download"),
    artifact: {
      id: "artifact-2",
      title: "Download",
      kind: "browser-download",
      mediaType: "application/octet-stream",
      bytes: 10,
      sha256: "b".repeat(64),
    },
  },
  "browser.request_takeover": {
    ...commonOperationOutput("browser.request_takeover"),
    outcome: "takeover_requested",
    state: "ready",
  },
  "browser.close": {
    version: "browser_tool_result_v1",
    operation: "browser.close",
    sessionId: "browser-session-1",
    state: "closed",
  },
};

test("Browser App fixture pins the exact stable surface without raw controls", () => {
  assert.equal(BROWSER_APP_CONTRACT_FIXTURE.appId, "built_in.browser");
  assert.deepEqual(
    BROWSER_APP_CONTRACT_FIXTURE.tools.map((tool) => tool.toolId),
    BROWSER_TOOL_NAMES,
  );
  assert.equal(
    BROWSER_TOOL_NAMES.includes("browser.return_control" as never),
    false,
  );
  assert.equal(BROWSER_APP_CONTRACT_FIXTURE.rawEngineControlsExposed, false);
  assert.deepEqual(
    new Set(
      BROWSER_APP_CONTRACT_FIXTURE.tools.flatMap((tool) => tool.failureCodes),
    ),
    new Set(BROWSER_FAILURE_CODES),
  );
  assert.deepEqual(
    getBrowserToolContract("browser.upload").approval,
    "always_approval",
  );
  assert.deepEqual(
    getBrowserToolContract("browser.request_grant").approval,
    "dynamic_personal_grant",
  );
});

test("catalog descriptors are derived byte-for-byte from the Browser fixture", () => {
  for (const contract of BROWSER_APP_CONTRACT_FIXTURE.tools) {
    const descriptor = defaultToolCatalog.getDescriptor(contract.toolId);
    assert.ok(descriptor, contract.toolId);
    assert.deepEqual(descriptor.inputSchema, contract.inputSchema);
    assert.deepEqual(descriptor.runtimeOutput.schema, contract.outputSchema);
    assert.equal(
      descriptor.capability.executionClass,
      contract.executionClass,
      contract.toolId,
    );
    assert.equal(descriptor.presentation.toolFamily, "browser");
  }
  assert.equal(
    defaultToolCatalog.getDescriptor("browser.upload")?.capability
      .inputDependentPreparation,
    true,
  );
  assert.equal(
    defaultToolCatalog.getDescriptor("browser.download")?.capability
      .inputDependentPreparation,
    true,
  );
});

test("every Browser schema accepts its fixture and rejects unknown fields", () => {
  for (const contract of BROWSER_APP_CONTRACT_FIXTURE.tools) {
    const validateInput = compileToolJsonSchemaV1(contract.inputSchema, {
      surface: "input",
    });
    const validateOutput = compileToolJsonSchemaV1(contract.outputSchema, {
      surface: "output",
    });
    assert.equal(
      validateInput(validInputs[contract.toolId]),
      true,
      contract.toolId,
    );
    assert.equal(
      validateOutput(validOutputs[contract.toolId]),
      true,
      contract.toolId,
    );
    assert.equal(
      validateInput({ ...validInputs[contract.toolId], rawCdp: true }),
      false,
      `${contract.toolId} input leaked raw controls`,
    );
    assert.equal(
      validateOutput({ ...validOutputs[contract.toolId], enginePayload: {} }),
      false,
      `${contract.toolId} output leaked a host variant`,
    );
  }
});

test("Browser input schemas accept only typed targets and snapshot refs", () => {
  const open = compileToolJsonSchemaV1(
    getBrowserToolContract("browser.open").inputSchema,
    { surface: "input" },
  );
  assert.equal(
    open({
      mode: "qa",
      target: {
        kind: "desktop_project_run",
        projectId: "project-1",
        runId: "run-1",
        urlId: "url-1",
      },
    }),
    true,
  );
  assert.equal(
    open({
      mode: "qa",
      target: { kind: "localhost", host: "127.0.0.1", port: 3000 },
    }),
    false,
  );
  assert.equal(
    open({
      mode: "operator",
      target: { kind: "public_url", url: "https://example.com" },
    }),
    true,
  );
  assert.equal(
    open({
      mode: "operator",
      target: { kind: "kestrel_edge_preview", previewId: "preview-1" },
    }),
    false,
  );

  const interact = compileToolJsonSchemaV1(
    getBrowserToolContract("browser.interact").inputSchema,
    { surface: "input" },
  );
  assert.equal(
    interact({
      sessionId: "session-1",
      generation: 1,
      snapshotId: "snapshot-1",
      documentRevision: "document-1",
      tabId: "tab-1",
      action: { kind: "click", ref: "ref-7" },
    }),
    true,
  );
  assert.equal(
    interact({
      sessionId: "session-1",
      generation: 1,
      snapshotId: "snapshot-1",
      documentRevision: "document-1",
      tabId: "tab-1",
      action: { kind: "click", selector: "#submit" },
    }),
    false,
  );
  assert.equal(
    interact({
      sessionId: "session-1",
      snapshotId: "snapshot-1",
      documentRevision: "document-1",
      tabId: "tab-1",
      action: { kind: "evaluate", script: "document.cookie" },
    }),
    false,
  );
});

test("BrowserSessionV1 parser is strict and lifecycle-complete", () => {
  assert.deepEqual(parseBrowserSessionV1(session), session);
  assert.throws(
    () => parseBrowserSessionV1({ ...session, cookieJar: "forbidden" }),
    /unknown field 'cookieJar'/u,
  );
  assert.throws(
    () => parseBrowserSessionV1({ ...session, state: "paused" }),
    /state is invalid/u,
  );
  assert.throws(
    () => parseBrowserSessionV1({ ...session, sessionId: "../browser-owned" }),
    /path-safe opaque identifier/u,
  );
  assert.throws(
    () =>
      parseBrowserSessionV1({
        ...session,
        idleExpiresAt: "2026-08-30T12:00:00.000Z",
      }),
    /cannot follow hardExpiresAt/u,
  );
});

test("Browser audit projection redacts fill and type values", () => {
  const secret = "ordinary-text-that-must-not-be-durable";
  const projected = projectBrowserAuditInput("browser.interact", {
    sessionId: "browser-session-1",
    snapshotId: "snapshot-1",
    documentRevision: "document-1",
    tabId: "tab-1",
    action: { kind: "fill", ref: "ref-1", text: secret },
  });

  assert.deepEqual(projected, {
    sessionId: "browser-session-1",
    snapshotId: "snapshot-1",
    documentRevision: "document-1",
    tabId: "tab-1",
    action: {
      kind: "fill",
      ref: "ref-1",
      characterCount: secret.length,
    },
  });
  assert.doesNotMatch(JSON.stringify(projected), /ordinary-text/u);
});

test("Browser generic run events redact started, completed, failed, and replay evidence", async () => {
  const fillSentinel = "browser-fill-secret-sentinel";
  const pageSentinel = "browser-page-secret-sentinel";
  const failureSentinel = "browser-failure-secret-sentinel";
  const { prepared } = await prepareBrowserCall(
    new UnifiedToolRegistry({
      allowlist: ["browser.snapshot"],
      context: { browserService: passiveBrowserPort() },
    }),
    "browser.snapshot",
    validInputs["browser.snapshot"],
  );
  const started = buildRunToolUpdate({
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    seq: 1,
    toolCallId: prepared.callId,
    toolName: "browser.interact",
    phase: "started",
    input: {
      ...validInputs["browser.interact"],
      action: { kind: "fill", ref: "ref-1", text: fillSentinel },
    },
  });
  const completed = buildRunToolUpdate({
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    seq: 2,
    toolCallId: prepared.callId,
    toolName: "browser.snapshot",
    phase: "completed",
    activation: prepared.activation,
    output: {
      auditRecord: {
        output: { ...validOutputs["browser.snapshot"], content: pageSentinel },
      },
    } as never,
    outcome: {
      version: "v1",
      callId: prepared.callId,
      activation: prepared.activation,
      kind: "success",
      startedAt: "2026-08-29T12:00:00.000Z",
      completedAt: "2026-08-29T12:00:01.000Z",
      effectState: "not_applicable",
      rawOutput: { ...validOutputs["browser.snapshot"], content: pageSentinel },
    },
  });
  const failed = buildRunToolUpdate({
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    seq: 3,
    toolCallId: prepared.callId,
    toolName: "browser.snapshot",
    phase: "failed",
    error: {
      code: "BROWSER_TARGET_STALE",
      message: failureSentinel,
      details: { pageBody: pageSentinel, credential: fillSentinel },
    },
  });
  const persistedEvidence = JSON.stringify([
    buildRunToolEvent(started),
    buildRunToolEvent(completed),
    buildRunToolEvent(failed),
  ]);

  assert.doesNotMatch(
    persistedEvidence,
    new RegExp(`${fillSentinel}|${pageSentinel}|${failureSentinel}`),
  );
  assert.match(persistedEvidence, /browser\.interact|browser\.snapshot/u);
  assert.match(persistedEvidence, /BROWSER_TARGET_STALE/u);
  assert.match(persistedEvidence, /characterCount/u);
});

test("Browser tools remain unavailable until a conforming host port is active", () => {
  const unavailable = new UnifiedToolRegistry({
    allowlist: [...BROWSER_TOOL_NAMES],
  });
  assert.deepEqual(unavailable.getModelTools(), []);

  const port: BrowserServicePort = {
    version: BROWSER_SERVICE_PORT_VERSION,
    async resolvePolicy() {
      return {
        version: "browser_policy_resolution_v1",
        decision: "allow",
        policyRevision: "browser-policy-1",
        sessionMode: "operator",
      };
    },
    async execute() {
      throw new Error("not used");
    },
    async authorizeArtifact() {
      return undefined;
    },
    async adoptAllowlistRevision(input) {
      return allowlistAdoptionReceipt(input);
    },
  };
  const available = new UnifiedToolRegistry({
    allowlist: [...BROWSER_TOOL_NAMES],
    context: { browserService: port },
  });
  assert.deepEqual(
    available.getModelTools().map((tool) => tool.name),
    BROWSER_TOOL_NAMES,
  );
});

test("fake Browser port receives the exact prepared call and conditional effect identity", async () => {
  const calls: PreparedToolCallV1[] = [];
  const port: BrowserServicePort = {
    version: BROWSER_SERVICE_PORT_VERSION,
    async resolvePolicy(input) {
      const destination = String(input.effectiveInput.destination ?? "");
      return {
        version: "browser_policy_resolution_v1",
        decision: destination.includes("blocked")
          ? "deny"
          : destination.includes("new.example.com")
            ? "approval_required"
            : "allow",
        policyRevision: `browser-policy:${destination}`,
        sessionMode: "operator",
      };
    },
    async execute(prepared) {
      calls.push(prepared);
      if (prepared.activation.descriptor.toolId === "browser.tabs") {
        return {
          version: "browser_tool_result_v1",
          operation: "browser.tabs",
          sessionId: "browser-session-1",
          generation: 1,
          capturedAt: "2026-08-29T12:00:00.000Z",
          boundary: "untrusted_browser_content",
          activeTabId: "tab-1",
          tabs: [
            {
              tabId: "tab-1",
              normalizedOrigin: "https://example.com",
              title: "Example",
              active: true,
            },
          ],
        };
      }
      return {
        version: "browser_tool_result_v1",
        operation: "browser.request_grant",
        outcome:
          prepared.policy.decision === "approval_required"
            ? "granted"
            : "already_allowed",
        sessionId: "browser-session-1",
        canonicalWildcard: "*.example.com",
        effectiveAllowlistRevision: "allowlist-1",
      };
    },
    async authorizeArtifact() {
      return undefined;
    },
    async adoptAllowlistRevision(input) {
      return allowlistAdoptionReceipt(input);
    },
  };
  const registry = new UnifiedToolRegistry({
    allowlist: [...BROWSER_TOOL_NAMES],
    context: { browserService: port },
  });

  const listed = await executeBrowserCall(registry, "browser.tabs", {
    sessionId: "browser-session-1",
    operation: "list",
  });
  const listPrepared = calls.at(-1)!;
  assert.equal(listed.outcome.effectState, "not_applicable");
  assert.equal(listPrepared.policy.decision, "allow");
  assert.deepEqual(readBrowserAdapter(listPrepared), {
    contractVersion: "browser_app_contract_v1",
    operation: "browser.tabs",
    executionClass: "read_only",
    exactEffects: [],
    approval: "automatic",
  });

  const switched = await executeBrowserCall(registry, "browser.tabs", {
    sessionId: "browser-session-1",
    operation: "switch",
    tabId: "tab-1",
  });
  const switchPrepared = calls.at(-1)!;
  assert.equal(switched.outcome.effectState, "committed");
  assert.deepEqual(readBrowserAdapter(switchPrepared), {
    contractVersion: "browser_app_contract_v1",
    operation: "browser.tabs",
    executionClass: "external_side_effect",
    exactEffects: ["tab.switch"],
    approval: "automatic",
  });

  const grant = await executeBrowserCall(
    registry,
    "browser.request_grant",
    {
      sessionId: "browser-session-1",
      destination: "https://example.com/path?secret=hidden",
    },
    "allow",
  );
  const grantPrepared = calls.at(-1)!;
  assert.equal(grant.outcome.effectState, "committed");
  assert.equal(grantPrepared.policy.decision, "allow");
  assert.equal(
    readBrowserAdapter(grantPrepared)?.approval,
    "dynamic_personal_grant",
  );
  assert.deepEqual(grant.auditRecord.input, {
    sessionId: "browser-session-1",
    destinationOrigin: "https://example.com",
  });
  assert.doesNotMatch(JSON.stringify(grant.auditRecord), /secret=hidden/u);

  await executeBrowserCall(
    registry,
    "browser.request_grant",
    {
      sessionId: "browser-session-1",
      destination: "https://new.example.com",
    },
    "approval_required",
  );
  const approvedGrantPrepared = calls.at(-1)!;
  assert.equal(approvedGrantPrepared.policy.decision, "approval_required");
  assert.ok(approvedGrantPrepared.approval);
  assert.equal(
    readBrowserAdapter(approvedGrantPrepared)?.approval,
    "dynamic_personal_grant",
  );

  const callsBeforeBlocked = calls.length;
  await assert.rejects(
    executeBrowserCall(
      registry,
      "browser.request_grant",
      {
        sessionId: "browser-session-1",
        destination: "https://blocked.example.com",
      },
      "deny",
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "TOOL_POLICY_DENIED",
  );
  assert.equal(calls.length, callsBeforeBlocked);
});

test("Browser artifact normalizer uses AgentToolArtifactPresentation", async () => {
  let authorization:
    | Parameters<BrowserServicePort["authorizeArtifact"]>[0]
    | undefined;
  let executedPrepared: PreparedToolCallV1 | undefined;
  const port: BrowserServicePort = {
    version: BROWSER_SERVICE_PORT_VERSION,
    async resolvePolicy() {
      return {
        version: "browser_policy_resolution_v1",
        decision: "allow",
        policyRevision: "browser-policy-1",
        sessionMode: "operator",
      };
    },
    async execute(prepared) {
      executedPrepared = prepared;
      return {
        version: "browser_tool_result_v1",
        operation: "browser.capture",
        sessionId: "browser-session-1",
        generation: 1,
        artifact: {
          id: "artifact-1",
          title: "Browser screenshot",
          kind: "browser-screenshot",
          mediaType: "image/png",
          bytes: 100,
          sha256: "a".repeat(64),
        },
        normalizedOrigin: "https://example.com",
        capturedAt: "2026-08-29T12:00:00.000Z",
        boundary: "untrusted_browser_content",
      };
    },
    async authorizeArtifact(input) {
      authorization = input;
      return authorizedArtifactFor(input, {
        title: "Browser screenshot",
        mediaType: "image/png",
        bytes: 100,
        sha256: "a".repeat(64),
      });
    },
    async adoptAllowlistRevision(input) {
      return allowlistAdoptionReceipt(input);
    },
  };
  const registry = new UnifiedToolRegistry({
    allowlist: ["browser.capture"],
    context: { browserService: port },
  });
  const result = await executeBrowserCall(registry, "browser.capture", {
    sessionId: "browser-session-1",
    kind: "screenshot",
  });
  assert.deepEqual(result.presentation?.artifacts?.[0], {
    id: "artifact-1",
    title: "Browser screenshot",
    kind: "browser-screenshot",
    mediaType: "image/png",
    metadata: {
      id: "artifact-1",
      title: "Browser screenshot",
      kind: "browser-screenshot",
      mediaType: "image/png",
      sha256: "a".repeat(64),
      bytes: 100,
    },
  });
  assert.deepEqual(authorization, {
    version: "browser_artifact_authorization_v1",
    runId: executedPrepared?.runId,
    threadId: "thread-session-1",
    callId: executedPrepared?.callId,
    toolName: "browser.capture",
    sessionId: "browser-session-1",
    artifactId: "artifact-1",
    artifactKind: "browser-screenshot",
  });
});

test("Browser capture and download keep authorized URLs only on presentation", async () => {
  for (const scenario of [
    {
      toolName: "browser.capture" as const,
      input: validInputs["browser.capture"],
      output: validOutputs["browser.capture"],
      artifactId: "artifact-1",
      artifactKind: "browser-screenshot" as const,
      title: "Authorized screenshot",
      mediaType: "image/png",
      sha256: "a".repeat(64),
      approval: false,
    },
    {
      toolName: "browser.download" as const,
      input: validInputs["browser.download"],
      output: validOutputs["browser.download"],
      artifactId: "artifact-2",
      artifactKind: "browser-download" as const,
      title: "Authorized download",
      mediaType: "application/octet-stream",
      sha256: "b".repeat(64),
      approval: true,
    },
  ]) {
    const titleSentinel = `${scenario.toolName}-untrusted-title-sentinel`;
    const metadataSentinel = `${scenario.toolName}-untrusted-metadata-sentinel`;
    const hostTokenSentinel = `${scenario.toolName}-host-token-sentinel`;
    const signedTokenSentinel = `${scenario.toolName}-signed-token-sentinel`;
    const fragmentSentinel = `${scenario.toolName}-fragment-sentinel`;
    const authorizedUrl =
      `https://artifacts.example/${scenario.artifactId}` +
      `?signature=${signedTokenSentinel}#${fragmentSentinel}`;
    const port: BrowserServicePort = {
      ...passiveBrowserPort(),
      async execute() {
        return {
          ...scenario.output,
          artifact: {
            ...(scenario.output.artifact as Record<string, unknown>),
            title: titleSentinel,
            mediaType: metadataSentinel,
            url:
              `https://untrusted.example/${scenario.artifactId}` +
              `?token=${hostTokenSentinel}`,
          },
        };
      },
      async authorizeArtifact(input) {
        assert.equal(input.artifactId, scenario.artifactId);
        assert.equal(input.artifactKind, scenario.artifactKind);
        return authorizedArtifactFor(input, {
          title: scenario.title,
          url: authorizedUrl,
          mediaType: scenario.mediaType,
          bytes: 10,
          sha256: scenario.sha256,
        });
      },
    };
    const registry = new UnifiedToolRegistry({
      allowlist: [scenario.toolName],
      context: { browserService: port },
    });
    const { prepared, runContext } = await prepareBrowserCall(
      registry,
      scenario.toolName,
      scenario.input,
      scenario.approval
        ? { decision: "approval_required", approval: true }
        : {},
    );
    const result = await registry.executePreparedToolCall(prepared, {
      runContext,
    });
    assert.equal(result.outcome.kind, "success");
    assert.equal(result.presentation?.artifacts?.[0]?.url, authorizedUrl);
    assert.equal(result.presentation?.artifacts?.[0]?.title, scenario.title);
    assert.equal(
      result.presentation?.artifacts?.[0]?.mediaType,
      scenario.mediaType,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      new RegExp(`${titleSentinel}|${metadataSentinel}|${hostTokenSentinel}`),
    );

    const completed = buildRunToolUpdate({
      runId: prepared.runId,
      sessionId: prepared.sessionId,
      seq: 20,
      toolCallId: prepared.callId,
      toolName: scenario.toolName,
      phase: "completed",
      activation: prepared.activation,
      output: result,
      outcome: result.outcome,
    });
    const replay = buildRunToolUpdate({
      runId: prepared.runId,
      sessionId: prepared.sessionId,
      seq: 21,
      toolCallId: prepared.callId,
      toolName: scenario.toolName,
      phase: "completed",
      activation: prepared.activation,
      output: result,
      outcome: result.outcome,
    });
    const failed = buildRunToolUpdate({
      runId: prepared.runId,
      sessionId: prepared.sessionId,
      seq: 22,
      toolCallId: prepared.callId,
      toolName: scenario.toolName,
      phase: "failed",
      output: result,
      error: {
        code: "BROWSER_ENGINE_FAILURE",
        message: titleSentinel,
        details: {
          metadata: metadataSentinel,
          signedUrl: authorizedUrl,
        },
      },
    });
    const durableEvidence = JSON.stringify({
      audit: result.auditRecord,
      completed: buildRunToolEvent(completed),
      replay: buildRunToolEvent(replay),
      failed: buildRunToolEvent(failed),
    });
    assert.doesNotMatch(
      durableEvidence,
      new RegExp(
        `${titleSentinel}|${metadataSentinel}|${hostTokenSentinel}|${signedTokenSentinel}|${fragmentSentinel}`,
      ),
    );
    assert.match(durableEvidence, new RegExp(scenario.artifactId));
    assert.match(durableEvidence, new RegExp(scenario.artifactKind));
    assert.match(
      durableEvidence,
      new RegExp(scenario.mediaType.replace("/", "\\/")),
    );
    assert.equal(completed.presentation, undefined);
    assert.equal(replay.presentation, undefined);
    assert.equal(failed.presentation, undefined);
  }
});

test("Desktop and hosted Browser preparation resolve all grant branches before dispatch", async () => {
  for (const host of ["desktop", "hosted"] as const) {
    let dispatches = 0;
    const port: BrowserServicePort = {
      version: BROWSER_SERVICE_PORT_VERSION,
      async resolvePolicy(input) {
        const destination = String(input.effectiveInput.destination ?? "");
        return {
          version: "browser_policy_resolution_v1",
          decision: destination.includes("already")
            ? "allow"
            : destination.includes("blocked")
              ? "deny"
              : "approval_required",
          policyRevision: `${host}:${destination}`,
          sessionMode: "operator",
        };
      },
      async execute() {
        dispatches += 1;
        throw new Error("policy inspection must not dispatch");
      },
      async authorizeArtifact() {
        return undefined;
      },
      async adoptAllowlistRevision(input) {
        return allowlistAdoptionReceipt(input);
      },
    };
    const registry = new UnifiedToolRegistry({
      allowlist: ["browser.request_grant"],
      context: {
        browserService: port,
        ...(host === "hosted"
          ? {
              kestrelOne: {
                appApprovalModes: {
                  "browser.request_grant": "ask" as const,
                },
              },
            }
          : {}),
      },
    });
    const runContext = {
      runId: `${host}-policy-run`,
      sessionId: `${host}-thread`,
      payload: {},
      sessionState: {},
    };
    const snapshot = await registry.createToolSurfaceSnapshot({
      runContext,
      toolNames: ["browser.request_grant"],
    });
    const activation = snapshot.tools[0]!;
    for (const [destination, expected] of [
      ["https://already.example.com", "allow"],
      ["https://blocked.example.net", "deny"],
      ["https://new.example.org", "approval_required"],
    ] as const) {
      const inspection = await registry.inspectToolCall(
        {
          activation,
          origin: {
            kind: "model",
            snapshotId: snapshot.snapshotId,
            modelToolCallId: `${host}:${expected}`,
          },
          rawInput: {
            sessionId: "browser-session-1",
            generation: 1,
            destination,
          },
        },
        { runContext },
      );
      assert.equal(
        inspection.policy?.decision,
        expected,
        `${host}:${expected}`,
      );
      assert.match(
        inspection.policy?.policyRevision ?? "",
        new RegExp(`^${host}:`),
      );
    }
    assert.equal(dispatches, 0, host);
  }
});

test("scoped Browser policy and execution carry the canonical Desktop app root", async () => {
  const workspaceRoot = "/tmp/Desktop QA Project";
  const expectedAuthority = {
    threadId: "desktop-qa-thread",
    projectRoot: workspaceRoot,
  };
  let policyAuthority: unknown;
  let executionAuthority: unknown;
  const output = {
    version: "browser_tool_result_v1" as const,
    operation: "browser.request_grant" as const,
    outcome: "already_allowed" as const,
    sessionId: "browser-session-1",
    canonicalWildcard: "*.example.com",
    effectiveAllowlistRevision: "allowlist-1",
  };
  const port: BrowserServicePort = {
    ...passiveBrowserPort(),
    async resolvePolicy(input) {
      policyAuthority = input.authority;
      return {
        version: "browser_policy_resolution_v1",
        decision: "allow",
        policyRevision: "desktop-qa-policy-1",
        sessionMode: "qa",
      };
    },
    async execute(_prepared, lifecycle) {
      executionAuthority = lifecycle.authority;
      await lifecycle.acknowledgeDispatch();
      return output;
    },
  };
  const registry = new UnifiedToolRegistry({
    allowlist: ["browser.request_grant"],
    context: { browserService: port },
  });
  const runContext = {
    runId: "desktop-qa-run",
    sessionId: "desktop-qa-thread",
    payload: {
      workspace: {
        workspaceRoot,
        appRoot: ".",
      },
    },
    sessionState: {},
  };
  const snapshot = await registry.createToolSurfaceSnapshot({
    runContext,
    toolNames: ["browser.request_grant"],
  });
  const activation = snapshot.tools[0]!;
  const origin = {
    kind: "model" as const,
    snapshotId: snapshot.snapshotId,
    modelToolCallId: "desktop-qa-grant-call",
  };
  const rawInput = {
    sessionId: "browser-session-1",
    generation: 1,
    destination: "https://example.com",
  };
  const inspection = await registry.inspectToolCall(
    { activation, origin, rawInput },
    { runContext },
  );
  assert.deepEqual(policyAuthority, expectedAuthority);
  assert.equal(inspection.policy?.decision, "allow");
  assert.ok(inspection.policy);

  const prepared = await registry.prepareToolCall(
    {
      runId: runContext.runId,
      sessionId: runContext.sessionId,
      callId: "desktop-qa-grant-call",
      activation,
      origin,
      rawInput,
      policy: inspection.policy,
    },
    { runContext },
  );
  const result = await registry.executePreparedToolCall(prepared, {
    runContext,
  });

  assert.equal(result.outcome.kind, "success");
  assert.deepEqual(executionAuthority, expectedAuthority);
});

test("QA Browser policy cannot produce a personal-domain approval", async () => {
  const registry = new UnifiedToolRegistry({
    allowlist: ["browser.request_grant"],
    context: {
      browserService: {
        ...passiveBrowserPort(),
        async resolvePolicy() {
          return {
            version: "browser_policy_resolution_v1",
            decision: "approval_required",
            policyRevision: "qa-policy-1",
            sessionMode: "qa",
          };
        },
      },
    },
  });
  const runContext = {
    runId: "qa-policy-run",
    sessionId: "qa-policy-thread",
    payload: {},
    sessionState: {},
  };
  const snapshot = await registry.createToolSurfaceSnapshot({
    runContext,
    toolNames: ["browser.request_grant"],
  });

  await assert.rejects(
    registry.inspectToolCall(
      {
        activation: snapshot.tools[0]!,
        origin: {
          kind: "model",
          snapshotId: snapshot.snapshotId,
          modelToolCallId: "qa-grant-call",
        },
        rawInput: {
          sessionId: "qa-browser-session",
          generation: 1,
          destination: "https://new.example.org",
        },
      },
      { runContext },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code ===
        "BROWSER_DESTINATION_BLOCKED",
  );
});

test("QA Browser upload and download still prepare their exact approval waits", async () => {
  for (const toolName of ["browser.upload", "browser.download"] as const) {
    let dynamicGrantPolicyCalls = 0;
    const registry = new UnifiedToolRegistry({
      allowlist: [toolName],
      context: {
        browserService: {
          ...passiveBrowserPort(),
          async resolvePolicy() {
            dynamicGrantPolicyCalls += 1;
            return {
              version: "browser_policy_resolution_v1",
              decision: "approval_required",
              policyRevision: `qa-${toolName}`,
              sessionMode: "qa",
            };
          },
        },
      },
    });

    const { prepared, approvalAuthorityRevision } = await prepareBrowserCall(
      registry,
      toolName,
      validInputs[toolName],
      { decision: "approval_required", approval: true },
    );
    assert.equal(prepared.policy.decision, "approval_required", toolName);
    assert.ok(prepared.approval, toolName);
    assert.equal(dynamicGrantPolicyCalls, 0, toolName);
    if (toolName === "browser.upload") {
      const uploadEffect = prepared.inputAdapters.find(
        (adapter) => adapter.adapterId === "kestrel.browser-upload-effect:v1",
      );
      assert.ok(uploadEffect);
      assert.equal(uploadEffect.metadata.filename, "evidence.txt");
      assert.equal(uploadEffect.metadata.targetLabel, "Fixture attachment");
      assert.equal(
        prepared.approval?.authorityRevision,
        derivePreparedToolApprovalAuthorityRevisionV1({
          activation: prepared.activation,
          effectiveInput: prepared.effectiveInput,
          inputAdapters: prepared.inputAdapters,
          policyRevision: prepared.policy.policyRevision,
          upstreamAuthorityRevision: approvalAuthorityRevision,
        }),
      );
    }
  }
});

test("Browser upload cannot replace the trusted active-turn attachment with model input", async () => {
  await assert.rejects(
    prepareBrowserCall(
      new UnifiedToolRegistry({
        allowlist: ["browser.upload"],
        context: { browserService: passiveBrowserPort() },
      }),
      "browser.upload",
      validInputs["browser.upload"],
      {
        decision: "approval_required",
        approval: true,
        activeAttachmentId: "different-active-attachment",
      },
    ),
    hasBrowserCode("BROWSER_SERVICE_UNAVAILABLE"),
  );
});

test("tabs preparation keeps input-dependent execution class consistent", async () => {
  const port = passiveBrowserPort();
  const registry = new UnifiedToolRegistry({
    allowlist: ["browser.tabs"],
    context: {
      browserService: port,
      kestrelOne: {
        appApprovalModes: { "browser.tabs": "ask" },
      },
    },
  });
  for (const [operation, expectedClass] of [
    ["list", "read_only"],
    ["switch", "external_side_effect"],
    ["close", "external_side_effect"],
  ] as const) {
    const input = {
      sessionId: "browser-session-1",
      operation,
      ...(operation === "list" ? {} : { tabId: "tab-1" }),
    };
    const prepared = await prepareBrowserCall(registry, "browser.tabs", input, {
      decision: "approval_required",
      approval: true,
    });
    assert.equal(
      prepared.prepared.stableAuthority?.version,
      "prepared_tool_stable_authority_v2",
    );
    if (
      prepared.prepared.stableAuthority?.version !==
      "prepared_tool_stable_authority_v2"
    ) {
      assert.fail("tabs approval must use V2 stable authority");
    }
    assert.equal(
      prepared.prepared.stableAuthority.executionClass,
      expectedClass,
      operation,
    );
    assert.equal(
      readBrowserAdapter(prepared.prepared)?.executionClass,
      expectedClass,
      operation,
    );
  }
});

test("Browser approval-path allow preparation preserves Desktop and hosted authority", async () => {
  for (const hosted of [false, true]) {
    const registry = new UnifiedToolRegistry({
      allowlist: ["browser.request_grant"],
      context: { browserService: passiveBrowserPort() },
    });
    const { prepared, approvalAuthorityRevision } = await prepareBrowserCall(
      registry,
      "browser.request_grant",
      {
        sessionId: "browser-session-1",
        destination: "https://already.example.com",
      },
      {
        decision: "approval_required",
        approval: true,
        hosted,
      },
    );

    assert.equal(prepared.policy.decision, "allow", String(hosted));
    assert.equal(
      prepared.approval?.authorityRevision,
      derivePreparedToolApprovalAuthorityRevisionV1({
        activation: prepared.activation,
        effectiveInput: prepared.effectiveInput,
        inputAdapters: prepared.inputAdapters,
        policyRevision: prepared.policy.policyRevision,
        upstreamAuthorityRevision: approvalAuthorityRevision,
      }),
      String(hosted),
    );
    if (!hosted) {
      assert.equal(prepared.stableAuthority, undefined);
      assert.equal(prepared.stableToolIdentity, undefined);
      assert.ok(prepared.approval?.authorityRevision);
      continue;
    }
    assert.equal(
      prepared.stableAuthority?.version,
      "prepared_tool_stable_authority_v2",
    );
    assert.equal(prepared.stableAuthority?.actor.actorId, "user-1");
    assert.equal(prepared.stableAuthority?.organizationId, "organization-1");
    assert.equal(prepared.stableAuthority?.environmentId, "environment-1");
    assert.equal(prepared.stableAuthority?.projectId, "project-1");
    assert.equal(prepared.stableAuthority?.threadId, prepared.sessionId);
    assert.equal(
      prepared.stableAuthority?.descriptorContractRevision,
      prepared.activation.descriptor.contractRevision,
    );
    assert.equal(
      prepared.stableAuthority?.executionClass,
      "external_side_effect",
    );
    assert.equal(
      prepared.stableAuthority?.approvalAuthorityRevision,
      approvalAuthorityRevision,
    );
    assert.equal(
      prepared.stableToolIdentity?.approvalAuthorityRevision,
      approvalAuthorityRevision,
    );
  }
});

test("Browser dispatch acknowledgement distinguishes pre-dispatch failure from unknown outcome", async () => {
  const secret = "sentinel-page-and-form-secret";
  for (const [acknowledge, expectedState, expectedCode] of [
    [false, "not_started", "BROWSER_ENGINE_FAILURE"],
    [true, "unknown", "BROWSER_ACTION_OUTCOME_UNKNOWN"],
  ] as const) {
    const port: BrowserServicePort = {
      ...passiveBrowserPort(),
      async execute(_prepared, lifecycle) {
        if (acknowledge) await lifecycle.acknowledgeDispatch();
        throw Object.assign(new Error(`host failed with ${secret}`), {
          details: { responseBody: secret, formValue: secret },
        });
      },
    };
    const registry = new UnifiedToolRegistry({
      allowlist: ["browser.close"],
      context: { browserService: port },
    });
    const { prepared, runContext } = await prepareBrowserCall(
      registry,
      "browser.close",
      { sessionId: "browser-session-1" },
    );
    const result = await registry.executePreparedToolCall(prepared, {
      runContext,
    });
    assert.equal(result.outcome.kind, "failure");
    if (result.outcome.kind !== "failure") assert.fail("expected failure");
    assert.equal(result.outcome.effectState, expectedState);
    assert.equal(result.outcome.normalizedFailureCode, expectedCode);
    assert.equal(BROWSER_FAILURE_CODES.includes(expectedCode), true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test("Browser preserves an exact known host failure after dispatch acknowledgement", async () => {
  const port: BrowserServicePort = {
    ...passiveBrowserPort(),
    async execute(_prepared, lifecycle) {
      await lifecycle.acknowledgeDispatch();
      throw browserFailure(
        "BROWSER_TARGET_STALE",
        "The current Browser document no longer matches the snapshot.",
        { browserOutcomeKnown: true },
      );
    },
  };
  const registry = new UnifiedToolRegistry({
    allowlist: ["browser.close"],
    context: { browserService: port },
  });
  const { prepared, runContext } = await prepareBrowserCall(
    registry,
    "browser.close",
    { sessionId: "browser-session-1" },
  );
  const result = await registry.executePreparedToolCall(prepared, {
    runContext,
  });
  assert.equal(result.outcome.kind, "failure");
  if (result.outcome.kind !== "failure") assert.fail("expected failure");
  assert.equal(result.outcome.normalizedFailureCode, "BROWSER_TARGET_STALE");
  assert.equal(result.outcome.effectState, "unknown");
});

test("Browser destructive operations persist their exact normalized result before cleanup", async () => {
  const ordering: string[] = [];
  const output = {
    version: "browser_tool_result_v1",
    operation: "browser.close",
    sessionId: "browser-session-1",
    state: "closed",
  };
  const port: BrowserServicePort = {
    ...passiveBrowserPort(),
    async execute(_prepared, lifecycle) {
      await lifecycle.acknowledgeDispatch();
      await lifecycle.persistCompletedResult(output);
      ordering.push("cleanup");
      return output;
    },
  };
  const registry = new UnifiedToolRegistry({
    allowlist: ["browser.close"],
    context: { browserService: port },
  });
  const { prepared, runContext } = await prepareBrowserCall(
    registry,
    "browser.close",
    { sessionId: "browser-session-1" },
  );
  const result = await registry.executePreparedToolCall(prepared, {
    runContext,
    async persistCompletedCapabilityResult(exactResult) {
      ordering.push("persist");
      assert.equal(exactResult.outcome.kind, "success");
      assert.deepEqual(exactResult.outcome.rawOutput, output);
    },
  });
  assert.deepEqual(ordering, ["persist", "cleanup"]);
  assert.equal(result.outcome.kind, "success");
  if (result.outcome.kind !== "success") assert.fail("expected success");
  assert.deepEqual(result.outcome.rawOutput, output);
});

test("Browser request_grant host owns allowlist adoption before persistence", async () => {
  for (const outcome of ["granted", "already_allowed"] as const) {
    const ordering: string[] = [];
    let moduleAdoptions = 0;
    const output = {
      version: "browser_tool_result_v1" as const,
      operation: "browser.request_grant" as const,
      outcome,
      sessionId: "browser-session-1",
      canonicalWildcard: "*.example.com",
      effectiveAllowlistRevision: `allowlist-${outcome}`,
    };
    const port: BrowserServicePort = {
      ...passiveBrowserPort(),
      async execute(_prepared, lifecycle) {
        ordering.push("host-adopt");
        await lifecycle.acknowledgeDispatch();
        await lifecycle.persistCompletedResult(output);
        ordering.push("cleanup");
        return output;
      },
      async adoptAllowlistRevision(input) {
        moduleAdoptions += 1;
        return allowlistAdoptionReceipt(input);
      },
    };
    const registry = new UnifiedToolRegistry({
      allowlist: ["browser.request_grant"],
      context: { browserService: port },
    });
    const { prepared, runContext } = await prepareBrowserCall(
      registry,
      "browser.request_grant",
      {
        sessionId: "browser-session-1",
        destination: "https://example.com",
      },
    );
    const result = await registry.executePreparedToolCall(prepared, {
      runContext,
      async persistCompletedCapabilityResult() {
        ordering.push("persist");
      },
    });
    assert.deepEqual(ordering, ["host-adopt", "persist", "cleanup"]);
    assert.equal(moduleAdoptions, 0);
    assert.equal(result.outcome.kind, "success");
  }

  let persisted = false;
  const failingPort: BrowserServicePort = {
    ...passiveBrowserPort(),
    async execute(_prepared, lifecycle) {
      await lifecycle.acknowledgeDispatch();
      throw new Error("allowlist adoption unavailable");
    },
  };
  const failingRegistry = new UnifiedToolRegistry({
    allowlist: ["browser.request_grant"],
    context: { browserService: failingPort },
  });
  const { prepared, runContext } = await prepareBrowserCall(
    failingRegistry,
    "browser.request_grant",
    {
      sessionId: "browser-session-1",
      destination: "https://example.com",
    },
  );
  const failed = await failingRegistry.executePreparedToolCall(prepared, {
    runContext,
    async persistCompletedCapabilityResult() {
      persisted = true;
    },
  });
  assert.equal(persisted, false);
  assert.equal(failed.outcome.kind, "failure");
});

test("Browser results cannot cross prepared session or Thread authority", async () => {
  const foreignSecret = "foreign-page-secret-sentinel";
  let persisted = false;
  const port: BrowserServicePort = {
    ...passiveBrowserPort(),
    async execute(_prepared, lifecycle) {
      const output = {
        ...validOutputs["browser.capture"],
        sessionId: "foreign-browser-session",
        artifact: {
          ...(validOutputs["browser.capture"].artifact as Record<
            string,
            unknown
          >),
          title: foreignSecret,
        },
      };
      await lifecycle.persistCompletedResult(output);
      return output;
    },
  };
  const registry = new UnifiedToolRegistry({
    allowlist: ["browser.capture"],
    context: { browserService: port },
  });
  const { prepared, runContext } = await prepareBrowserCall(
    registry,
    "browser.capture",
    { sessionId: "browser-session-1", kind: "screenshot" },
  );
  const result = await registry.executePreparedToolCall(prepared, {
    runContext,
    async persistCompletedCapabilityResult() {
      persisted = true;
    },
  });
  assert.equal(persisted, false);
  assert.equal(result.outcome.kind, "failure");
  if (result.outcome.kind !== "failure") assert.fail("expected failure");
  assert.equal(result.outcome.normalizedFailureCode, "BROWSER_ENGINE_FAILURE");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(foreignSecret));

  const { prepared: openPrepared } = await prepareBrowserCall(
    new UnifiedToolRegistry({
      allowlist: ["browser.open"],
      context: { browserService: passiveBrowserPort() },
    }),
    "browser.open",
    validInputs["browser.open"],
  );
  assert.throws(
    () =>
      validateBrowserResultAuthority(
        openPrepared,
        {
          ...validOutputs["browser.open"],
          session: { ...session, threadId: "foreign-thread" },
        },
        browserExecutionAuthority(openPrepared, "thread-1"),
      ),
    /Thread does not match execution authority/u,
  );
  assert.throws(
    () =>
      validateBrowserResultAuthority(
        {
          ...openPrepared,
          runId: "foreign-run",
          sessionId: "foreign-session",
          callId: "foreign-call",
        },
        validOutputs["browser.open"],
        browserExecutionAuthority(openPrepared, "thread-1"),
      ),
    /execution authority does not match/u,
  );
  assert.throws(
    () =>
      validateBrowserResultAuthority(
        openPrepared,
        {
          ...validOutputs["browser.open"],
          session: { ...session, mode: "qa" },
        },
        browserExecutionAuthority(openPrepared, "thread-1"),
      ),
    /open result mode does not match/u,
  );

  const { prepared: uploadPrepared } = await prepareBrowserCall(
    new UnifiedToolRegistry({
      allowlist: ["browser.upload"],
      context: { browserService: passiveBrowserPort() },
    }),
    "browser.upload",
    validInputs["browser.upload"],
    { decision: "approval_required", approval: true },
  );
  assert.throws(
    () =>
      validateBrowserResultAuthority(
        uploadPrepared,
        {
          ...validOutputs["browser.upload"],
          attachmentId: "foreign-attachment",
        },
        browserExecutionAuthority(uploadPrepared, "thread-1"),
      ),
    /upload result attachment does not match/u,
  );
});

test("Browser artifacts require exact trusted run, Thread, call, ID, and URL authority", async () => {
  const foreignSentinel = "foreign-artifact-sentinel";
  let persisted = false;
  let authorization:
    | Parameters<BrowserServicePort["authorizeArtifact"]>[0]
    | undefined;
  const port: BrowserServicePort = {
    ...passiveBrowserPort(),
    async authorizeArtifact(input) {
      authorization = input;
      return undefined;
    },
    async execute(_prepared, lifecycle) {
      const output = {
        ...validOutputs["browser.capture"],
        artifact: {
          ...(validOutputs["browser.capture"].artifact as Record<
            string,
            unknown
          >),
          id: foreignSentinel,
          url: `https://foreign.example/artifacts/${foreignSentinel}`,
        },
      };
      await lifecycle.persistCompletedResult(output);
      return output;
    },
  };
  const registry = new UnifiedToolRegistry({
    allowlist: ["browser.capture"],
    context: { browserService: port },
  });
  const { prepared, runContext } = await prepareBrowserCall(
    registry,
    "browser.capture",
    validInputs["browser.capture"],
  );
  const result = await registry.executePreparedToolCall(prepared, {
    runContext,
    async persistCompletedCapabilityResult() {
      persisted = true;
    },
  });

  assert.equal(persisted, false);
  assert.equal(result.outcome.kind, "failure");
  assert.equal(result.outcome.normalizedFailureCode, "BROWSER_ENGINE_FAILURE");
  assert.equal(result.presentation, undefined);
  assert.deepEqual(authorization, {
    version: "browser_artifact_authorization_v1",
    runId: prepared.runId,
    threadId: prepared.sessionId,
    callId: prepared.callId,
    toolName: "browser.capture",
    sessionId: "browser-session-1",
    artifactId: foreignSentinel,
    artifactKind: "browser-screenshot",
    artifactUrl: `https://foreign.example/artifacts/${foreignSentinel}`,
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(foreignSentinel));
});

test("Browser origins and session semantics normalize before audit persistence", async () => {
  const projected = projectBrowserAuditOutput("browser.snapshot", {
    ...validOutputs["browser.snapshot"],
    normalizedOrigin: "https://example.com/private/path?token=secret#fragment",
  });
  assert.equal(
    (projected as Record<string, unknown>).normalizedOrigin,
    "https://example.com",
  );
  assert.doesNotMatch(JSON.stringify(projected), /token=secret|private\/path/u);
  assert.throws(
    () =>
      parseBrowserSessionV1({
        ...session,
        updatedAt: "2026-08-29T11:59:59.000Z",
      }),
    /updatedAt cannot precede createdAt/u,
  );
});

test("runtime release manifest pins exact assets without latest aliases", () => {
  assert.equal(BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision, "v0.35.0");
  assert.equal(
    BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
    "152.0.7977.54",
  );
  assert.deepEqual(Object.keys(BROWSER_RUNTIME_RELEASE_MANIFEST.targets), [
    "darwin-arm64",
    "linux-x64",
  ]);
  for (const target of Object.values(
    BROWSER_RUNTIME_RELEASE_MANIFEST.targets,
  )) {
    for (const asset of [target.engine, target.chrome]) {
      assert.match(asset.url, /^https:\/\//u);
      assert.doesNotMatch(asset.url, /latest/iu);
      assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    }
  }
});

async function executeBrowserCall(
  registry: UnifiedToolRegistry,
  toolName: (typeof BROWSER_TOOL_NAMES)[number],
  rawInput: Record<string, unknown>,
  decision: "allow" | "approval_required" | "deny" = "allow",
) {
  const effectiveRawInput =
    toolName === "browser.open" ? rawInput : { generation: 1, ...rawInput };
  const sequence = nextBrowserCallSequence++;
  const activeTurnPayload = toolName === "browser.upload"
    ? {
        metadata: {
          threadId: `prepared-session-${sequence}`,
          turnId: `turn-${sequence}`,
          activeTurnId: `turn-${sequence}`,
        },
        attachments: [{
          attachmentId: "attachment-1",
          filename: "evidence.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
          sha256: "a".repeat(64),
        }],
      }
    : {};
  const runContext = {
    runId: `run-${toolName}-${String(rawInput.operation ?? "operation")}-${sequence}`,
    sessionId: "thread-session-1",
    payload: {},
    sessionState: {},
  };
  const snapshot = await registry.createToolSurfaceSnapshot({
    runContext,
    toolNames: [toolName],
  });
  const activation = snapshot.tools[0]!;
  const prepared = await registry.prepareToolCall(
    {
      runId: runContext.runId,
      sessionId: runContext.sessionId,
      callId: `call-${toolName}-${String(rawInput.operation ?? "operation")}-${sequence}`,
      activation,
      origin: {
        kind: "trusted_runtime",
        producerId: "browser-contract-test",
        adapterId: "browser-contract-test:v1",
      },
      rawInput: effectiveRawInput,
      policy: {
        decision,
        policyRevision: hashCanonical({
          toolName,
          rawInput: effectiveRawInput,
          decision,
        }),
      },
      ...(decision === "approval_required"
        ? { approval: { authorityRevision: "browser-test-authority-v1" } }
        : {}),
    },
    { runContext },
  );
  return await registry.executePreparedToolCall(prepared, { runContext });
}

let nextBrowserCallSequence = 1;

async function prepareBrowserCall(
  registry: UnifiedToolRegistry,
  toolName: (typeof BROWSER_TOOL_NAMES)[number],
  rawInput: Record<string, unknown>,
  policy: {
    decision?: "allow" | "approval_required" | "deny";
    approval?: boolean;
    hosted?: boolean;
    activeAttachmentId?: string;
  } = {},
) {
  const effectiveRawInput =
    toolName === "browser.open" ? rawInput : { generation: 1, ...rawInput };
  const sequence = nextBrowserCallSequence++;
  const activeTurnPayload = toolName === "browser.upload"
    ? {
        metadata: {
          threadId: `prepared-session-${sequence}`,
          turnId: `turn-${sequence}`,
          activeTurnId: `turn-${sequence}`,
        },
        attachments: [{
          attachmentId: policy.activeAttachmentId ?? "attachment-1",
          filename: "evidence.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
          sha256: "a".repeat(64),
        }],
      }
    : {};
  const runContext = {
    runId: `prepared-${toolName}-${sequence}`,
    sessionId: `prepared-session-${sequence}`,
    payload:
      policy.approval && policy.hosted !== false
        ? {
            ...activeTurnPayload,
            hostedApprovalAuthority: {
              organizationId: "organization-1",
              environmentId: "environment-1",
              projectId: "project-1",
              threadId: `prepared-session-${sequence}`,
            },
            actor: { actorType: "end_user", actorId: "user-1" },
          }
        : activeTurnPayload,
    sessionState: {},
  };
  const snapshot = await registry.createToolSurfaceSnapshot({
    runContext,
    toolNames: [toolName],
  });
  const activation = snapshot.tools[0]!;
  const decision = policy.decision ?? "allow";
  const approvalAuthorityRevision = hashCanonical({ authority: sequence });
  const prepared = await registry.prepareToolCall(
    {
      runId: runContext.runId,
      sessionId: runContext.sessionId,
      callId: `prepared-call-${sequence}`,
      activation,
      origin: {
        kind: "model",
        snapshotId: snapshot.snapshotId,
        modelToolCallId: `prepared-model-call-${sequence}`,
      },
      rawInput: effectiveRawInput,
      policy: {
        decision,
        policyRevision: hashCanonical({ upstreamPolicy: sequence }),
      },
      ...(policy.approval
        ? {
            approval: {
              approvalId: `approval-${sequence}`,
              authorityRevision: approvalAuthorityRevision,
            },
            approvalCapabilities: ["external.confirm"],
          }
        : {}),
    },
    { runContext },
  );
  return { prepared, runContext, approvalAuthorityRevision };
}

function passiveBrowserPort(): BrowserServicePort {
  return {
    version: BROWSER_SERVICE_PORT_VERSION,
    async resolvePolicy() {
      return {
        version: "browser_policy_resolution_v1",
        decision: "allow",
        policyRevision: "browser-policy-1",
        sessionMode: "operator",
      };
    },
    async prepareUpload(input) {
      return {
        version: "browser_upload_preparation_v1",
        turnId: input.turnId,
        threadId: input.threadId,
        attachmentId: input.attachment.attachmentId,
        filename: input.attachment.filename,
        declaredMediaType: input.attachment.declaredMediaType,
        sizeBytes: input.attachment.sizeBytes,
        sha256: input.attachment.sha256,
        sessionId: String(input.effectiveInput.sessionId),
        generation: Number(input.effectiveInput.generation),
        snapshotId: String(input.effectiveInput.snapshotId),
        documentRevision: "document-1",
        targetRef: String(input.effectiveInput.targetRef),
        targetLabel: "Fixture attachment",
      };
    },
    async execute() {
      throw new Error("not used");
    },
    async authorizeArtifact(input) {
      return authorizedArtifactFor(input);
    },
    async adoptAllowlistRevision(input) {
      return allowlistAdoptionReceipt(input);
    },
  };
}

function allowlistAdoptionReceipt(
  input: Parameters<BrowserServicePort["adoptAllowlistRevision"]>[0],
) {
  return {
    version: "browser_allowlist_adoption_receipt_v1" as const,
    sessionId: input.sessionId,
    effectiveAllowlistRevision: input.effectiveAllowlistRevision,
    closedUnauthorizedConnections: 0,
  };
}

function authorizedArtifactFor(
  input: Parameters<BrowserServicePort["authorizeArtifact"]>[0],
  overrides: Partial<{
    title: string;
    url: string;
    mediaType: string;
    bytes: number;
    sha256: string;
  }> = {},
) {
  return {
    version: "browser_authorized_artifact_v1" as const,
    id: input.artifactId,
    title:
      overrides.title ??
      (input.artifactKind === "browser-screenshot" ? "Screenshot" : "Download"),
    kind: input.artifactKind,
    ...(overrides.url === undefined ? {} : { url: overrides.url }),
    mediaType:
      overrides.mediaType ??
      (input.artifactKind === "browser-screenshot"
        ? "image/png"
        : "application/octet-stream"),
    bytes: overrides.bytes ?? 10,
    sha256:
      overrides.sha256 ??
      (input.artifactKind === "browser-screenshot" ? "a" : "b").repeat(64),
  };
}

function readBrowserAdapter(prepared: PreparedToolCallV1) {
  return prepared.inputAdapters.find(
    (adapter) => adapter.adapterId === "kestrel.browser-contract:v1",
  )?.metadata;
}

function hasBrowserCode(code: string) {
  return (error: unknown) =>
    Boolean(
      error && typeof error === "object" && "code" in error &&
      (error as { code?: unknown }).code === code,
    );
}

function browserExecutionAuthority(
  prepared: PreparedToolCallV1,
  threadId: string,
) {
  return {
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    threadId,
    callId: prepared.callId,
    toolName: prepared.activation.descriptor
      .toolId as (typeof BROWSER_TOOL_NAMES)[number],
  };
}
