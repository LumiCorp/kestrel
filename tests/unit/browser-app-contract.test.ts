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
  parseBrowserSessionV1,
  projectBrowserAuditInput,
  type BrowserServicePort,
} from "../../src/browser/contracts.js";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../src/browser/runtimeReleaseManifest.js";
import {
  compileToolJsonSchemaV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import type { PreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
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
    destination: "https://example.com",
  },
  "browser.snapshot": { sessionId: "browser-session-1" },
  "browser.inspect": { sessionId: "browser-session-1", kind: "console_errors" },
  "browser.navigate": { sessionId: "browser-session-1", kind: "reload" },
  "browser.interact": {
    sessionId: "browser-session-1",
    snapshotId: "snapshot-1",
    documentRevision: "document-1",
    tabId: "tab-1",
    action: { kind: "click", ref: "ref-1" },
  },
  "browser.tabs": { sessionId: "browser-session-1", operation: "list" },
  "browser.capture": { sessionId: "browser-session-1", kind: "screenshot" },
  "browser.upload": {
    sessionId: "browser-session-1",
    snapshotId: "snapshot-1",
    targetRef: "ref-1",
    attachmentId: "attachment-1",
  },
  "browser.download": {
    sessionId: "browser-session-1",
    pendingDownloadId: "download-1",
  },
  "browser.request_takeover": {
    sessionId: "browser-session-1",
    reason: "Authentication required",
  },
  "browser.close": { sessionId: "browser-session-1" },
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
    state: "human_control",
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

test("Browser tools remain unavailable until a conforming host port is active", () => {
  const unavailable = new UnifiedToolRegistry({
    allowlist: [...BROWSER_TOOL_NAMES],
  });
  assert.deepEqual(unavailable.getModelTools(), []);

  const port: BrowserServicePort = {
    version: BROWSER_SERVICE_PORT_VERSION,
    async execute() {
      throw new Error("not used");
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
    async execute(prepared) {
      calls.push(prepared);
      if (prepared.activation.descriptor.toolId === "browser.tabs") {
        return {
          version: "browser_tool_result_v1",
          operation: "browser.tabs",
          sessionId: "browser-session-1",
          generation: 1,
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
  const port: BrowserServicePort = {
    version: BROWSER_SERVICE_PORT_VERSION,
    async execute() {
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
      };
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
  const sequence = nextBrowserCallSequence++;
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
      rawInput,
      policy: {
        decision,
        policyRevision: hashCanonical({ toolName, rawInput, decision }),
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

function readBrowserAdapter(prepared: PreparedToolCallV1) {
  return prepared.inputAdapters.find(
    (adapter) => adapter.adapterId === "kestrel.browser-contract:v1",
  )?.metadata;
}
