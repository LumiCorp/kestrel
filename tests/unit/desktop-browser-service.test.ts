import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  chmod,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  AgentBrowserCliAdapter,
  DesktopBrowserService,
  assertDesktopBrowserOwnedDaemonArtifacts,
  buildAgentBrowserCliInvocation,
  desktopBrowserDaemonCommandMatches,
  desktopBrowserZombieCommandMatches,
  denyAgentBrowserDownloads,
  installAgentBrowserDownloadInterception,
  minimizeAgentBrowserNativeWindow,
  presentAgentBrowserNativeWindow,
  prepareAgentBrowserNativeCaptureWindow,
  requirePinnedViewerActiveTarget,
  revokeAgentBrowserNativeWindow,
  spawnAndCollect,
  type DesktopBrowserAuthorityResolver,
  type DesktopBrowserAcceptedOperation,
  type DesktopBrowserEngineAdapter,
  type DesktopBrowserEngineInvocation,
  type DesktopBrowserInterceptedDownload,
  type DesktopBrowserMetric,
  type DesktopBrowserNativeHandoffAuthority,
  type DesktopBrowserNativeHandoffPresentation,
  type DesktopBrowserViewerEventV1,
} from "../../src/localCore/desktopBrowserService.js";
import { LocalCoreBrowserAuthorityCriticalSection } from "../../src/localCore/api.js";
import { LocalCoreDesktopBrowserAuthorityResolver } from "../../src/localCore/desktopBrowserAuthority.js";
import {
  BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
  canonicalizePublicBrowserDestination,
  type BrowserEffectiveDomainAuthorityV1,
} from "../../src/browser/domainAuthority.js";
import {
  HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES,
  HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES,
} from "../../src/browser/hostedViewerProtocol.js";
import type {
  BrowserOperationLifecycleV1,
  BrowserSessionV1,
} from "../../src/browser/contracts.js";
import { BROWSER_DOWNLOAD_PREPARATION_VERSION } from "../../src/browser/contracts.js";
import type { DesktopBrowserViewerStateV1 } from "../../src/desktopShell/contracts.js";
import type { PreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import type {
  CreateLocalCoreBrowserEgressProxyInput,
  LocalCoreBrowserEgressLaunchBindingV1,
  LocalCoreBrowserEgressProxy,
} from "../../src/localCore/browserEgressProxy.js";
import {
  DesktopProjectRunRegistry,
  desktopProjectRunPreviewUrlId,
} from "../../src/localCore/desktopProjectRuns.js";
import {
  DesktopBrowserViewerAuthorityCoordinator,
  type DesktopBrowserViewerPrincipal,
} from "../../apps/desktop/src/browserViewerAuthority.js";
import { DesktopBrowserViewerAuthorityJournal } from "../../apps/desktop/src/browserViewerAuthorityJournal.js";

const PROJECT_ROOT = "/projects/exact";
const PREVIEW_URL = "http://localhost:4317/";
const PREVIEW_ID = desktopProjectRunPreviewUrlId(PREVIEW_URL);

test("Desktop Browser QA opens only the opaque recorded URL owned by the active Project", async () => {
  const fixture = await createFixture();
  const lifecycle = createLifecycle();
  const output = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      lifecycle,
    ),
  );
  assert.equal(output.outcome, "opened");
  assert.deepEqual(lifecycle.events.slice(0, 2), ["ack", "persist"]);
  assert.equal(fixture.engine.opened[0]?.destination, PREVIEW_URL);
  assert.equal(fixture.proxies[0]?.binding.authority.qaTarget?.port, 4317);

  await assert.rejects(
    fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-2",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      createLifecycle({ projectId: "project-1" }),
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );
  await fixture.service.close();
});

test("Desktop Browser rejects forged URL identities and unrecorded localhost ports", async () => {
  const fixture = await createFixture();
  for (const urlId of [
    "preview-00000000000000000000000000000000",
    "http://localhost:9999/",
  ]) {
    await assert.rejects(
      fixture.service.execute(
        prepared("browser.open", {
          mode: "qa",
          target: {
            kind: "desktop_project_run",
            projectId: "project-1",
            runId: "run-1",
            urlId,
          },
        }),
        createLifecycle(),
      ),
      /emitted by that managed run/u,
    );
  }
  assert.equal(fixture.engine.opened.length, 0);
  await fixture.service.close();
});

test("QA authority is lost before dispatch when its managed Project run stops", async () => {
  let live = true;
  const engine = new FakeEngine();
  const fixture = await createFixture({
    engine,
    projectRunRegistry: {
      resolvePreviewUrl({ runId, urlId }) {
        if (!live) throw new Error("managed run stopped");
        assert.equal(runId, "run-1");
        assert.equal(urlId, PREVIEW_ID);
        return {
          run: { runId, projectPath: PROJECT_ROOT } as never,
          url: PREVIEW_URL,
        };
      },
    },
  });
  const sessionId = await openSession(fixture.service);
  const commandsBefore = engine.commands.length;
  live = false;
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      lifecycle,
    ),
    hasCode("BROWSER_SESSION_LOST"),
  );
  assert.deepEqual(lifecycle.events, []);
  assert.equal(engine.commands.length, commandsBefore);
  assert.equal(engine.closed.length, 1);
});

test("DesktopProjectRunRegistry mints and resolves an opaque stable preview identity", async () => {
  const projectPath = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-preview-id-"),
  );
  await mkdir(projectPath, { recursive: true });
  await writeFile(
    path.join(projectPath, "package.json"),
    JSON.stringify({
      name: "preview-fixture",
      packageManager: "pnpm@10.0.0",
      scripts: { dev: "vite" },
    }),
  );
  const stdout = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
  Object.defineProperty(child, "pid", { value: 9001 });
  child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
  const registry = new DesktopProjectRunRegistry({
    platform: "win32",
    spawnImpl: (() => child) as unknown as typeof spawn,
  });
  const run = await registry.startRun({ projectPath, scriptName: "dev" });
  stdout.write(`ready ${PREVIEW_URL}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const preview = registry
    .listRuns()
    .find((candidate) => candidate.runId === run.runId)?.previewUrls?.[0];
  assert.equal(preview?.urlId, PREVIEW_ID);
  assert.equal(
    registry.resolvePreviewUrl({ runId: run.runId, urlId: PREVIEW_ID }).url,
    PREVIEW_URL,
  );
  await assert.rejects(
    async () =>
      registry.resolvePreviewUrl({
        runId: run.runId,
        urlId: desktopProjectRunPreviewUrlId("http://localhost:9999/"),
      }),
    /emitted by that managed run/u,
  );
  child.emit("exit", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(
    () => registry.resolvePreviewUrl({ runId: run.runId, urlId: PREVIEW_ID }),
    /no longer running/u,
  );
});

test("same QA open is idempotent and a conflicting open requires close", async () => {
  const fixture = await createFixture();
  const openInput = {
    mode: "qa",
    target: {
      kind: "desktop_project_run",
      projectId: "project-1",
      runId: "run-1",
      urlId: PREVIEW_ID,
    },
  };
  const first = asRecord(
    await fixture.service.execute(
      prepared("browser.open", openInput),
      createLifecycle(),
    ),
  );
  const second = asRecord(
    await fixture.service.execute(
      prepared("browser.open", openInput),
      createLifecycle(),
    ),
  );
  assert.equal(second.outcome, "existing");
  assert.equal(fixture.engine.opened.length, 1);
  assert.equal(
    asRecord(first.session).sessionId,
    asRecord(second.session).sessionId,
  );
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_SESSION_CONFLICT"),
  );
  await fixture.service.close();
});

test("Desktop takeover stays pending until viewer acceptance and blocks the agent only during human control", async () => {
  const viewerEvents: DesktopBrowserViewerEventV1[] = [];
  const fixture = await createFixture({ viewerEvents });
  const sessionId = await openSession(fixture.service);
  const takeoverLifecycle = createLifecycle();
  const takeover = asRecord(
    await fixture.service.execute(
      prepared("browser.request_takeover", {
        sessionId,
        reason: "Authentication requires the signed-in person.",
      }),
      takeoverLifecycle,
    ),
  );
  assert.equal(takeover.state, "ready");
  assert.equal(takeover.outcome, "takeover_requested");
  assert.deepEqual(takeoverLifecycle.events, ["ack", "persist"]);

  const beforeAcceptance = createLifecycle();
  await fixture.service.execute(
    prepared("browser.snapshot", { sessionId }),
    beforeAcceptance,
  );
  assert.deepEqual(beforeAcceptance.events, ["ack", "persist"]);

  const viewer = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  assert.equal(viewer.sessionState, "ready");
  assert.equal(viewer.takeoverRequested, true);
  const frame = await fixture.service.readViewerFrame({
    ...viewer,
    principalId: "desktop-main-1",
  });
  assert.equal(frame.mediaType, "image/png");
  assert.equal(frame.sequence, 1);

  const accepted = requireAvailableViewer(
    await fixture.service.acceptViewerTakeover({
      ...viewer,
      principalId: "desktop-main-1",
    }),
  );
  assert.equal(accepted.sessionState, "human_control");
  assert.ok(accepted.inputLeaseId);
  assert.equal(accepted.nativeHandoffActive, true);
  assert.deepEqual(fixture.engine.nativeHandoffs[0], {
    sessionId,
    generation: viewer.generation,
    threadId: "thread-1",
    projectId: "project-1",
    principalId: "desktop-main-1",
    connectionId: viewer.connectionId,
    leaseId: accepted.inputLeaseId,
    expiresAt: accepted.inputLeaseExpiresAt,
  });
  const blockedLifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      blockedLifecycle,
    ),
    hasCode("BROWSER_HUMAN_CONTROL_ACTIVE"),
  );
  assert.deepEqual(blockedLifecycle.events, []);

  const sentinel = "viewer-secret-password-9Y!mfa-734921";
  const afterInput = await fixture.service.sendViewerInput({
    ...viewer,
    principalId: "desktop-main-1",
    leaseId: accepted.inputLeaseId!,
    viewerInput: {
      version: "desktop_browser_viewer_input_v1",
      kind: "keyboard",
      phase: "down",
      key: "Unidentified",
      text: sentinel,
    },
  });
  assert.equal(afterInput.sessionState, "human_control");
  assert.equal(
    (fixture.engine.viewerInputs[0] as { text: string }).text,
    sentinel,
  );
  assert.doesNotMatch(JSON.stringify(afterInput), new RegExp(sentinel, "u"));
  assert.doesNotMatch(JSON.stringify(viewerEvents), new RegExp(sentinel, "u"));
  assert.doesNotMatch(
    JSON.stringify(fixture.engine.nativeHandoffs),
    new RegExp(sentinel, "u"),
  );
  assert.doesNotMatch(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
    new RegExp(sentinel, "u"),
  );

  const returned = await fixture.service.returnViewerControl({
    ...viewer,
    principalId: "desktop-main-1",
    leaseId: accepted.inputLeaseId!,
  });
  assert.equal(returned.sessionState, "ready");
  assert.equal(returned.nativeHandoffActive, undefined);
  assert.equal(fixture.engine.revokedNativeHandoffs.length, 1);
  const afterReturn = createLifecycle();
  await fixture.service.execute(
    prepared("browser.snapshot", { sessionId }),
    afterReturn,
  );
  assert.deepEqual(afterReturn.events, ["ack", "persist"]);
  assert.deepEqual(
    viewerEvents.map((event) => event.name),
    ["request", "acceptance", "lease_issue", "return"],
  );
  await fixture.service.close();
});

test("viewer frame capture serializes with agent Browser operations", async () => {
  const fixture = await createFixture();
  const sessionId = await openSession(fixture.service);
  const viewer = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  let notifyFrameStarted!: () => void;
  const frameStarted = new Promise<void>((resolve) => {
    notifyFrameStarted = resolve;
  });
  let resumeFrame!: () => void;
  fixture.engine.viewerFramePaused = notifyFrameStarted;
  fixture.engine.resumeViewerFrame = new Promise<void>((resolve) => {
    resumeFrame = resolve;
  });

  const frame = fixture.service.readViewerFrame({
    ...viewer,
    principalId: "desktop-main-1",
  });
  await frameStarted;
  const commandCount = fixture.engine.commands.length;
  const snapshot = fixture.service.execute(
    prepared("browser.snapshot", { sessionId }),
    createLifecycle(),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.engine.commands.length, commandCount);

  resumeFrame();
  await frame;
  await snapshot;
  assert.equal(
    fixture.engine.commands
      .slice(commandCount)
      .some((command) => command[0] === "snapshot"),
    true,
  );
  await fixture.service.close();
});

test("hosted viewer takeover accepts typed input without native Desktop handoff", async () => {
  const fixture = await createFixture({ nativeAuthenticationHandoff: false });
  const sessionId = await openSession(fixture.service);
  await fixture.service.execute(
    prepared("browser.request_takeover", {
      sessionId,
      reason: "Authentication requires the signed-in person.",
    }),
    createLifecycle(),
  );
  const viewer = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "hosted-actor-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  const accepted = requireAvailableViewer(
    await fixture.service.acceptViewerTakeover({
      ...viewer,
      principalId: "hosted-actor-1",
    }),
  );
  assert.equal(accepted.sessionState, "human_control");
  assert.equal(accepted.nativeHandoffActive, false);
  assert.equal(fixture.engine.nativeHandoffs.length, 0);
  await fixture.service.sendViewerInput({
    ...viewer,
    principalId: "hosted-actor-1",
    leaseId: accepted.inputLeaseId!,
    viewerInput: {
      version: "desktop_browser_viewer_input_v1",
      kind: "keyboard",
      phase: "down",
      key: "a",
      text: "a",
    },
  });
  assert.equal(fixture.engine.viewerInputs.length, 1);
  const returned = await fixture.service.returnViewerControl({
    ...viewer,
    principalId: "hosted-actor-1",
    leaseId: accepted.inputLeaseId!,
  });
  assert.equal(returned.sessionState, "ready");
  assert.equal(fixture.engine.revokedNativeHandoffs.length, 0);
  await fixture.service.close();
});

test("a fully bound hosted viewer is idempotent and a different proposed connection fail-closes retained authority", async () => {
  const fixture = await createFixture({ nativeAuthenticationHandoff: false });
  const sessionId = await openSession(fixture.service);
  const exact = {
    principalId: "hosted-actor-1",
    threadId: "thread-1",
    projectId: "project-1",
    sessionId,
    generation: 1,
    connectionId: "hosted-connection-1",
  };

  const first = requireAvailableViewer(
    await fixture.service.connectViewer(exact),
  );
  const duplicate = requireAvailableViewer(
    await fixture.service.connectViewer(exact),
  );
  assert.deepEqual(duplicate, first);

  await assert.rejects(
    fixture.service.connectViewer({
      ...exact,
      principalId: "other-hosted-actor",
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  await assert.rejects(
    fixture.service.connectViewer({
      principalId: exact.principalId,
      threadId: exact.threadId,
      projectId: exact.projectId,
      sessionId,
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  await assert.rejects(
    fixture.service.connectViewer({ ...exact, generation: 2 }),
    hasCode("BROWSER_SESSION_LOST"),
  );

  await assert.rejects(
    fixture.service.connectViewer({
      ...exact,
      connectionId: "cross-ticket-connection",
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  assert.equal((await fixture.service.connectViewer(exact)).available, false);
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
    hasCode("BROWSER_SESSION_LOST"),
  );
  await fixture.service.close();
});

test("Desktop human control survives disconnect and lease expiry until an authorized reconnect explicitly returns it", async () => {
  let now = new Date("2026-08-29T12:00:00.000Z");
  const viewerEvents: DesktopBrowserViewerEventV1[] = [];
  const fixture = await createFixture({ now: () => now, viewerEvents });
  const sessionId = await openSession(fixture.service);
  await fixture.service.execute(
    prepared("browser.request_takeover", {
      sessionId,
      reason: "Authentication required.",
    }),
    createLifecycle(),
  );
  const first = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  const accepted = requireAvailableViewer(
    await fixture.service.acceptViewerTakeover({
      ...first,
      principalId: "desktop-main-1",
    }),
  );
  await assert.rejects(
    fixture.service.connectViewer({
      principalId: "wrong-renderer",
      threadId: "thread-1",
      projectId: "project-1",
      sessionId: first.sessionId,
      generation: first.generation,
      connectionId: first.connectionId,
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  now = new Date(now.getTime() + 31_000);
  await assert.rejects(
    fixture.service.sendViewerInput({
      ...first,
      principalId: "desktop-main-1",
      leaseId: accepted.inputLeaseId!,
      viewerInput: {
        version: "desktop_browser_viewer_input_v1",
        kind: "pointer",
        phase: "down",
        x: 4,
        y: 8,
        button: "left",
      },
    }),
    hasCode("BROWSER_VIEWER_AUTHORITY_EXPIRED"),
  );
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
    hasCode("BROWSER_HUMAN_CONTROL_ACTIVE"),
  );
  await fixture.service.disconnectViewer({
    ...first,
    principalId: "desktop-main-1",
  });
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
    hasCode("BROWSER_HUMAN_CONTROL_ACTIVE"),
  );

  const reconnected = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  assert.equal(reconnected.sessionState, "human_control");
  const replacement = requireAvailableViewer(
    await fixture.service.acceptViewerTakeover({
      ...reconnected,
      principalId: "desktop-main-1",
    }),
  );
  assert.notEqual(replacement.inputLeaseId, accepted.inputLeaseId);
  now = new Date(now.getTime() + 1_000);
  const renewed = await fixture.service.renewViewerInputLease({
    ...reconnected,
    principalId: "desktop-main-1",
    leaseId: replacement.inputLeaseId!,
  });
  assert.ok(
    Date.parse(renewed.inputLeaseExpiresAt!) >
      Date.parse(replacement.inputLeaseExpiresAt!),
  );
  await fixture.service.returnViewerControl({
    ...reconnected,
    principalId: "desktop-main-1",
    leaseId: replacement.inputLeaseId!,
  });
  assert.ok(viewerEvents.some((event) => event.name === "expiry"));
  assert.ok(viewerEvents.some((event) => event.name === "disconnect"));
  assert.ok(viewerEvents.some((event) => event.name === "lease_renewal"));
  assert.ok(viewerEvents.some((event) => event.name === "rejection"));
  assert.equal(fixture.engine.nativeHandoffs.length, 2);
  assert.equal(fixture.engine.revokedNativeHandoffs.length, 2);
  await fixture.service.close();
});

test("exact control-plane viewer cleanup preserves human control and cannot revoke a replacement", async () => {
  const fixture = await createFixture({ nativeAuthenticationHandoff: false });
  const sessionId = await openSession(fixture.service);
  await fixture.service.execute(
    prepared("browser.request_takeover", {
      sessionId,
      reason: "Authentication required.",
    }),
    createLifecycle(),
  );
  const retired = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "hosted-actor-1",
      threadId: "thread-1",
      projectId: "project-1",
      sessionId,
      generation: 1,
      connectionId: "hosted-cleanup-1",
    }),
  );
  await fixture.service.acceptViewerTakeover({
    ...retired,
    principalId: "hosted-actor-1",
  });
  await fixture.service.cleanupViewerConnection({
    ...retired,
    principalId: "hosted-actor-1",
  });
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
    hasCode("BROWSER_HUMAN_CONTROL_ACTIVE"),
  );
  const replacement = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "hosted-actor-1",
      threadId: "thread-1",
      projectId: "project-1",
      sessionId,
      generation: 1,
      connectionId: "hosted-cleanup-2",
    }),
  );
  await fixture.service.cleanupViewerConnection({
    ...retired,
    principalId: "hosted-actor-1",
  });
  const stillCurrent = requireAvailableViewer(
    await fixture.service.connectViewer({
      ...replacement,
      principalId: "hosted-actor-1",
    }),
  );
  assert.equal(stillCurrent.connectionId, replacement.connectionId);
  await fixture.service.close();
});

test("Desktop native handoff fails closed when presentation or revocation cannot be proven", async () => {
  const presentation = await createFixture();
  const sessionId = await openSession(presentation.service);
  await presentation.service.execute(
    prepared("browser.request_takeover", {
      sessionId,
      reason: "Platform authentication required.",
    }),
    createLifecycle(),
  );
  const viewer = requireAvailableViewer(
    await presentation.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  presentation.engine.failNextNativePresentation = new Error(
    "BROWSER_ENGINE_FAILURE: native presentation unavailable",
  );
  await assert.rejects(
    presentation.service.acceptViewerTakeover({
      ...viewer,
      principalId: "desktop-main-1",
    }),
    hasCode("BROWSER_ACTION_OUTCOME_UNKNOWN"),
  );
  assert.equal(presentation.engine.closed.length, 1);
  assert.equal(
    (
      await presentation.service.connectViewer({
        principalId: "desktop-main-1",
        threadId: "thread-1",
        projectId: "project-1",
      })
    ).available,
    false,
  );

  const revocation = await createFixture();
  const secondSession = await openSession(revocation.service);
  await revocation.service.execute(
    prepared("browser.request_takeover", {
      sessionId: secondSession,
      reason: "Platform authentication required.",
    }),
    createLifecycle(),
  );
  const secondViewer = requireAvailableViewer(
    await revocation.service.connectViewer({
      principalId: "desktop-main-2",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  const accepted = requireAvailableViewer(
    await revocation.service.acceptViewerTakeover({
      ...secondViewer,
      principalId: "desktop-main-2",
    }),
  );
  revocation.engine.failNextNativeRevocation = new Error(
    "BROWSER_ENGINE_FAILURE: native revocation unavailable",
  );
  await assert.rejects(
    revocation.service.returnViewerControl({
      ...secondViewer,
      principalId: "desktop-main-2",
      leaseId: accepted.inputLeaseId!,
    }),
    hasCode("BROWSER_ACTION_OUTCOME_UNKNOWN"),
  );
  assert.equal(revocation.engine.closed.length, 1);
});

test("Desktop native handoff never commits a presentation that outlives its injected-clock lease", async () => {
  let now = new Date();
  const engine = new FakeEngine();
  engine.onNativePresentation = () => {
    now = new Date(now.getTime() + 31_000);
  };
  const fixture = await createFixture({
    engine,
    now: () => now,
    scheduleExpiry: true,
  });
  const sessionId = await openSession(fixture.service);
  await fixture.service.execute(
    prepared("browser.request_takeover", {
      sessionId,
      reason: "Platform authentication required.",
    }),
    createLifecycle(),
  );
  const viewer = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  await assert.rejects(
    fixture.service.acceptViewerTakeover({
      ...viewer,
      principalId: "desktop-main-1",
    }),
    hasCode("BROWSER_ACTION_OUTCOME_UNKNOWN"),
  );
  assert.equal(engine.nativeHandoffs.length, 1);
  assert.equal(engine.revokedNativeHandoffs.length, 1);
  assert.equal(engine.closed.length, 1);
  assert.equal(
    (
      await fixture.service.connectViewer({
        principalId: "desktop-main-1",
        threadId: "thread-1",
        projectId: "project-1",
      })
    ).available,
    false,
  );
});

test("Desktop viewer authority loss and engine loss terminate human control instead of resuming the agent", async () => {
  const viewerEvents: DesktopBrowserViewerEventV1[] = [];
  const fixture = await createFixture({ viewerEvents });
  const sessionId = await openSession(fixture.service);
  await fixture.service.execute(
    prepared("browser.request_takeover", {
      sessionId,
      reason: "Authentication required.",
    }),
    createLifecycle(),
  );
  const viewer = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  await fixture.service.acceptViewerTakeover({
    ...viewer,
    principalId: "desktop-main-1",
  });
  fixture.engine.triggerLoss();
  await waitFor(async () => fixture.engine.closed.length === 1);
  assert.equal(
    (
      await fixture.service.connectViewer({
        principalId: "desktop-main-1",
        threadId: "thread-1",
        projectId: "project-1",
      })
    ).available,
    false,
  );
  assert.ok(viewerEvents.some((event) => event.name === "cleanup"));

  const secondViewerEvents: DesktopBrowserViewerEventV1[] = [];
  const second = await createFixture({ viewerEvents: secondViewerEvents });
  const secondSession = await openSession(second.service);
  await second.service.execute(
    prepared("browser.request_takeover", {
      sessionId: secondSession,
      reason: "Authentication required.",
    }),
    createLifecycle(),
  );
  const secondViewer = requireAvailableViewer(
    await second.service.connectViewer({
      principalId: "desktop-main-2",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  await assert.doesNotReject(
    second.service.connectViewer({
      principalId: "desktop-main-2",
      threadId: "thread-1",
      projectId: "project-1",
      sessionId: secondViewer.sessionId,
      generation: secondViewer.generation,
      connectionId: secondViewer.connectionId,
    }),
  );
  await assert.rejects(
    second.service.connectViewer({
      principalId: "desktop-main-2",
      threadId: "thread-1",
      projectId: "project-1",
      sessionId: secondViewer.sessionId,
      generation: secondViewer.generation + 1,
      connectionId: secondViewer.connectionId,
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  await second.service.loseViewerAuthority({
    ...secondViewer,
    principalId: "desktop-main-2",
  });
  await assert.doesNotReject(
    second.service.loseViewerAuthority({
      ...secondViewer,
      principalId: "desktop-main-2",
    }),
  );
  await assert.rejects(
    second.service.loseViewerAuthority({
      ...secondViewer,
      principalId: "desktop-main-2",
      generation: secondViewer.generation + 1,
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  await assert.rejects(
    second.service.loseViewerAuthority({
      ...secondViewer,
      principalId: "desktop-main-2",
      threadId: "thread-drifted",
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  assert.equal(second.engine.closed.length, 1);
  assert.ok(
    secondViewerEvents.some((event) => event.name === "authorization_loss"),
  );
  assert.ok(secondViewerEvents.some((event) => event.name === "cleanup"));
  await assert.rejects(
    second.service.execute(
      prepared("browser.snapshot", { sessionId: secondSession }),
      createLifecycle(),
    ),
    hasCode("BROWSER_SESSION_LOST"),
  );
  const replacementSession = await openSession(second.service);
  const terminalProof = await second.service.connectViewer({
    principalId: "desktop-main-2",
    threadId: "thread-1",
    projectId: "project-1",
    sessionId: secondViewer.sessionId,
    generation: secondViewer.generation,
    connectionId: secondViewer.connectionId,
  });
  assert.equal(terminalProof.available, false);
  const replacementViewer = requireAvailableViewer(
    await second.service.connectViewer({
      principalId: "desktop-main-2",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  assert.equal(replacementViewer.sessionId, replacementSession);
  await second.service.close();
  const restarted = await createFixture({ homePath: second.homePath });
  await assert.doesNotReject(
    restarted.service.loseViewerAuthority({
      ...secondViewer,
      principalId: "desktop-main-2",
    }),
  );
  await assert.rejects(
    restarted.service.loseViewerAuthority({
      ...secondViewer,
      principalId: "desktop-main-2",
      generation: secondViewer.generation + 1,
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  await restarted.service.close();
});

test("a restarted Desktop without an exact journal cannot inherit a surviving Local Core viewer connection", async () => {
  const fixture = await createFixture();
  const staleSessionId = await openSession(fixture.service);
  const senderId = 41;
  const principalId = "desktop-main-41-reused";
  const journalPath = path.join(
    fixture.homePath,
    "desktop-private",
    "browser-viewer-authority.json",
  );
  const stale = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId,
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  assert.equal(stale.sessionId, staleSessionId);

  // Local Core completed the connection, but Desktop exited before the exact
  // identity could be represented in its journal. The restarted coordinator
  // therefore has only the reused sender/bootstrap principal.
  let exactLosses = 0;
  const restarted = new DesktopBrowserViewerAuthorityCoordinator({
    journal: new DesktopBrowserViewerAuthorityJournal(journalPath),
    async loseAuthority(exact) {
      exactLosses += 1;
      await fixture.service.loseViewerAuthority({
        principalId: exact.principalId,
        threadId: exact.threadId,
        projectId: exact.projectId,
        sessionId: exact.sessionId,
        generation: exact.generation,
        connectionId: exact.connectionId,
      });
    },
  });
  const unavailable = await restarted.connect({
    senderId,
    principalId,
    threadId: "thread-1",
    projectId: "project-1",
    async connect(expected) {
      assert.equal(expected, undefined);
      const viewer = await fixture.service.connectViewer({
        principalId,
        threadId: "thread-1",
        projectId: "project-1",
      });
      return { value: viewer, previousSessionTerminal: !viewer.available };
    },
  });
  assert.equal(unavailable.available, false);
  assert.equal(restarted.current(), undefined);
  assert.equal(fixture.engine.closed.length, 1);
  assert.equal(exactLosses, 0);

  const replacementSessionId = await openSession(fixture.service);
  const replacement = await restarted.connect({
    senderId,
    principalId,
    threadId: "thread-1",
    projectId: "project-1",
    async connect(expected) {
      assert.equal(expected, undefined);
      const viewer = requireAvailableViewer(
        await fixture.service.connectViewer({
          principalId,
          threadId: "thread-1",
          projectId: "project-1",
        }),
      );
      const exact: DesktopBrowserViewerPrincipal = {
        senderId,
        principalId,
        threadId: viewer.threadId,
        projectId: viewer.projectId,
        sessionId: viewer.sessionId,
        generation: viewer.generation,
        connectionId: viewer.connectionId,
      };
      return { value: viewer, principal: exact };
    },
  });
  assert.equal(replacement.sessionId, replacementSessionId);
  assert.equal(fixture.engine.closed.length, 1);

  await restarted.loseCurrent({ reason: "desktop_stopped" });
  assert.equal(exactLosses, 1);
  assert.equal(fixture.engine.closed.length, 2);
  await fixture.service.close();
});

test("a crash-restored exact disconnect record is idempotent without changing its replacement viewer", async () => {
  const fixture = await createFixture();
  await openSession(fixture.service);
  const retired = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  await fixture.service.disconnectViewer({
    ...retired,
    principalId: "desktop-main-1",
  });
  const replacement = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );

  await assert.doesNotReject(
    fixture.service.cleanupViewerConnection({
      ...retired,
      principalId: "desktop-main-1",
    }),
  );
  const stillCurrent = requireAvailableViewer(
    await fixture.service.connectViewer({
      ...replacement,
      principalId: "desktop-main-1",
    }),
  );
  assert.equal(stillCurrent.connectionId, replacement.connectionId);
  assert.equal(fixture.engine.closed.length, 0);
  await assert.rejects(
    fixture.service.cleanupViewerConnection({
      ...retired,
      principalId: "desktop-main-1",
      generation: retired.generation + 1,
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  await fixture.service.close();
});

test("authority loss terminalizes the exact Session even after disconnect and replacement", async () => {
  const fixture = await createFixture();
  await openSession(fixture.service);
  const retired = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );
  await fixture.service.cleanupViewerConnection({
    ...retired,
    principalId: "desktop-main-1",
  });
  const replacement = requireAvailableViewer(
    await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    }),
  );

  await assert.rejects(
    fixture.service.loseViewerAuthority({
      ...retired,
      principalId: "desktop-main-1",
      generation: retired.generation + 1,
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  assert.equal(fixture.engine.closed.length, 0);
  assert.equal(
    requireAvailableViewer(
      await fixture.service.connectViewer({
        ...replacement,
        principalId: "desktop-main-1",
      }),
    ).connectionId,
    replacement.connectionId,
  );

  await assert.rejects(
    fixture.service.loseViewerAuthority({
      ...retired,
      principalId: "different-principal",
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  assert.equal(fixture.engine.closed.length, 0);

  await fixture.service.loseViewerAuthority({
    ...retired,
    principalId: "desktop-main-1",
  });

  assert.equal(fixture.engine.closed.length, 1);
  assert.equal(
    (
      await fixture.service.connectViewer({
        ...replacement,
        principalId: "desktop-main-1",
      })
    ).available,
    false,
  );
  await fixture.service.close();
});

test("operator open reuses the Thread Session across allowed destinations", async () => {
  const resolvedDestinations: Array<string | undefined> = [];
  const fixture = await createFixture({
    authorityResolver: {
      async resolve(input) {
        resolvedDestinations.push(input.destination);
        return operatorAuthority("revision-1", ["example.com"]);
      },
    },
  });
  const first = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/first" },
      }),
      createLifecycle(),
    ),
  );

  const second = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/second" },
      }),
      createLifecycle(),
    ),
  );
  assert.equal(second.outcome, "existing");
  assert.equal(
    asRecord(first.session).sessionId,
    asRecord(second.session).sessionId,
  );
  assert.equal(fixture.engine.opened.length, 1);
  assert.deepEqual(resolvedDestinations, [
    "https://example.com/first",
    "https://example.com/second",
  ]);
  await fixture.service.close();
});

test("existing operator open installs current authority before returning", async () => {
  let authority = operatorAuthority("revision-1", ["example.com"]);
  const fixture = await createFixture({
    authorityResolver: {
      async resolve() {
        return authority;
      },
    },
  });
  const openInput = {
    mode: "operator" as const,
    target: { kind: "public_url", url: "https://example.com/" },
  };
  await fixture.service.execute(
    prepared("browser.open", openInput),
    createLifecycle(),
  );
  authority = operatorAuthority("revision-2", []);

  await assert.rejects(
    fixture.service.execute(
      prepared("browser.open", openInput),
      createLifecycle(),
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );
  assert.equal(fixture.proxies[0]?.adoptions, 1);
  assert.equal(
    fixture.proxies[0]?.launchBinding.effectiveAllowlistRevision,
    "revision-2",
  );
  assert.equal(fixture.engine.opened.length, 1);
  await fixture.service.close();
});

test("existing operator open terminates directly when its authority recheck fails", async () => {
  const criticalSection = new LocalCoreBrowserAuthorityCriticalSection();
  let authorityAvailable = true;
  let service: DesktopBrowserService | undefined;
  const fixture = await createFixture({
    withAuthorityAdmission: async (action) => await criticalSection.run(action),
    authorityResolver: {
      async resolve() {
        if (!authorityAvailable) {
          return await criticalSection.run(async () => {
            await service!.close();
            throw new Error("account unauthorized");
          });
        }
        return operatorAuthority("revision-1", ["example.com"]);
      },
    },
  });
  service = fixture.service;
  const openInput = {
    mode: "operator" as const,
    target: { kind: "public_url", url: "https://example.com/" },
  };
  await fixture.service.execute(
    prepared("browser.open", openInput),
    createLifecycle(),
  );
  authorityAvailable = false;

  await assert.rejects(
    settleWithin(
      fixture.service.execute(
        prepared("browser.open", openInput),
        createLifecycle(),
      ),
    ),
    /account unauthorized/u,
  );
  assert.equal(fixture.engine.closed.length, 1);
  assert.equal(fixture.proxies[0]?.closed, true);
});

test("existing open terminates directly when the active Session expired", async () => {
  let now = new Date("2026-08-30T12:00:00.000Z");
  const fixture = await createFixture({ now: () => now });
  const openInput = {
    mode: "qa" as const,
    target: {
      kind: "desktop_project_run",
      projectId: "project-1",
      runId: "run-1",
      urlId: PREVIEW_ID,
    },
  };
  await fixture.service.execute(
    prepared("browser.open", openInput),
    createLifecycle(),
  );
  now = new Date("2026-08-30T13:00:00.000Z");

  await assert.rejects(
    settleWithin(
      fixture.service.execute(
        prepared("browser.open", openInput),
        createLifecycle(),
      ),
    ),
    hasCode("BROWSER_SESSION_EXPIRED"),
  );
  assert.equal(fixture.engine.closed.length, 1);
  assert.equal(fixture.proxies[0]?.closed, true);
});

test("concurrent replay of one exact open call launches once", async () => {
  const fixture = await createFixture();
  const exactCall = prepared("browser.open", {
    mode: "qa",
    target: {
      kind: "desktop_project_run",
      projectId: "project-1",
      runId: "run-1",
      urlId: PREVIEW_ID,
    },
  });
  const [first, second] = await Promise.all([
    fixture.service.execute(exactCall, createLifecycle()),
    fixture.service.execute(exactCall, createLifecycle()),
  ]);

  assert.deepEqual(second, first);
  assert.equal(asRecord(first).outcome, "opened");
  assert.equal(fixture.engine.opened.length, 1);
  await fixture.service.close();
});

test("prior-generation nonterminal sessions become lost and their owned runtime is cleaned", async () => {
  const fixture = await createFixture();
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      createLifecycle(),
    ),
  );
  const openedSession = asRecord(opened.session);
  const recoveringEngine = new FakeEngine();
  const recovered = await createFixture({
    homePath: fixture.homePath,
    engine: recoveringEngine,
  });
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  const lost = ledger.sessions.find(
    (session) => session.sessionId === openedSession.sessionId,
  );
  assert.equal(lost?.state, "lost");
  assert.equal(lost?.terminalReason, "BROWSER_SESSION_LOST");
  assert.equal(recoveringEngine.closed.length, 1);
  await recovered.service.close();
});

test("restart blocks when orphan engine termination cannot be proven", async () => {
  const fixture = await createFixture();
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      createLifecycle(),
    ),
  );
  const sessionId = String(asRecord(opened.session).sessionId);
  const recoveringEngine = new FakeEngine();
  recoveringEngine.failNextClose = new Error("termination unproven");
  const recovering = await createFixture({
    homePath: fixture.homePath,
    engine: recoveringEngine,
    initialize: false,
  });

  await assert.rejects(
    recovering.service.initialize(),
    /termination unproven/u,
  );
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  assert.equal(
    ledger.sessions.find((session) => session.sessionId === sessionId)?.state,
    "ready",
  );
  await stat(path.join(fixture.homePath, "browser", "runtime", sessionId));
  await fixture.service.close();
});

test("restart fails closed when a prior launch has neither PID nor socket termination proof", async () => {
  const fixture = await createFixture();
  const sessionId = await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  await rm(invocation.socketPath, { recursive: true, force: true });
  const recoveringEngine = new FakeEngine();
  const recovering = await createFixture({
    homePath: fixture.homePath,
    engine: recoveringEngine,
    initialize: false,
  });
  await assert.rejects(
    recovering.service.initialize(),
    /no PID or session socket termination proof/u,
  );
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  assert.equal(
    ledger.sessions.find((session) => session.sessionId === sessionId)?.state,
    "ready",
  );
  assert.equal(recoveringEngine.closed.length, 0);
  await stat(invocation.runtimePath);
});

test("restart fails closed when a ready session has no remaining termination proof", async () => {
  const fixture = await createFixture();
  const sessionId = await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  await rm(invocation.runtimePath, { recursive: true, force: true });
  await rm(invocation.socketPath, { recursive: true, force: true });
  const recovering = await createFixture({
    homePath: fixture.homePath,
    engine: new FakeEngine(),
    initialize: false,
  });

  await assert.rejects(
    recovering.service.initialize(),
    /nonterminal Browser launch has no PID or session socket termination proof/u,
  );
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  assert.equal(
    ledger.sessions.find((session) => session.sessionId === sessionId)?.state,
    "ready",
  );
});

test("persisted and generated Browser session IDs cannot escape owned cleanup paths", async () => {
  const fixture = await createFixture();
  const sessionId = await openSession(fixture.service);
  const ledgerPath = path.join(fixture.homePath, "browser", "sessions.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
    sessions: BrowserSessionV1[];
    artifacts: unknown[];
    version: string;
  };
  ledger.sessions[0]!.sessionId = "../outside-runtime";
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const outsideRuntime = path.join(
    fixture.homePath,
    "browser",
    "outside-runtime",
  );
  await mkdir(outsideRuntime, { recursive: true });
  await writeFile(path.join(outsideRuntime, "sentinel"), "retained");

  const recovering = await createFixture({
    homePath: fixture.homePath,
    initialize: false,
  });
  await assert.rejects(
    recovering.service.initialize(),
    /path-safe opaque identifier/u,
  );
  assert.equal(
    await readFile(path.join(outsideRuntime, "sentinel"), "utf8"),
    "retained",
  );

  const generated = await createFixture({
    randomId: () => "../../generated-escape",
  });
  await assert.rejects(openSession(generated.service), /path-safe opaque/u);
  assert.equal(generated.engine.opened.length, 0);

  // Restore the real ledger so the original fixture can prove its own cleanup.
  ledger.sessions[0]!.sessionId = sessionId;
  await writeFile(ledgerPath, JSON.stringify(ledger));
  await fixture.service.close();
});

test("terminal orphan cleanup converges after either ordered path-removal boundary", async () => {
  for (const remainingPath of ["runtime", "socket"] as const) {
    const fixture = await createFixture();
    const sessionId = await openSession(fixture.service);
    const invocation = fixture.engine.opened[0]!;
    const ledgerPath = path.join(fixture.homePath, "browser", "sessions.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      sessions: BrowserSessionV1[];
    };
    ledger.sessions[0]!.state = "closed";
    ledger.sessions[0]!.terminalReason = "closed_by_user";
    await writeFile(ledgerPath, JSON.stringify(ledger));
    await rm(
      remainingPath === "runtime"
        ? invocation.socketPath
        : invocation.runtimePath,
      { recursive: true, force: true },
    );

    const recoveringEngine = new FakeEngine();
    const recovering = await createFixture({
      homePath: fixture.homePath,
      engine: recoveringEngine,
    });
    await assert.rejects(stat(invocation.runtimePath), { code: "ENOENT" });
    await assert.rejects(stat(invocation.socketPath), { code: "ENOENT" });
    assert.equal(
      recoveringEngine.closed.length,
      remainingPath === "socket" ? 1 : 0,
    );
    await recovering.service.close();
  }
});

test("cleanup is not reported complete when the engine cannot prove termination", async () => {
  const metrics: DesktopBrowserMetric[] = [];
  const fixture = await createFixture({ metrics });
  const sessionId = await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  fixture.engine.failNextClose = new Error("termination unproven");

  await assert.rejects(
    fixture.service.execute(
      prepared("browser.close", { sessionId }),
      createLifecycle(),
    ),
    /termination unproven/u,
  );
  await stat(invocation.runtimePath);
  assert.equal(
    metrics.some(
      (metric) =>
        metric.name === "browser_cleanup" &&
        metric.outcome === "failure" &&
        metric.reason === "termination_unproven",
    ),
    true,
  );
  assert.equal(
    metrics.some(
      (metric) =>
        metric.name === "browser_cleanup" && metric.outcome === "success",
    ),
    false,
  );

  await assert.rejects(
    fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_SESSION_CONFLICT"),
  );
  assert.equal(fixture.engine.opened.length, 1);

  const retryLifecycle = createLifecycle();
  await fixture.service.execute(
    prepared("browser.close", { sessionId }),
    retryLifecycle,
  );
  assert.deepEqual(retryLifecycle.events, ["ack", "persist"]);
  await assert.rejects(stat(invocation.runtimePath), { code: "ENOENT" });
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  assert.equal(ledger.sessions[0]?.state, "closed");
});

test("adapter rejection leaves an operation unacknowledged", async () => {
  const fixture = await createFixture();
  const sessionId = await openSession(fixture.service);
  fixture.engine.failNextAcceptance = new Error("adapter rejected identity");
  const lifecycle = createLifecycle();

  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      lifecycle,
    ),
    /adapter rejected identity/u,
  );
  assert.deepEqual(lifecycle.events, []);
  assert.equal(fixture.engine.commands.length, 0);
  assert.equal(fixture.engine.accepted.at(-1)?.grantGeneration, 1);

  fixture.engine.failNextAcceptance = new Error(
    "adapter rejected close identity",
  );
  const closeLifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.close", { sessionId }),
      closeLifecycle,
    ),
    /adapter rejected close identity/u,
  );
  assert.deepEqual(closeLifecycle.events, []);
  assert.equal(fixture.engine.closed.length, 0);
  await fixture.service.close();
});

test("all engine operations serialize and stale snapshot refs fail before acknowledgement", async () => {
  const engine = new FakeEngine({
    snapshotContent: "x".repeat(70_000),
    delaySnapshot: true,
  });
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const firstLifecycle = createLifecycle();
  const secondLifecycle = createLifecycle();
  const first = fixture.service.execute(
    prepared("browser.snapshot", { sessionId }),
    firstLifecycle,
  );
  const second = fixture.service.execute(
    prepared("browser.snapshot", { sessionId }),
    secondLifecycle,
  );
  await Promise.all([first, second]);
  assert.equal(engine.maxConcurrentCommands, 1);

  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  assert.equal(snapshot.complete, false);
  assert.equal(typeof snapshot.nextCursor, "string");
  const continuation = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", {
        sessionId,
        cursor: snapshot.nextCursor,
      }),
      createLifecycle(),
    ),
  );
  assert.equal(continuation.complete, false);
  const staleLifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: "forged-revision",
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      staleLifecycle,
    ),
    hasCode("BROWSER_TARGET_STALE"),
  );
  assert.deepEqual(staleLifecycle.events, []);
  await fixture.service.close();
});

test("ledger writes preserve invocation order and continue after a failed write", async () => {
  let armed = false;
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const firstReleasePromise = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const snapshots: BrowserSessionV1[][] = [];
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  let failNextWrite = false;
  let clock = Date.parse("2026-08-29T12:00:00.000Z");
  const fixture = await createFixture({
    now: () => new Date(clock++),
    writeLedger: async (_ledgerPath, ledger) => {
      if (!armed) return;
      snapshots.push(ledger.sessions.map((session) => ({ ...session })));
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      try {
        if (snapshots.length === 1) {
          firstStarted();
          await firstReleasePromise;
        }
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("ledger write failed");
        }
      } finally {
        activeWrites -= 1;
      }
    },
  });
  const firstSessionId = await openSession(fixture.service);
  const secondOpen = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      createLifecycle({ threadId: "thread-2" }),
    ),
  );
  const secondSessionId = String(asRecord(secondOpen.session).sessionId);
  armed = true;

  const firstSnapshot = fixture.service.execute(
    prepared("browser.snapshot", { sessionId: firstSessionId }),
    createLifecycle(),
  );
  await firstStartedPromise;
  const secondSnapshot = fixture.service.execute(
    prepared("browser.snapshot", { sessionId: secondSessionId }),
    createLifecycle({ threadId: "thread-2" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(snapshots.length, 1);
  releaseFirst();
  await Promise.all([firstSnapshot, secondSnapshot]);
  assert.equal(snapshots.length, 2);
  assert.equal(maximumActiveWrites, 1);
  const firstSecondThreadActivity = snapshots[0]?.find(
    (session) => session.threadId === "thread-2",
  )?.lastActivityAt;
  const secondSecondThreadActivity = snapshots[1]?.find(
    (session) => session.threadId === "thread-2",
  )?.lastActivityAt;
  assert.notEqual(firstSecondThreadActivity, secondSecondThreadActivity);

  failNextWrite = true;
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId: firstSessionId }),
      createLifecycle(),
    ),
    /ledger write failed/u,
  );
  await fixture.service.execute(
    prepared("browser.snapshot", { sessionId: firstSessionId }),
    createLifecycle(),
  );
  await fixture.service.close();
});

test("snapshot selects the exact tab and a lost snapshot tab is stale before interaction", async () => {
  const engine = new FakeEngine({
    tabs: [
      { tabId: "t1", url: PREVIEW_URL, title: "First", active: true },
      { tabId: "t2", url: PREVIEW_URL, title: "Second", active: false },
    ],
  });
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId, tabId: "t2" }),
      createLifecycle(),
    ),
  );
  const selectIndex = engine.commands.findIndex(
    (command) => command[0] === "tab" && command[1] === "t2",
  );
  const snapshotIndex = engine.commands.findIndex(
    (command) => command[0] === "snapshot",
  );
  assert.equal(selectIndex >= 0 && selectIndex < snapshotIndex, true);

  engine.removeTab("t2");
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t2",
        action: { kind: "click", ref: "@e1" },
      }),
      lifecycle,
    ),
    hasCode("BROWSER_TARGET_STALE"),
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(
    engine.commands.some((command) => command[0] === "click"),
    false,
  );
  await fixture.service.close();
});

test("tab loss after an acknowledged effect is unknown while read-only tab loss is stale", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );

  engine.failNextCommand = new Error("tab_gone");
  const effectLifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      effectLifecycle,
    ),
    hasCode("BROWSER_ACTION_OUTCOME_UNKNOWN"),
  );
  assert.deepEqual(effectLifecycle.events, ["ack"]);

  engine.failNextCommand = new Error("tab_gone");
  const readLifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      readLifecycle,
    ),
    hasCode("BROWSER_TARGET_STALE"),
  );
  assert.deepEqual(readLifecycle.events, ["ack"]);
  await fixture.service.close();
});

test("interaction rechecks the current document revision before its effect", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  engine.snapshotContent = '- button "Changed" [ref=e1]';
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      lifecycle,
    ),
    hasCode("BROWSER_TARGET_STALE"),
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(
    engine.commands.some((command) => command[0] === "click"),
    false,
  );
  await fixture.service.close();
});

test("unchanged pinned-engine document ignores per-response boundary nonces", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  try {
    const sessionId = await openSession(fixture.service);
    const snapshot = asRecord(
      await fixture.service.execute(
        prepared("browser.snapshot", { sessionId }),
        createLifecycle(),
      ),
    );
    const output = asRecord(
      await fixture.service.execute(
        prepared("browser.interact", {
          sessionId,
          snapshotId: snapshot.snapshotId,
          documentRevision: snapshot.documentRevision,
          tabId: "t1",
          action: { kind: "click", ref: "@e1" },
        }),
        createLifecycle(),
      ),
    );
    assert.equal(output.outcome, "completed");
    assert.ok(engine.commands.some((command) => command[0] === "click"));
  } finally {
    await fixture.service.close();
  }
});

test("same-shape same-origin navigation invalidates snapshot document authority", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  engine.tabs[0]!.url = "http://localhost:4317/other-document";
  engine.documentIdentity = "navigation-2";
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      lifecycle,
    ),
    hasCode("BROWSER_TARGET_STALE"),
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(
    engine.commands.some((command) => command[0] === "click"),
    false,
  );
  await fixture.service.close();
});

test("authority close waits for an in-flight effect and prevents its success commit", async () => {
  let release!: () => void;
  let paused!: () => void;
  const pausedPromise = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const engine = new FakeEngine();
  engine.pauseCommand = "click";
  engine.commandPaused = paused;
  engine.resumeCommand = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  const lifecycle = createLifecycle();
  const operation = fixture.service.execute(
    prepared("browser.interact", {
      sessionId,
      snapshotId: snapshot.snapshotId,
      documentRevision: snapshot.documentRevision,
      tabId: "t1",
      action: { kind: "click", ref: "@e1" },
    }),
    lifecycle,
  );
  await pausedPromise;
  const closing = fixture.service.closeAuthority({ projectIds: ["project-1"] });
  release();
  await assert.rejects(operation, hasCode("BROWSER_SESSION_LOST"));
  assert.equal(await closing, 1);
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(fixture.engine.closed.length, 1);
});

test("every non-open operation rejects a stale generation before acknowledgement", async () => {
  const fixture = await createFixture();
  const sessionId = await openSession(fixture.service);
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId, generation: 999 }),
      lifecycle,
    ),
    hasCode("BROWSER_SESSION_LOST"),
  );
  assert.deepEqual(lifecycle.events, []);
  assert.equal(fixture.engine.commands.length, 0);
  await fixture.service.close();
});

test("request-grant policy rejects a stale generation before authority resolution", async () => {
  let resolutions = 0;
  const fixture = await createFixture({
    authorityResolver: {
      async resolve() {
        resolutions += 1;
        return operatorAuthority("revision-1", ["example.com"]);
      },
    },
  });
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);
  const beforePolicy = resolutions;

  await assert.rejects(
    fixture.service.resolvePolicy({
      version: "browser_policy_resolution_v1",
      runId: "grant-policy-run",
      threadId: "thread-1",
      operation: "browser.request_grant",
      effectiveInput: {
        sessionId: session.sessionId,
        generation: Number(session.generation) + 1,
        destination: "https://openai.com/",
      },
      authority: createLifecycle().authority,
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  assert.equal(resolutions, beforePolicy);
  assert.equal(fixture.engine.closed.length, 0);
  await fixture.service.close();
});

test("unavailable or disabled current authority loses the active Session", async () => {
  for (const failure of ["unavailable", "disabled"] as const) {
    let current = false;
    const fixture = await createFixture({
      authorityResolver: {
        async resolve() {
          if (!current) return operatorAuthority("revision-1", ["example.com"]);
          if (failure === "unavailable")
            throw new Error("authority unavailable");
          return {
            ...operatorAuthority("revision-2", ["example.com"]),
            enabledModes: [],
          };
        },
      },
    });
    const opened = asRecord(
      await fixture.service.execute(
        prepared("browser.open", {
          mode: "operator",
          target: { kind: "public_url", url: "https://example.com/" },
        }),
        createLifecycle(),
      ),
    );
    const session = asRecord(opened.session);
    current = true;
    const lifecycle = createLifecycle();
    await assert.rejects(
      fixture.service.execute(
        prepared("browser.snapshot", {
          sessionId: session.sessionId,
          generation: session.generation,
        }),
        lifecycle,
      ),
    );
    assert.deepEqual(lifecycle.events, []);
    assert.equal(fixture.proxies[0]?.closed, true, failure);
    assert.equal(fixture.engine.closed.length, 1, failure);
    await assert.rejects(
      fixture.service.execute(
        prepared("browser.snapshot", {
          sessionId: session.sessionId,
          generation: session.generation,
        }),
        createLifecycle(),
      ),
      hasCode("BROWSER_SESSION_LOST"),
    );
  }
});

test("active operator account 401 can close its own Session without deadlock", async () => {
  let service: DesktopBrowserService | undefined;
  let accountRejected = false;
  const fixture = await createFixture({
    authorityResolver: {
      async resolve() {
        if (!accountRejected) {
          return operatorAuthority("revision-1", ["example.com"]);
        }
        await service!.close();
        throw new Error("account request failed with HTTP 401");
      },
    },
  });
  service = fixture.service;
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);
  const commandsBefore401 = fixture.engine.commands.length;
  accountRejected = true;
  const lifecycle = createLifecycle();

  await assert.rejects(
    settleWithin(
      fixture.service.execute(
        prepared("browser.snapshot", {
          sessionId: session.sessionId,
          generation: session.generation,
        }),
        lifecycle,
      ),
    ),
    /HTTP 401/u,
  );
  assert.deepEqual(lifecycle.events, []);
  assert.equal(fixture.engine.commands.length, commandsBefore401);
  assert.equal(fixture.engine.closed.length, 1);
  assert.equal(fixture.proxies[0]?.closed, true);
});

test("operator revision changes adopt before a revoked destination is rejected without acknowledgement", async () => {
  let authority = operatorAuthority("revision-1", ["example.com"]);
  const authorityResolver: DesktopBrowserAuthorityResolver = {
    async resolve() {
      return authority;
    },
  };
  const fixture = await createFixture({ authorityResolver });
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);
  authority = operatorAuthority("revision-2", []);
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", {
        sessionId: session.sessionId,
        generation: session.generation,
      }),
      lifecycle,
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(fixture.proxies[0]?.adoptions, 1);
  assert.equal(
    fixture.proxies[0]?.launchBinding.effectiveAllowlistRevision,
    "revision-2",
  );
  assert.deepEqual(fixture.engine.commands, [["get", "url", "--json"]]);
  await fixture.service.close();
});

test("active page authority fences redirects, history, interactions, popup activation, tab switches, and revocation", async () => {
  let authority = operatorAuthority("revision-1", [
    "example.com",
    "allowed.com",
  ]);
  const engine = new FakeEngine();
  const fixture = await createFixture({
    engine,
    authorityResolver: {
      async resolve() {
        return authority;
      },
    },
  });
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);
  const sessionInput = {
    sessionId: session.sessionId,
    generation: session.generation,
  };

  engine.urlAfterCommand = {
    command: "open",
    url: "https://blocked.example.net/redirected",
  };
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.navigate", {
        ...sessionInput,
        kind: "url",
        url: "https://allowed.com/start",
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );

  engine.tabs[0]!.url = "https://example.com/";
  engine.urlAfterCommand = {
    command: "back",
    url: "https://blocked.example.net/history",
  };
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.navigate", { ...sessionInput, kind: "back" }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );

  engine.tabs[0]!.url = "https://example.com/";
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", sessionInput),
      createLifecycle(),
    ),
  );
  engine.urlAfterCommand = {
    command: "click",
    url: "https://blocked.example.net/interaction",
  };
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.interact", {
        ...sessionInput,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );

  engine.tabs[0]!.url = "https://example.com/";
  engine.tabs[0]!.active = false;
  engine.tabs.push({
    tabId: "t2",
    url: "https://blocked.example.net/popup",
    title: "Untrusted popup title",
    active: true,
  });
  const snapshotsBeforePopup = engine.commands.filter(
    (command) => command[0] === "snapshot",
  ).length;
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", sessionInput),
      createLifecycle(),
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );
  assert.equal(
    engine.commands.filter((command) => command[0] === "snapshot").length,
    snapshotsBeforePopup,
  );

  engine.tabs[0]!.active = true;
  engine.tabs[1]!.active = false;
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.tabs", {
        ...sessionInput,
        operation: "switch",
        tabId: "t2",
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );

  engine.tabs[0]!.active = true;
  engine.tabs[1]!.active = false;
  engine.tabs[1]!.url = "https://allowed.com/popup";
  const switched = asRecord(
    await fixture.service.execute(
      prepared("browser.tabs", {
        ...sessionInput,
        operation: "switch",
        tabId: "t2",
      }),
      createLifecycle(),
    ),
  );
  assert.equal(switched.boundary, "untrusted_browser_content");
  assert.equal(typeof switched.capturedAt, "string");
  authority = operatorAuthority("revision-2", ["example.com"]);
  const revokedLifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.tabs", { ...sessionInput, operation: "list" }),
      revokedLifecycle,
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );
  assert.deepEqual(revokedLifecycle.events, ["ack"]);
  await fixture.service.close();
});

test("tabs output is deterministically bounded while retaining active and effectful target identity", async () => {
  const tabs = Array.from({ length: 105 }, (_, index) => ({
    tabId: `t${index + 1}`,
    url: PREVIEW_URL,
    title: `Tab ${index + 1}`,
    active: index === 103,
  }));
  const engine = new FakeEngine({ tabs });
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);

  const listed = asRecord(
    await fixture.service.execute(
      prepared("browser.tabs", { sessionId, operation: "list" }),
      createLifecycle(),
    ),
  );
  const listedTabs = listed.tabs as Array<{ tabId: string; active: boolean }>;
  assert.equal(listedTabs.length, 100);
  assert.equal(listed.activeTabId, "t104");
  assert.equal(
    listedTabs.some((tab) => tab.tabId === "t104"),
    true,
  );

  const switched = asRecord(
    await fixture.service.execute(
      prepared("browser.tabs", {
        sessionId,
        operation: "switch",
        tabId: "t105",
      }),
      createLifecycle(),
    ),
  );
  const switchedTabs = switched.tabs as Array<{
    tabId: string;
    active: boolean;
  }>;
  assert.equal(switchedTabs.length, 100);
  assert.equal(switched.activeTabId, "t105");
  assert.equal(
    switchedTabs.some((tab) => tab.tabId === "t105" && tab.active),
    true,
  );

  const closed = asRecord(
    await fixture.service.execute(
      prepared("browser.tabs", {
        sessionId,
        operation: "close",
        tabId: "t105",
      }),
      createLifecycle(),
    ),
  );
  const closedTabs = closed.tabs as Array<{ tabId: string; active: boolean }>;
  assert.equal(closedTabs.length, 100);
  assert.equal(closed.activeTabId, "t1");
  assert.equal(
    closedTabs.some((tab) => tab.tabId === "t1" && tab.active),
    true,
  );
  assert.equal(
    closedTabs.some((tab) => tab.tabId === "t105"),
    false,
  );
  await fixture.service.close();
});

test("tabs reject missing, malformed, and unsupported URL origins without inventing localhost", async () => {
  for (const invalidUrl of [undefined, "not a URL", "about:blank"] as const) {
    const engine = new FakeEngine({
      tabs: [
        { tabId: "t1", url: PREVIEW_URL, title: "Active", active: true },
        { tabId: "t2", url: invalidUrl, title: "Invalid", active: false },
      ],
    });
    const fixture = await createFixture({ engine });
    const sessionId = await openSession(fixture.service);
    await assert.rejects(
      fixture.service.execute(
        prepared("browser.tabs", { sessionId, operation: "list" }),
        createLifecycle(),
      ),
      hasCode("BROWSER_ENGINE_FAILURE"),
    );
    await fixture.service.close();
  }
});

test("personal revision adoption targets one approved Session or every matching revoked scope", async () => {
  let authority = operatorAuthority("revision-1", ["example.com"]);
  let personalRevision = 1;
  const fixture = await createFixture({
    authorityResolver: {
      async resolve() {
        return authority;
      },
      async resolveForPersonalRevision() {
        return { authority, personalRevision };
      },
    },
  });
  const first = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle({ threadId: "thread-1" }),
    ),
  );
  const second = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle({ threadId: "thread-2" }),
    ),
  );
  const firstSession = asRecord(first.session);
  const secondSession = asRecord(second.session);
  authority = operatorAuthority("revision-2", ["example.com"]);
  personalRevision = 2;
  await fixture.service.adoptPersonalRevision({
    accountId: "user-1",
    environmentId: "environment-1",
    personalRevision: 2,
    threadId: "thread-1",
    sessionId: String(firstSession.sessionId),
  });
  assert.deepEqual(
    fixture.proxies.map((proxy) => proxy.adoptions),
    [1, 0],
  );
  authority = operatorAuthority("revision-3", []);
  personalRevision = 3;
  await fixture.service.adoptPersonalRevision({
    accountId: "user-1",
    environmentId: "environment-1",
    personalRevision: 3,
  });
  assert.deepEqual(
    fixture.proxies.map((proxy) => proxy.adoptions),
    [2, 1],
  );
  assert.notEqual(firstSession.sessionId, secondSession.sessionId);
  await fixture.service.close();
});

test("personal revision adoption waits for the current operation before changing authority", async () => {
  let authority = operatorAuthority("revision-1", ["example.com"]);
  let personalRevision = 1;
  const engine = new FakeEngine();
  const fixture = await createFixture({
    engine,
    authorityResolver: {
      async resolve() {
        return authority;
      },
      async resolveForPersonalRevision() {
        return { authority, personalRevision };
      },
    },
  });
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);
  let release!: () => void;
  let paused!: () => void;
  const pausedPromise = new Promise<void>((resolve) => {
    paused = resolve;
  });
  engine.pauseCommand = "snapshot";
  engine.commandPaused = paused;
  engine.resumeCommand = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = fixture.service.execute(
    prepared("browser.snapshot", {
      sessionId: session.sessionId,
      generation: session.generation,
    }),
    createLifecycle(),
  );
  await pausedPromise;
  authority = operatorAuthority("revision-2", ["example.com"]);
  personalRevision = 2;
  let adopted = false;
  const adoption = fixture.service
    .adoptPersonalRevision({
      accountId: "user-1",
      environmentId: "environment-1",
      personalRevision: 2,
    })
    .then(() => {
      adopted = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(adopted, false);
  assert.equal(fixture.proxies[0]?.adoptions, 0);
  release();
  await operation;
  await adoption;
  assert.equal(fixture.proxies[0]?.adoptions, 1);
  await fixture.service.close();
});

test("request grant installs and persists returned authority before success", async () => {
  let authority = operatorAuthority("revision-1", ["example.com"]);
  let rememberedProjectId: string | undefined;
  let remembers = 0;
  const fixture = await createFixture({
    authorityResolver: {
      async resolve() {
        return authority;
      },
      async rememberPersonalDomain(input) {
        remembers += 1;
        rememberedProjectId = input.projectId;
        authority = operatorAuthority("revision-2", [
          "example.com",
          "openai.com",
        ]);
        return authority;
      },
    },
  });
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);
  const grant = prepared("browser.request_grant", {
    sessionId: session.sessionId,
    generation: session.generation,
    destination: "https://openai.com/",
  });
  grant.approval = {
    authorityRevision: "approval-authority-1",
    approvalId: "approval-1",
  };
  const lifecycle = createLifecycle();

  const result = asRecord(await fixture.service.execute(grant, lifecycle));
  assert.equal(result.outcome, "granted");
  assert.equal(rememberedProjectId, "project-1");
  assert.equal(result.effectiveAllowlistRevision, "revision-2");
  assert.equal(fixture.proxies[0]?.adoptions, 1);
  assert.equal(
    fixture.proxies[0]?.launchBinding.effectiveAllowlistRevision,
    "revision-2",
  );
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  assert.equal(
    ledger.sessions.find(
      (entry) => entry.sessionId === String(session.sessionId),
    )?.effectiveAllowlistRevision,
    "revision-2",
  );
  assert.deepEqual(lifecycle.events, ["ack", "persist"]);

  const alreadyAllowed = prepared("browser.request_grant", {
    sessionId: session.sessionId,
    generation: session.generation,
    destination: "https://openai.com/another-path",
  });
  alreadyAllowed.approval = {
    authorityRevision: "approval-authority-2",
    approvalId: "approval-2",
  };
  const alreadyAllowedLifecycle = createLifecycle();
  const alreadyAllowedResult = asRecord(
    await fixture.service.execute(alreadyAllowed, alreadyAllowedLifecycle),
  );
  assert.equal(alreadyAllowedResult.outcome, "already_allowed");
  assert.equal(remembers, 1);
  assert.equal(fixture.proxies[0]?.adoptions, 1);
  assert.deepEqual(alreadyAllowedLifecycle.events, ["persist"]);
  await fixture.service.close();
});

test("concurrent grants share durable Local Core settings and survive Browser service restart", async (context) => {
  const homePath = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-browser-durable-grants-"),
  );
  context.after(async () => {
    await rm(homePath, { recursive: true, force: true });
  });
  const createResolver = () =>
    new LocalCoreDesktopBrowserAuthorityResolver({
      homePath,
      account: { account: async () => realSignedInBrowserAccount() as never },
      environments: {
        snapshot: async () => realDesktopBrowserEnvironment() as never,
      },
    });
  let firstId = 0;
  const first = await createFixture({
    homePath,
    authorityResolver: createResolver(),
    randomId: () => `first-${++firstId}`,
  });
  const open = async (threadId: string) => {
    const output = asRecord(
      await first.service.execute(
        prepared("browser.open", {
          mode: "operator",
          target: {
            kind: "public_url",
            url: "https://configured-example.com/",
          },
        }),
        createLifecycle({ threadId, projectId: "local-project" }),
      ),
    );
    return asRecord(output.session);
  };
  const [openAiSession, anthropicSession] = await Promise.all([
    open("thread-openai"),
    open("thread-anthropic"),
  ]);
  const grant = (
    session: Record<string, unknown>,
    threadId: string,
    destination: string,
    approvalId: string,
  ) => {
    const call = prepared("browser.request_grant", {
      sessionId: session.sessionId,
      generation: session.generation,
      destination,
    });
    call.approval = {
      authorityRevision: "approval-authority-1",
      approvalId,
    };
    return first.service.execute(
      call,
      createLifecycle({ threadId, projectId: "local-project" }),
    );
  };
  const results = await Promise.all([
    grant(
      openAiSession,
      "thread-openai",
      "https://openai.com/",
      "approval-openai",
    ),
    grant(
      anthropicSession,
      "thread-anthropic",
      "https://anthropic.com/",
      "approval-anthropic",
    ),
  ]);
  assert.deepEqual(
    results.map((result) => asRecord(result).outcome),
    ["granted", "granted"],
  );
  assert.deepEqual(
    first.proxies.map((proxy) => proxy.adoptions),
    [1, 1],
  );
  const durable = JSON.parse(
    await readFile(
      path.join(homePath, "settings", "local-core-settings.json"),
      "utf8",
    ),
  ) as {
    browserPersonalDomains: {
      partitions: Array<{
        revision: number;
        domains: Array<{ authority: { canonicalDomain: string } }>;
      }>;
    };
  };
  assert.equal(durable.browserPersonalDomains.partitions[0]?.revision, 2);
  assert.deepEqual(
    durable.browserPersonalDomains.partitions[0]?.domains.map(
      (entry) => entry.authority.canonicalDomain,
    ),
    ["anthropic.com", "openai.com"],
  );
  await first.service.close();

  let restartId = 0;
  const restarted = await createFixture({
    homePath,
    authorityResolver: createResolver(),
    randomId: () => `restart-${++restartId}`,
  });
  const restoredOpen = asRecord(
    await restarted.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://openai.com/" },
      }),
      createLifecycle({
        threadId: "thread-restart",
        projectId: "local-project",
      }),
    ),
  );
  const restoredSession = asRecord(restoredOpen.session);
  const policy = await restarted.service.resolvePolicy({
    version: "browser_policy_resolution_v1",
    runId: "restart-policy-run",
    threadId: "thread-restart",
    operation: "browser.request_grant",
    effectiveInput: {
      sessionId: restoredSession.sessionId,
      generation: restoredSession.generation,
      destination: "https://anthropic.com/",
    },
    authority: createLifecycle({
      threadId: "thread-restart",
      projectId: "local-project",
    }).authority,
  });
  assert.equal(policy.decision, "allow");
  await restarted.service.close();
});

test("personal revision adoption fails closed when the persisted revision does not match", async () => {
  const authority = operatorAuthority("revision-2", ["example.com"]);
  const fixture = await createFixture({
    authorityResolver: {
      async resolve() {
        return authority;
      },
      async resolveForPersonalRevision() {
        return { authority, personalRevision: 3 };
      },
    },
  });
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);

  await assert.rejects(
    fixture.service.adoptPersonalRevision({
      accountId: "user-1",
      environmentId: "environment-1",
      personalRevision: 2,
      threadId: "thread-1",
      sessionId: String(session.sessionId),
    }),
    /exact persisted authority/u,
  );
  assert.equal(fixture.proxies[0]?.adoptions, 0);
  assert.equal(fixture.proxies[0]?.closed, true);
});

test("scope-wide personal revision adoption closes every Session after one proxy fails", async () => {
  let authority = operatorAuthority("revision-1", ["example.com"]);
  let personalRevision = 1;
  const fixture = await createFixture({
    authorityResolver: {
      async resolve() {
        return authority;
      },
      async resolveForPersonalRevision() {
        return { authority, personalRevision };
      },
    },
  });
  await fixture.service.execute(
    prepared("browser.open", {
      mode: "operator",
      target: { kind: "public_url", url: "https://example.com/" },
    }),
    createLifecycle({ threadId: "thread-1" }),
  );
  await fixture.service.execute(
    prepared("browser.open", {
      mode: "operator",
      target: { kind: "public_url", url: "https://example.com/" },
    }),
    createLifecycle({ threadId: "thread-2" }),
  );
  authority = operatorAuthority("revision-2", []);
  personalRevision = 2;
  fixture.proxies[1]!.failNextAdoption = true;

  await assert.rejects(
    fixture.service.adoptPersonalRevision({
      accountId: "user-1",
      environmentId: "environment-1",
      personalRevision: 2,
    }),
    /proxy adoption failed/u,
  );
  assert.deepEqual(
    fixture.proxies.map((proxy) => proxy.closed),
    [true, true],
  );
  assert.equal(fixture.engine.closed.length, 2);
});

test("an account identity change loses the Session instead of rebinding its profile", async () => {
  let authority = operatorAuthority("revision-1", ["example.com"]);
  const fixture = await createFixture({
    authorityResolver: {
      async resolve() {
        return authority;
      },
    },
  });
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: { kind: "public_url", url: "https://example.com/" },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);
  authority = {
    ...operatorAuthority("revision-2", ["example.com"]),
    userId: "user-2",
  };

  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", {
        sessionId: session.sessionId,
        generation: session.generation,
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_SESSION_LOST"),
  );
  assert.equal(fixture.proxies[0]?.closed, true);
  assert.equal(fixture.engine.closed.length, 1);
});

test("opening startup failure is terminal and cleans partially prepared runtime state", async () => {
  const fixture = await createFixture();
  const runtimePath = path.join(
    fixture.homePath,
    "browser",
    "runtime",
    "browser-00000001",
  );
  await mkdir(runtimePath, { recursive: true });
  await writeFile(path.join(runtimePath, "profile"), "blocks profile mkdir");
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      lifecycle,
    ),
  );
  assert.deepEqual(lifecycle.events, []);
  assert.equal(fixture.proxies[0]?.closed, true);
  await assert.rejects(stat(runtimePath), { code: "ENOENT" });
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  assert.equal(ledger.sessions[0]?.state, "failed");
  assert.equal(ledger.sessions[0]?.terminalReason, "BROWSER_ENGINE_FAILURE");
  await fixture.service.close();
});

test("engine launch failure before a PID binding terminalizes and removes opening state", async () => {
  const engine = new FakeEngine();
  engine.failNextOpen = new Error("launch failed before pid binding");
  const fixture = await createFixture({ engine });
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      lifecycle,
    ),
    /launch failed before pid binding/u,
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(engine.closed.length, 1);
  const invocation = engine.opened[0]!;
  await assert.rejects(stat(invocation.runtimePath), { code: "ENOENT" });
  await assert.rejects(stat(invocation.socketPath), { code: "ENOENT" });
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  assert.equal(ledger.sessions[0]?.state, "failed");
});

for (const sessionSuffix of [
  "123e4567-e89b-12d3-a456-426614174000",
  "a".repeat(64),
]) {
  test(`Desktop Browser derives a short private socket path for ${sessionSuffix.length}-character IDs and removes it on cleanup`, async () => {
    const fixture = await createFixture({ randomId: () => sessionSuffix });
    await openSession(fixture.service);
    const invocation = fixture.engine.opened[0]!;
    const socketFile = path.join(
      invocation.socketPath,
      `${invocation.sessionId}.sock`,
    );
    assert.equal(
      Buffer.byteLength(socketFile, "utf8") <= 103,
      true,
      socketFile,
    );
    assert.equal((await stat(invocation.socketPath)).mode & 0o777, 0o700);
    assert.equal(
      path.dirname(invocation.socketPath),
      `/tmp/b${(process.getuid?.() ?? 0).toString(36)}`,
    );
    assert.equal(
      Buffer.byteLength(
        path.join(
          `/tmp/b${(4294967295).toString(36)}`,
          path.basename(invocation.socketPath),
          `${invocation.sessionId}.sock`,
        ),
      ) <= 103,
      true,
    );
    await fixture.service.close();
    await assert.rejects(stat(invocation.socketPath), { code: "ENOENT" });
  });
}

test("approved active-turn upload revalidates exact metadata and target before owned staging and dispatch", async () => {
  const bytes = Buffer.from("approved attachment bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let uploadStreamsOpened = 0;
  const fixture = await createFixture({
    attachmentStore: {
      async importPath() {
        throw new Error("not used");
      },
      async list() {
        return [];
      },
      async resolve(threadId, attachmentIds) {
        assert.equal(threadId, "thread-1");
        assert.deepEqual(attachmentIds, ["file-1"]);
        return [
          {
            attachmentId: "file-1",
            threadId,
            filename: "evidence.txt",
            declaredMediaType: "text/plain",
            detectedMediaType: "text/plain",
            mimeType: "text/plain",
            sizeBytes: bytes.byteLength,
            sha256,
          },
        ];
      },
    },
    uploadStream: {
      async open(input) {
        uploadStreamsOpened += 1;
        assert.equal(input.maximumBytes, 100 * 1024 * 1024);
        return (async function* () {
          yield bytes;
        })();
      },
    },
  });
  const sessionId = await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  assert.equal(
    (await stat(invocation.blockedDownloadPath)).mode & 0o777,
    0o700,
  );
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  const effect = await fixture.service.prepareUpload({
    version: "browser_upload_preparation_v1",
    runId: "run-upload",
    threadId: "thread-1",
    turnId: "turn-1",
    effectiveInput: {
      sessionId,
      generation: 1,
      snapshotId: snapshot.snapshotId,
      targetRef: "@e1",
      attachmentId: "file-1",
    },
    attachment: {
      attachmentId: "file-1",
      filename: "evidence.txt",
      declaredMediaType: "text/plain",
      detectedMediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256,
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  });
  const upload = prepared("browser.upload", {
    sessionId,
    generation: 1,
    snapshotId: snapshot.snapshotId,
    targetRef: "@e1",
    attachmentId: "file-1",
  });
  upload.inputAdapters = [
    {
      adapterId: "kestrel.browser-upload-effect:v1",
      metadata: { ...effect },
    },
  ];
  const lifecycle = createLifecycle();
  assert.deepEqual(await fixture.service.execute(upload, lifecycle), {
    version: "browser_tool_result_v1",
    operation: "browser.upload",
    sessionId,
    generation: 1,
    outcome: "uploaded",
    attachmentId: "file-1",
    filename: "evidence.txt",
    bytes: bytes.byteLength,
    sha256,
    targetRef: "@e1",
  });
  assert.deepEqual(lifecycle.events, ["ack", "persist"]);
  assert.equal(uploadStreamsOpened, 1);
  assert.deepEqual(fixture.engine.uploadedFiles, [
    {
      targetRef: "@e1",
      bytes,
    },
  ]);
  assert.equal(
    (await readdir(invocation.runtimePath)).some((name) =>
      name.startsWith("upload-"),
    ),
    false,
  );
  await fixture.service.close();
});

test("changed attachment metadata rejects before upload bytes are opened", async () => {
  const bytes = Buffer.from("approved attachment bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let resolutions = 0;
  let streamsOpened = 0;
  const fixture = await createFixture({
    attachmentStore: {
      async importPath() {
        throw new Error("not used");
      },
      async list() {
        return [];
      },
      async resolve(threadId) {
        resolutions += 1;
        return [
          {
            attachmentId: "file-1",
            threadId,
            filename: "evidence.txt",
            declaredMediaType: "text/plain",
            detectedMediaType: "text/plain",
            mimeType: "text/plain",
            sizeBytes: bytes.byteLength,
            sha256: resolutions === 1 ? sha256 : "b".repeat(64),
          },
        ];
      },
    },
    uploadStream: {
      async open() {
        streamsOpened += 1;
        return Readable.from(bytes);
      },
    },
  });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  const effect = await fixture.service.prepareUpload({
    version: "browser_upload_preparation_v1",
    runId: "run-upload-stale",
    threadId: "thread-1",
    turnId: "turn-1",
    effectiveInput: {
      sessionId,
      generation: 1,
      snapshotId: snapshot.snapshotId,
      targetRef: "@e1",
      attachmentId: "file-1",
    },
    attachment: {
      attachmentId: "file-1",
      filename: "evidence.txt",
      declaredMediaType: "text/plain",
      detectedMediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256,
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  });
  const upload = prepared("browser.upload", {
    sessionId,
    generation: 1,
    snapshotId: snapshot.snapshotId,
    targetRef: "@e1",
    attachmentId: "file-1",
  });
  upload.inputAdapters = [
    {
      adapterId: "kestrel.browser-upload-effect:v1",
      metadata: { ...effect },
    },
  ];
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(upload, lifecycle),
    hasCode("BROWSER_SERVICE_UNAVAILABLE"),
  );
  assert.deepEqual(lifecycle.events, []);
  assert.equal(streamsOpened, 0);
  assert.deepEqual(fixture.engine.uploadedFiles, []);
  await fixture.service.close();
});

test("upload stream integrity failure preserves the failure and removes owned staging", async () => {
  const expected = Buffer.from("approved attachment bytes");
  const corrupted = Buffer.from("corrupted attachment byte");
  assert.equal(corrupted.byteLength, expected.byteLength);
  const sha256 = createHash("sha256").update(expected).digest("hex");
  const fixture = await createFixture({
    attachmentStore: {
      async importPath() {
        throw new Error("not used");
      },
      async list() {
        return [];
      },
      async resolve(threadId) {
        return [
          {
            attachmentId: "file-1",
            threadId,
            filename: "evidence.txt",
            declaredMediaType: "text/plain",
            detectedMediaType: "text/plain",
            mimeType: "text/plain",
            sizeBytes: expected.byteLength,
            sha256,
          },
        ];
      },
    },
    uploadStream: {
      async open() {
        return Readable.from(corrupted);
      },
    },
  });
  const sessionId = await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  const effect = await fixture.service.prepareUpload({
    version: "browser_upload_preparation_v1",
    runId: "run-upload-integrity",
    threadId: "thread-1",
    turnId: "turn-1",
    effectiveInput: {
      sessionId,
      generation: 1,
      snapshotId: snapshot.snapshotId,
      targetRef: "@e1",
      attachmentId: "file-1",
    },
    attachment: {
      attachmentId: "file-1",
      filename: "evidence.txt",
      declaredMediaType: "text/plain",
      detectedMediaType: "text/plain",
      sizeBytes: expected.byteLength,
      sha256,
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  });
  const upload = prepared("browser.upload", {
    sessionId,
    generation: 1,
    snapshotId: snapshot.snapshotId,
    targetRef: "@e1",
    attachmentId: "file-1",
  });
  upload.inputAdapters = [
    {
      adapterId: "kestrel.browser-upload-effect:v1",
      metadata: { ...effect },
    },
  ];
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(upload, lifecycle),
    hasCode("BROWSER_SERVICE_UNAVAILABLE"),
  );
  assert.deepEqual(lifecycle.events, []);
  assert.deepEqual(fixture.engine.uploadedFiles, []);
  assert.equal(
    (await readdir(invocation.runtimePath)).some((name) =>
      name.startsWith("upload-"),
    ),
    false,
  );
  await fixture.service.close();
});

test("upload cancellation during staging stops before acknowledgement and removes owned staging", async () => {
  const bytes = Buffer.from("approved attachment bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const controller = new AbortController();
  const fixture = await createFixture({
    attachmentStore: {
      async importPath() {
        throw new Error("not used");
      },
      async list() {
        return [];
      },
      async resolve(threadId) {
        return [
          {
            attachmentId: "file-1",
            threadId,
            filename: "evidence.txt",
            declaredMediaType: "text/plain",
            detectedMediaType: "text/plain",
            mimeType: "text/plain",
            sizeBytes: bytes.byteLength,
            sha256,
          },
        ];
      },
    },
    uploadStream: {
      async open() {
        return (async function* () {
          yield bytes.subarray(0, 4);
          controller.abort(new Error("cancelled"));
          yield bytes.subarray(4);
        })();
      },
    },
  });
  const sessionId = await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  const effect = await fixture.service.prepareUpload({
    version: "browser_upload_preparation_v1",
    runId: "run-upload-cancelled",
    threadId: "thread-1",
    turnId: "turn-1",
    effectiveInput: {
      sessionId,
      generation: 1,
      snapshotId: snapshot.snapshotId,
      targetRef: "@e1",
      attachmentId: "file-1",
    },
    attachment: {
      attachmentId: "file-1",
      filename: "evidence.txt",
      declaredMediaType: "text/plain",
      detectedMediaType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256,
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  });
  const upload = prepared("browser.upload", {
    sessionId,
    generation: 1,
    snapshotId: snapshot.snapshotId,
    targetRef: "@e1",
    attachmentId: "file-1",
  });
  upload.inputAdapters = [
    {
      adapterId: "kestrel.browser-upload-effect:v1",
      metadata: { ...effect },
    },
  ];
  const lifecycle = createLifecycle({ signal: controller.signal });
  await assert.rejects(
    fixture.service.execute(upload, lifecycle),
    /cancelled/u,
  );
  assert.deepEqual(lifecycle.events, []);
  assert.deepEqual(fixture.engine.uploadedFiles, []);
  assert.equal(
    (await readdir(invocation.runtimePath)).some((name) =>
      name.startsWith("upload-"),
    ),
    false,
  );
  await fixture.service.close();
});

test("download remains unavailable before engine dispatch", async () => {
  const fixture = await createFixture();
  const sessionId = await openSession(fixture.service);
  await assert.rejects(
    fixture.service.prepareDownload({
      version: BROWSER_DOWNLOAD_PREPARATION_VERSION,
      runId: "run-1",
      threadId: "thread-1",
      effectiveInput: {
        sessionId,
        generation: 1,
        pendingDownloadId: "download-1",
      },
      authority: { threadId: "thread-1", projectId: "project-1" },
    }),
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
  await fixture.service.close();
});

test("an intercepted page download returns a redacted pending descriptor from private quarantine", async () => {
  const engine = new FakeEngine();
  const metrics: DesktopBrowserMetric[] = [];
  engine.downloadOnCommand = "click";
  const fixture = await createFixture({ engine, metrics });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  const lifecycle = createLifecycle();
  const output = asRecord(
    await fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      lifecycle,
    ),
  );
  assert.deepEqual(lifecycle.events, ["ack", "persist"]);
  assert.deepEqual(asRecord(output.pendingDownload), {
    downloadId: "download-intercepted",
    filename: "blocked.bin",
    measuredBytes: 29,
    declaredMediaType: "application/octet-stream",
    normalizedSourceOrigin: "https://example.com",
    sha256: createHash("sha256")
      .update("download:download-intercepted")
      .digest("hex"),
    createdAt: asRecord(output.pendingDownload).createdAt,
    expiresAt: asRecord(output.pendingDownload).expiresAt,
  });
  assert.equal("ownedPath" in asRecord(output.pendingDownload), false);
  assert.equal(
    (await stat(engine.opened[0]!.blockedDownloadPath)).mode & 0o777,
    0o700,
  );
  assert.equal(
    metrics.some((metric) => metric.name === "browser_unknown_outcome"),
    false,
  );
  await fixture.service.close();
});

test("download events queued behind a command are returned after the protocol barrier", async () => {
  const engine = new FakeEngine();
  engine.downloadOnBarrierCommand = "click";
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  const lifecycle = createLifecycle();
  const output = asRecord(
    await fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      lifecycle,
    ),
  );
  assert.deepEqual(lifecycle.events, ["ack", "persist"]);
  assert.equal(
    asRecord(output.pendingDownload).downloadId,
    "download-intercepted",
  );
  await fixture.service.close();
});

test("a completed intercepted download wins over an engine response error from the same command", async () => {
  const engine = new FakeEngine();
  engine.downloadOnCommand = "click";
  engine.failAfterDownloadCommand = "click";
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  const output = asRecord(
    await fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      createLifecycle(),
    ),
  );
  assert.equal(
    asRecord(output.pendingDownload).downloadId,
    "download-intercepted",
  );
  await fixture.service.close();
});

test("a download observed after command return remains preparable without terminalizing the session", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  await fixture.service.execute(
    prepared("browser.snapshot", { sessionId }),
    createLifecycle(),
  );

  await engine.emitDownload();

  const discovered = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
  );
  assert.ok(Array.isArray(discovered.pendingDownloads));
  assert.equal(
    asRecord(discovered.pendingDownloads[0]).downloadId,
    "late-download",
  );
  assert.equal("ownedPath" in asRecord(discovered.pendingDownloads[0]), false);

  const effect = await fixture.service.prepareDownload({
    version: BROWSER_DOWNLOAD_PREPARATION_VERSION,
    runId: "run-1",
    threadId: "thread-1",
    effectiveInput: {
      sessionId,
      generation: 1,
      pendingDownloadId: "late-download",
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  });
  assert.equal(effect.pendingDownloadId, "late-download");
  await fixture.service.execute(
    prepared("browser.snapshot", { sessionId }),
    createLifecycle(),
  );
  assert.equal(engine.closed.length, 0);
  await fixture.service.close();
});

test("releasing a denied prepared download removes only its exact quarantine authority", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  await engine.emitDownload();
  const effect = await fixture.service.prepareDownload({
    version: BROWSER_DOWNLOAD_PREPARATION_VERSION,
    runId: "run-denied-download",
    threadId: "thread-1",
    effectiveInput: {
      sessionId,
      generation: 1,
      pendingDownloadId: "late-download",
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  });
  const call = prepared("browser.download", {
    sessionId,
    generation: 1,
    pendingDownloadId: "late-download",
  });
  call.inputAdapters = [
    {
      adapterId: "kestrel.browser-download-effect:v1",
      metadata: { ...effect },
    },
  ];
  await fixture.service.releasePreparedDownload(call);
  await fixture.service.releasePreparedDownload(call, {
    threadId: "thread-1",
    projectId: "project-1",
  });
  await assert.rejects(
    fixture.service.prepareDownload({
      version: BROWSER_DOWNLOAD_PREPARATION_VERSION,
      runId: "run-denied-download",
      threadId: "thread-1",
      effectiveInput: {
        sessionId,
        generation: 1,
        pendingDownloadId: "late-download",
      },
      authority: { threadId: "thread-1", projectId: "project-1" },
    }),
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
  await fixture.service.close();
});

test("approved Desktop download promotion publishes one deterministic file before bounded cleanup", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  await engine.emitDownload();
  const effect = await fixture.service.prepareDownload({
    version: BROWSER_DOWNLOAD_PREPARATION_VERSION,
    runId: "run-download",
    threadId: "thread-1",
    effectiveInput: {
      sessionId,
      generation: 1,
      pendingDownloadId: "late-download",
    },
    authority: { threadId: "thread-1", projectId: "project-1" },
  });
  const call = prepared("browser.download", {
    sessionId,
    generation: 1,
    pendingDownloadId: "late-download",
  });
  call.inputAdapters = [
    {
      adapterId: "kestrel.browser-download-effect:v1",
      metadata: { ...effect },
    },
  ];
  let durableOutput: unknown;
  const lifecycle = createLifecycle();
  lifecycle.persistCompletedResult = async (output) => {
    lifecycle.events.push("persist");
    durableOutput = structuredClone(output);
    const ownedPath = path.join(
      engine.opened[0]!.blockedDownloadPath,
      "123e4567-e89b-42d3-a456-426614174000",
    );
    await rm(ownedPath, { force: true });
    await mkdir(ownedPath);
  };
  const output = asRecord(await fixture.service.execute(call, lifecycle));
  assert.deepEqual(output, durableOutput);
  assert.deepEqual(lifecycle.events, ["ack", "persist"]);
  const artifact = asRecord(output.artifact);
  assert.match(String(artifact.id), /^file-browser-[0-9a-f]{64}$/u);
  assert.equal(artifact.kind, "browser-download");
  assert.equal("version" in artifact, false);
  const attachments = await new (
    await import("../../src/localCore/desktopAttachments.js")
  ).DesktopAttachmentStore(fixture.homePath).list("thread-1");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.fileId, artifact.id);
  assert.deepEqual(
    await fixture.service.authorizeArtifact({
      version: "browser_artifact_authorization_v1",
      runId: call.runId,
      threadId: "thread-1",
      callId: call.callId,
      toolName: "browser.download",
      sessionId,
      artifactId: String(artifact.id),
      artifactKind: "browser-download",
    }),
    {
      version: "browser_authorized_artifact_v1",
      ...artifact,
    },
  );
  await fixture.service.close();
});

test("Session teardown removes unpromoted quarantine bytes", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const invocation = engine.opened[0]!;
  await engine.emitDownload();
  await stat(
    path.join(
      invocation.blockedDownloadPath,
      "123e4567-e89b-42d3-a456-426614174000",
    ),
  );
  await fixture.service.close();
  await assert.rejects(stat(invocation.runtimePath), { code: "ENOENT" });
  await assert.rejects(stat(invocation.socketPath), { code: "ENOENT" });
});

test("initial navigation download returns stable unavailable before open success", async () => {
  const engine = new FakeEngine();
  engine.downloadOnOpen = true;
  const fixture = await createFixture({ engine });
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      lifecycle,
    ),
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(engine.closed.length, 1);
});

test("oversized screenshots fail before attachment import", async () => {
  let imports = 0;
  const engine = new FakeEngine();
  const metrics: DesktopBrowserMetric[] = [];
  engine.screenshotBytes = 100 * 1024 * 1024 + 1;
  const fixture = await createFixture({
    engine,
    metrics,
    attachmentStore: {
      async importPath() {
        imports += 1;
        return {
          fileId: "file-oversized",
          mimeType: "image/png",
          sizeBytes: 1,
          sha256: "0".repeat(64),
        };
      },
      async list() {
        return [];
      },
    },
  });
  const sessionId = await openSession(fixture.service);
  const lifecycle = createLifecycle();
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.capture", { sessionId, fullPage: false }),
      lifecycle,
    ),
    hasCode("BROWSER_ARTIFACT_TOO_LARGE"),
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(imports, 0);
  assert.equal(
    metrics.some((metric) => metric.name === "browser_unknown_outcome"),
    false,
  );
  await fixture.service.close();
});

test("screenshot returns and reloads the durable Desktop attachment identity", async () => {
  const fixture = await createFixture();
  const sessionId = await openSession(fixture.service);
  const captureCall = prepared("browser.capture", {
    sessionId,
    fullPage: false,
  });
  const output = asRecord(
    await fixture.service.execute(captureCall, createLifecycle()),
  );
  const artifact = asRecord(output.artifact);
  assert.match(String(artifact.id), /^file-/u);
  assert.equal("version" in artifact, false);
  assert.equal(artifact.mediaType, "image/png");
  assert.equal(Number(artifact.bytes) > 0, true);
  assert.match(String(artifact.sha256), /^[0-9a-f]{64}$/u);
  assert.equal(output.boundary, "untrusted_browser_content");
  const request = {
    version: "browser_artifact_authorization_v1" as const,
    runId: captureCall.runId,
    threadId: "thread-1",
    callId: captureCall.callId,
    toolName: "browser.capture" as const,
    sessionId,
    artifactId: String(artifact.id),
    artifactKind: "browser-screenshot" as const,
  };
  assert.equal(
    await fixture.service.authorizeArtifact({
      ...request,
      runId: "foreign-run",
      callId: "foreign-call",
    }),
    undefined,
  );
  assert.deepEqual(await fixture.service.authorizeArtifact(request), {
    version: "browser_authorized_artifact_v1",
    ...artifact,
  });
  await fixture.service.close();

  const restarted = await createFixture({ homePath: fixture.homePath });
  assert.equal(
    await restarted.service.authorizeArtifact({
      ...request,
      callId: "replayed-by-another-call",
    }),
    undefined,
  );
  assert.deepEqual(await restarted.service.authorizeArtifact(request), {
    version: "browser_authorized_artifact_v1",
    ...artifact,
  });
  await restarted.service.close();
});

test("Browser capture uses the adapter CDP frame path when the engine provides it", async () => {
  let requestedFullPage: boolean | undefined;
  const engine = Object.assign(new FakeEngine(), {
    async captureScreenshot(
      input: Parameters<
        NonNullable<DesktopBrowserEngineAdapter["captureScreenshot"]>
      >[0],
    ) {
      requestedFullPage = input.fullPage;
      return {
        mediaType: "image/png" as const,
        dataBase64: engine.viewerFrameBase64,
      };
    },
  });
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);

  const output = asRecord(
    await fixture.service.execute(
      prepared("browser.capture", { sessionId, fullPage: true }),
      createLifecycle(),
    ),
  );

  assert.equal(requestedFullPage, true);
  assert.equal(
    engine.commands.some((command) => command[0] === "screenshot"),
    false,
  );
  assert.equal(asRecord(output.artifact).mediaType, "image/png");
  await fixture.service.close();
});

test("pinned agent-browser download control denies downloads through Browser CDP before dispatch", async () => {
  const calls: Array<{
    url: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];
  await denyAgentBrowserDownloads(
    "ws://127.0.0.1:9222/devtools/browser/pinned-v0.35.0",
    async (url, method, params) => {
      calls.push({ url, method, params });
    },
  );
  assert.deepEqual(calls, [
    {
      url: "ws://127.0.0.1:9222/devtools/browser/pinned-v0.35.0",
      method: "Browser.setDownloadBehavior",
      params: { behavior: "deny", eventsEnabled: true },
    },
  ]);
  await assert.rejects(
    denyAgentBrowserDownloads(
      "ws://public.example/devtools/browser/forged",
      async () => undefined,
    ),
    /non-local Browser CDP URL/u,
  );
});

test(
  "download synchronization drains asynchronously delivered denial events before its protocol acknowledgement",
  { timeout: 5_000 },
  async (t) => {
    const quarantinePath = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-download-interception-"),
    );
    t.after(() => rm(quarantinePath, { recursive: true, force: true }));
    const guid = "123e4567-e89b-42d3-a456-426614174001";
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      assert.fail("download interception fixture did not bind TCP");
    }
    const downloads: DesktopBrowserInterceptedDownload[] = [];
    server.on("connection", (socket) => {
      let commands = 0;
      socket.on("message", (raw) => {
        const command = JSON.parse(raw.toString("utf8")) as { id: number };
        commands += 1;
        if (commands === 1) {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "Browser.downloadWillBegin",
              params: {
                guid,
                suggestedFilename: "async.bin",
                url: "https://example.com/private?token=not-recorded",
              },
            }),
          );
          setImmediate(async () => {
            await writeFile(path.join(quarantinePath, guid), "download");
            socket.send(
              JSON.stringify({
                method: "Browser.downloadProgress",
                params: { guid, state: "completed", receivedBytes: 8 },
              }),
            );
            socket.send(JSON.stringify({ id: command.id, result: {} }));
          });
        });
      });
    });

    const interception = await installAgentBrowserDownloadInterception(
      `ws://127.0.0.1:${address.port}/devtools/browser/test`,
      quarantinePath,
      (download) => {
        downloads.push(download);
      },
      undefined,
      () => new Date("2026-08-31T12:29:00.000Z"),
    );
    t.after(() => interception.stop());
    await interception.synchronize();
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0]?.createdAt, "2026-08-31T12:29:00.000Z");
    assert.equal(downloads[0]?.expiresAt, "2026-08-31T12:59:00.000Z");
  },
);

test(
  "download admission and measured-size rejection remove only the exact quarantine file",
  { timeout: 5_000 },
  async (t) => {
    const quarantinePath = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-download-rejection-"),
    );
    t.after(() => rm(quarantinePath, { recursive: true, force: true }));
    const admissionGuid = "123e4567-e89b-42d3-a456-426614174011";
    const oversizedGuid = "123e4567-e89b-42d3-a456-426614174012";
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      assert.fail("download rejection fixture did not bind TCP");
    let barriers = 0;
    let cancellationObserved = false;
    server.on("connection", (socket) => {
      socket.on("message", async (raw) => {
        const command = JSON.parse(raw.toString("utf8")) as {
          id: number;
          method: string;
        };
        if (command.method === "Browser.cancelDownload") {
          cancellationObserved = true;
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        if (command.method !== "Browser.setDownloadBehavior") return;
        barriers += 1;
        if (barriers === 1) {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        const guid = barriers === 2 ? admissionGuid : oversizedGuid;
        await writeFile(path.join(quarantinePath, guid), "download");
        socket.send(
          JSON.stringify({
            method: "Browser.downloadWillBegin",
            params: {
              guid,
              suggestedFilename: "unsafe.bin",
              url: "https://example.com/private?secret=1",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "Browser.downloadProgress",
            params: {
              guid,
              state: "completed",
              receivedBytes: barriers === 2 ? 8 : 100 * 1024 * 1024 + 1,
            },
          }),
        );
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      });
    });

    const interception = await installAgentBrowserDownloadInterception(
      `ws://127.0.0.1:${address.port}/devtools/browser/test`,
      quarantinePath,
      async () => {
        throw new Error("BROWSER_ARTIFACT_TOO_LARGE: admission rejected");
      },
    );
    t.after(() => interception.stop());
    await assert.rejects(interception.synchronize(), /admission rejected/u);
    await assert.rejects(stat(path.join(quarantinePath, admissionGuid)), {
      code: "ENOENT",
    });
    await assert.rejects(
      interception.synchronize(),
      /exceeded the quarantine file limit/u,
    );
    await assert.rejects(stat(path.join(quarantinePath, oversizedGuid)), {
      code: "ENOENT",
    });
    assert.equal(cancellationObserved, true);
  },
);

test(
  "download quarantine bounds measured in-progress bytes and item reservations",
  { timeout: 5_000 },
  async (t) => {
    const quarantinePath = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-download-progress-bounds-"),
    );
    t.after(() => rm(quarantinePath, { recursive: true, force: true }));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      assert.fail("download bounds fixture did not bind TCP");
    let barriers = 0;
    let cancellations = 0;
    let cancellationsObserved!: () => void;
    const cancellationsObservedPromise = new Promise<void>((resolve) => {
      cancellationsObserved = resolve;
    });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const command = JSON.parse(raw.toString("utf8")) as {
          id: number;
          method: string;
        };
        if (command.method === "Browser.cancelDownload") {
          cancellations += 1;
          if (cancellations === 16) cancellationsObserved();
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        if (command.method !== "Browser.setDownloadBehavior") return;
        barriers += 1;
        if (barriers === 1) {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        const guids = Array.from(
          { length: 21 },
          (_, index) =>
            `123e4567-e89b-42d3-a456-${String(index + 1).padStart(12, "0")}`,
        );
        for (const guid of guids) {
          socket.send(
            JSON.stringify({
              method: "Browser.downloadWillBegin",
              params: {
                guid,
                suggestedFilename: `${guid}.bin`,
                url: "https://example.com/file",
              },
            }),
          );
        }
        for (const guid of guids) {
          socket.send(
            JSON.stringify({
              method: "Browser.downloadProgress",
              params: {
                guid,
                state: "inProgress",
                receivedBytes: 90 * 1024 * 1024,
              },
            }),
          );
        }
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      });
    });
    const interception = await installAgentBrowserDownloadInterception(
      `ws://127.0.0.1:${address.port}/devtools/browser/test`,
      quarantinePath,
      () => undefined,
    );
    t.after(() => interception.stop());
    await assert.rejects(interception.synchronize(), /quarantine/u);
    await cancellationsObservedPromise;
    assert.equal(cancellations, 16);
  },
);

test(
  "completed downloads remain reserved until measured admission settles",
  { timeout: 5_000 },
  async (t) => {
    const quarantinePath = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-download-completion-reservation-"),
    );
    t.after(() => rm(quarantinePath, { recursive: true, force: true }));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      assert.fail("download completion fixture did not bind TCP");
    const completingGuid = "123e4567-e89b-42d3-a456-426614174201";
    const interleavedGuid = "123e4567-e89b-42d3-a456-426614174202";
    let connectedSocket: import("ws").WebSocket | undefined;
    let releaseAdmission!: () => void;
    const admissionBarrier = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let admissionStarted!: () => void;
    const admissionStartedPromise = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    let cancellations = 0;
    let cancellationObserved!: () => void;
    const cancellationObservedPromise = new Promise<void>((resolve) => {
      cancellationObserved = resolve;
    });
    let barriers = 0;
    server.on("connection", (socket) => {
      connectedSocket = socket;
      socket.on("message", async (raw) => {
        const command = JSON.parse(raw.toString("utf8")) as {
          id: number;
          method: string;
        };
        if (command.method === "Browser.cancelDownload") {
          cancellations += 1;
          cancellationObserved();
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        if (command.method !== "Browser.setDownloadBehavior") return;
        barriers += 1;
        if (barriers === 1) {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        if (barriers > 2) {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        await writeFile(path.join(quarantinePath, completingGuid), "download");
        socket.send(
          JSON.stringify({
            method: "Browser.downloadWillBegin",
            params: {
              guid: completingGuid,
              suggestedFilename: "settling.bin",
              url: "https://example.com/file",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "Browser.downloadProgress",
            params: {
              guid: completingGuid,
              state: "completed",
              receivedBytes: 8,
            },
          }),
        );
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      });
    });
    const interception = await installAgentBrowserDownloadInterception(
      `ws://127.0.0.1:${address.port}/devtools/browser/test`,
      quarantinePath,
      async () => {
        admissionStarted();
        await admissionBarrier;
      },
      () => ({ count: 19, measuredBytes: 0 }),
    );
    t.after(() => interception.stop());
    const synchronized = interception.synchronize();
    await admissionStartedPromise;
    connectedSocket?.send(
      JSON.stringify({
        method: "Browser.downloadWillBegin",
        params: {
          guid: interleavedGuid,
          suggestedFilename: "interleaved.bin",
          url: "https://example.com/file",
        },
      }),
    );
    await cancellationObservedPromise;
    const interleavedSynchronization = interception.synchronize();
    releaseAdmission();
    const itemResults = await Promise.allSettled([
      synchronized,
      interleavedSynchronization,
    ]);
    const itemFailure = itemResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.match(String(itemFailure?.reason), /item limit was reached/u);
    assert.equal(cancellations, 1);
  },
);

test(
  "interleaved progress observes completed-byte admission before accepting more bytes",
  { timeout: 5_000 },
  async (t) => {
    const quarantinePath = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-download-completion-bytes-"),
    );
    t.after(() => rm(quarantinePath, { recursive: true, force: true }));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      assert.fail("download byte fixture did not bind TCP");
    const completingGuid = "123e4567-e89b-42d3-a456-426614174211";
    const interleavedGuid = "123e4567-e89b-42d3-a456-426614174212";
    let completedBytes = 410 * 1024 * 1024;
    let releaseAdmission!: () => void;
    const admissionBarrier = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let admissionStarted!: () => void;
    const admissionStartedPromise = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    let connectedSocket: import("ws").WebSocket | undefined;
    let cancellations = 0;
    let barriers = 0;
    server.on("connection", (socket) => {
      connectedSocket = socket;
      socket.on("message", async (raw) => {
        const command = JSON.parse(raw.toString("utf8")) as {
          id: number;
          method: string;
        };
        if (command.method === "Browser.cancelDownload") {
          cancellations += 1;
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        if (command.method !== "Browser.setDownloadBehavior") return;
        barriers += 1;
        if (barriers === 1) {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        if (barriers > 2) {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          return;
        }
        await writeFile(path.join(quarantinePath, completingGuid), "download");
        socket.send(
          JSON.stringify({
            method: "Browser.downloadWillBegin",
            params: {
              guid: completingGuid,
              suggestedFilename: "settling.bin",
              url: "https://example.com/file",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "Browser.downloadProgress",
            params: {
              guid: completingGuid,
              state: "completed",
              receivedBytes: 90 * 1024 * 1024,
            },
          }),
        );
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      });
    });
    const interception = await installAgentBrowserDownloadInterception(
      `ws://127.0.0.1:${address.port}/devtools/browser/test`,
      quarantinePath,
      async () => {
        admissionStarted();
        await admissionBarrier;
        completedBytes = 500 * 1024 * 1024;
      },
      () => ({ count: 0, measuredBytes: completedBytes }),
    );
    t.after(() => interception.stop());
    const synchronized = interception.synchronize();
    await admissionStartedPromise;
    connectedSocket?.send(
      JSON.stringify({
        method: "Browser.downloadWillBegin",
        params: {
          guid: interleavedGuid,
          suggestedFilename: "interleaved.bin",
          url: "https://example.com/file",
        },
      }),
    );
    connectedSocket?.send(
      JSON.stringify({
        method: "Browser.downloadProgress",
        params: {
          guid: interleavedGuid,
          state: "inProgress",
          receivedBytes: 1,
        },
      }),
    );
    const interleavedSynchronization = interception.synchronize();
    releaseAdmission();
    const byteResults = await Promise.allSettled([
      synchronized,
      interleavedSynchronization,
    ]);
    const byteFailure = byteResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.match(String(byteFailure?.reason), /quarantine file limit/u);
    assert.equal(cancellations, 1);
  },
);

test("daemon cleanup accepts only the exact exited agent-browser zombie identity", () => {
  assert.equal(
    desktopBrowserZombieCommandMatches(
      "[agent-browser] <defunct>",
      "/bundle/agent-browser",
    ),
    true,
  );
  assert.equal(
    desktopBrowserZombieCommandMatches(
      "[different-process] <defunct>",
      "/bundle/agent-browser",
    ),
    false,
  );
});

test("daemon ownership requires exact executable identity and contained real sidecar artifacts", async (t) => {
  assert.equal(
    desktopBrowserDaemonCommandMatches(
      "/bundle/agent-browser",
      "/bundle/agent-browser",
    ),
    true,
  );
  assert.equal(
    desktopBrowserDaemonCommandMatches(
      "/bundle/agent-browser-forged",
      "/bundle/agent-browser",
    ),
    false,
  );
  const root = await mkdtemp("/tmp/kb-owner-");
  const socketPath = path.join(root, "private");
  const sessionId = "browser-owned";
  const controlSocketPath = path.join(socketPath, `${sessionId}.sock`);
  const pidPath = path.join(socketPath, `${sessionId}.pid`);
  const outsidePath = path.join(root, "outside");
  await mkdir(socketPath, { mode: 0o700 });
  await writeFile(pidPath, "123\n", { mode: 0o600 });
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(controlSocketPath, resolve),
  );
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await assertDesktopBrowserOwnedDaemonArtifacts({ sessionId, socketPath });

  await writeFile(outsidePath, "forged\n", { mode: 0o600 });
  await unlink(pidPath);
  await symlink(outsidePath, pidPath);
  await assert.rejects(
    assertDesktopBrowserOwnedDaemonArtifacts({ sessionId, socketPath }),
    /PID sidecar is invalid/u,
  );
  await unlink(pidPath);
  await writeFile(pidPath, "123\n", { mode: 0o600 });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unlink(controlSocketPath).catch(() => undefined);
  await symlink(outsidePath, controlSocketPath);
  await assert.rejects(
    assertDesktopBrowserOwnedDaemonArtifacts({ sessionId, socketPath }),
    /control socket is invalid/u,
  );
});

test("daemon loss proactively records a terminal Session and cleans owned state", async () => {
  const metrics: DesktopBrowserMetric[] = [];
  const fixture = await createFixture({ metrics });
  const sessionId = await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  fixture.engine.triggerLoss();
  await waitFor(async () => {
    const ledger = JSON.parse(
      await readFile(
        path.join(fixture.homePath, "browser", "sessions.json"),
        "utf8",
      ),
    ) as { sessions: BrowserSessionV1[] };
    return ledger.sessions[0]?.state === "lost";
  });
  const ledger = JSON.parse(
    await readFile(
      path.join(fixture.homePath, "browser", "sessions.json"),
      "utf8",
    ),
  ) as { sessions: BrowserSessionV1[] };
  assert.equal(ledger.sessions[0]?.sessionId, sessionId);
  assert.equal(ledger.sessions[0]?.terminalReason, "BROWSER_SESSION_LOST");
  assert.equal(fixture.proxies[0]?.closed, true);
  assert.equal(fixture.engine.closed.length, 1);
  await assert.rejects(stat(invocation.runtimePath), { code: "ENOENT" });
  await assert.rejects(stat(invocation.socketPath), { code: "ENOENT" });
  assert.equal(
    metrics.some((metric) => metric.name === "browser_engine_crash"),
    true,
  );
  assert.equal(
    metrics.some((metric) => metric.name === "browser_cleanup"),
    true,
  );
  await fixture.service.close();
});

test("Browser metrics cover safety outcomes and contain metadata only", async () => {
  const metrics: DesktopBrowserMetric[] = [];
  let authority = operatorAuthority("revision-1", ["example.com"]);
  const fixture = await createFixture({
    metrics,
    authorityResolver: {
      async resolve() {
        return authority;
      },
      async resolveForPersonalRevision() {
        return { authority, personalRevision: 2 };
      },
    },
  });
  const opened = asRecord(
    await fixture.service.execute(
      prepared("browser.open", {
        mode: "operator",
        target: {
          kind: "public_url",
          url: "https://example.com/private?token=query-secret",
        },
      }),
      createLifecycle(),
    ),
  );
  const session = asRecord(opened.session);
  authority = operatorAuthority("revision-2", ["example.com"]);
  await fixture.service.adoptPersonalRevision({
    accountId: "user-1",
    environmentId: "environment-1",
    personalRevision: 2,
    threadId: "thread-1",
    sessionId: String(session.sessionId),
  });
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.navigate", {
        sessionId: session.sessionId,
        generation: session.generation,
        kind: "url",
        url: "https://openai.com/private?token=blocked-secret",
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DESTINATION_BLOCKED"),
  );
  const snapshot = asRecord(
    await fixture.service.execute(
      prepared("browser.snapshot", {
        sessionId: session.sessionId,
        generation: session.generation,
      }),
      createLifecycle(),
    ),
  );
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.interact", {
        sessionId: session.sessionId,
        generation: session.generation,
        snapshotId: snapshot.snapshotId,
        documentRevision: "forged-private-page-revision",
        tabId: "t1",
        action: { kind: "fill", ref: "@e1", text: "fill-secret" },
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_TARGET_STALE"),
  );
  await fixture.service.execute(
    prepared("browser.capture", {
      sessionId: session.sessionId,
      generation: session.generation,
      fullPage: false,
    }),
    createLifecycle(),
  );
  const unknownBeforeReadOnlyFailure = metrics.filter(
    (metric) => metric.name === "browser_unknown_outcome",
  ).length;
  fixture.engine.failNextCommand = new Error(
    "private page body must not enter metrics",
  );
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", {
        sessionId: session.sessionId,
        generation: session.generation,
      }),
      createLifecycle(),
    ),
    /private page body/u,
  );
  assert.equal(
    metrics.filter((metric) => metric.name === "browser_unknown_outcome")
      .length,
    unknownBeforeReadOnlyFailure,
  );
  fixture.engine.failNextCommand = new Error(
    "private screenshot failure must not enter metrics",
  );
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.capture", {
        sessionId: session.sessionId,
        generation: session.generation,
        fullPage: false,
      }),
      createLifecycle(),
    ),
    /private screenshot failure/u,
  );
  await fixture.service.close();

  const names = new Set(metrics.map((metric) => metric.name));
  for (const expected of [
    "browser_startup",
    "browser_revision_adoption",
    "browser_destination_blocked",
    "browser_target_stale",
    "browser_unknown_outcome",
    "browser_screenshot",
    "browser_cleanup",
  ])
    assert.equal(
      names.has(expected as DesktopBrowserMetric["name"]),
      true,
      expected,
    );
  for (const metric of metrics) {
    assert.deepEqual(
      Object.keys(metric).every((key) =>
        [
          "version",
          "name",
          "at",
          "mode",
          "operation",
          "outcome",
          "reason",
          "durationMs",
          "count",
        ].includes(key),
      ),
      true,
    );
  }
  const serialized = JSON.stringify(metrics);
  assert.doesNotMatch(
    serialized,
    /example\.com|query-secret|blocked-secret|fill-secret|private page body/u,
  );
});

test("expired Session emits expiry and cleanup metrics", async () => {
  const metrics: DesktopBrowserMetric[] = [];
  let now = new Date("2026-08-29T12:00:00.000Z");
  const fixture = await createFixture({ metrics, now: () => now });
  const sessionId = await openSession(fixture.service);
  now = new Date("2026-08-29T20:00:00.001Z");
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId, generation: 1 }),
      createLifecycle(),
    ),
    hasCode("BROWSER_SESSION_EXPIRED"),
  );
  assert.equal(
    metrics.some((metric) => metric.name === "browser_session_expired"),
    true,
  );
  assert.equal(
    metrics.some((metric) => metric.name === "browser_cleanup"),
    true,
  );
  await fixture.service.close();
});

test("hosted/default agent-browser launch stays headless while packaged Desktop is headed and initially minimized", () => {
  const invocation = engineInvocation();
  const built = buildAgentBrowserCliInvocation({
    input: invocation,
    chromeExecutablePath: "/bundle/Chrome",
    command: ["open", PREVIEW_URL],
  });
  assert.equal(built.args.includes("/bundle/Chrome"), true);
  assert.equal(built.args.includes(invocation.profilePath), true);
  assert.equal(built.args.includes(invocation.proxy.proxyServer), true);
  assert.equal(built.args.includes("--namespace"), false);
  assert.equal(built.args.includes("--pin-tab"), true);
  assert.equal(built.args.includes("--headed"), false);
  assert.doesNotMatch(
    String(built.args[built.args.indexOf("--args") + 1]),
    /--start-minimized/u,
  );
  assert.doesNotMatch(JSON.stringify(built.args), /proxy-user|proxy-secret/u);
  assert.equal(built.env.AGENT_BROWSER_PROXY_USERNAME, "proxy-user");
  assert.equal(built.env.AGENT_BROWSER_PROXY_PASSWORD, "proxy-secret");
  assert.equal(built.env.AGENT_BROWSER_SOCKET_DIR, invocation.socketPath);
  assert.equal(built.env.TMPDIR, invocation.socketPath);
  assert.equal(
    Buffer.byteLength(
      path.join(
        `/tmp/b${(4294967295).toString(36)}`,
        "ASNFZ4mrze8",
        "org.chromium.Chromium.123456",
        "SingletonSocket",
      ),
    ) <= 107,
    true,
  );
  assert.equal(built.env.HOME, "/runtime/config");
  assert.equal(built.env.PATH, "");
  assert.equal(built.args.includes("install"), false);
  assert.equal(built.args.includes("upgrade"), false);
  assert.equal(built.args.includes("eval"), false);
  assert.equal(built.args.includes("--download-path"), false);

  const desktop = buildAgentBrowserCliInvocation({
    input: { ...invocation, nativeAuthenticationHandoff: true },
    chromeExecutablePath: "/bundle/Chrome",
    command: ["open", PREVIEW_URL],
  });
  assert.equal(desktop.args.includes("--headed"), true);
  assert.match(
    String(desktop.args[desktop.args.indexOf("--args") + 1]),
    /--start-minimized/u,
  );
});

test("native handoff presents and revokes only the exact private CDP window with verified state", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const pageCalls: Array<{ targetId: string; method: string }> = [];
  let state: "normal" | "minimized" = "minimized";
  const send = async (
    _cdpUrl: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "Browser.getWindowForTarget") return { windowId: 17 };
    if (method === "Browser.setWindowBounds") {
      state = asRecord(params.bounds).windowState as "normal" | "minimized";
      return {};
    }
    if (method === "Browser.getWindowBounds") {
      return { bounds: { windowState: state } };
    }
    throw new Error(`unexpected ${method}`);
  };
  const cdp = "ws://127.0.0.1:9222/devtools/browser/exact";
  const concealed = await minimizeAgentBrowserNativeWindow(
    cdp,
    "target-1",
    send,
  );
  assert.deepEqual(concealed, { windowId: 17, targetId: "target-1" });
  assert.equal(state, "minimized");
  const presented = await presentAgentBrowserNativeWindow(
    cdp,
    "target-1",
    send,
    async (_cdpUrl, targetId, method) => {
      pageCalls.push({ targetId, method });
    },
  );
  assert.deepEqual(presented, concealed);
  assert.equal(state, "normal");
  assert.deepEqual(pageCalls, [
    { targetId: "target-1", method: "Page.bringToFront" },
  ]);
  await revokeAgentBrowserNativeWindow(cdp, presented, send);
  assert.equal(state, "minimized");
  assert.deepEqual(calls[0], {
    method: "Browser.getWindowForTarget",
    params: { targetId: "target-1" },
  });
  assert.equal(
    calls.every(
      (call) =>
        call.method === "Browser.getWindowForTarget" ||
        call.method === "Browser.getWindowBounds" ||
        call.method === "Browser.setWindowBounds",
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(calls),
    /cdpUrl|proxy-secret|passkey|mfa/u,
  );
});

test("native handoff revocation minimizes and verifies both stored and moved target windows", async () => {
  const states = new Map<number, "normal" | "minimized">([
    [17, "minimized"],
    [23, "normal"],
  ]);
  let targetWindowId = 17;
  const calls: Array<{ method: string; windowId?: number | undefined }> = [];
  const send = async (
    _cdpUrl: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const windowId =
      typeof params.windowId === "number" ? params.windowId : undefined;
    calls.push({ method, ...(windowId === undefined ? {} : { windowId }) });
    if (method === "Browser.getWindowForTarget") {
      return { windowId: targetWindowId };
    }
    if (method === "Browser.setWindowBounds" && windowId !== undefined) {
      const windowState = asRecord(params.bounds).windowState;
      if (windowState !== "normal" && windowState !== "minimized") {
        throw new Error("unexpected window state");
      }
      states.set(windowId, windowState);
      return {};
    }
    if (method === "Browser.getWindowBounds" && windowId !== undefined) {
      return { bounds: { windowState: states.get(windowId) } };
    }
    throw new Error(`unexpected ${method}`);
  };
  const cdp = "ws://127.0.0.1:9222/devtools/browser/exact";
  const presentation = await presentAgentBrowserNativeWindow(
    cdp,
    "target-1",
    send,
    async () => undefined,
  );
  targetWindowId = 23;

  await revokeAgentBrowserNativeWindow(cdp, presentation, send);

  assert.equal(states.get(17), "minimized");
  assert.equal(states.get(23), "minimized");
  assert.deepEqual(
    calls
      .filter((call) => call.method === "Browser.getWindowBounds")
      .map((call) => call.windowId),
    [17, 17, 23],
  );
  assert.doesNotMatch(
    JSON.stringify(calls),
    /proxy-secret|password-sentinel|passkey-sentinel|mfa-sentinel/u,
  );
});

test("native handoff revocation rejects target lookup, minimization, and verification failures", async (t) => {
  const presentation = { windowId: 17, targetId: "target-1" };
  const cdp = "ws://127.0.0.1:9222/devtools/browser/exact";
  for (const failure of ["lookup", "minimize", "verify"] as const) {
    await t.test(failure, async () => {
      await assert.rejects(
        revokeAgentBrowserNativeWindow(
          cdp,
          presentation,
          async (_cdpUrl, method) => {
            if (
              failure === "lookup" &&
              method === "Browser.getWindowForTarget"
            ) {
              throw new Error("target missing");
            }
            if (method === "Browser.getWindowForTarget") {
              return { windowId: 23 };
            }
            if (
              failure === "minimize" &&
              method === "Browser.setWindowBounds"
            ) {
              throw new Error("window closed");
            }
            if (method === "Browser.getWindowBounds") {
              return {
                bounds: {
                  windowState: failure === "verify" ? "normal" : "minimized",
                },
              };
            }
            return {};
          },
        ),
      );
    });
  }
});

test("native handoff presentation rolls the exact window back to minimized on failed verification", async () => {
  const states: string[] = [];
  await assert.rejects(
    presentAgentBrowserNativeWindow(
      "ws://127.0.0.1:9222/devtools/browser/exact",
      "target-1",
      async (_cdpUrl, method, params) => {
        if (method === "Browser.getWindowForTarget") return { windowId: 9 };
        if (method === "Browser.setWindowBounds") {
          states.push(String(asRecord(params.bounds).windowState));
          return {};
        }
        return { bounds: { windowState: "minimized" } };
      },
      async () => undefined,
    ),
    /presentation was not proven/u,
  );
  assert.deepEqual(states, ["normal", "minimized"]);
});

test("native handoff focus failure conceals the exact target window before rejecting", async () => {
  let state: "normal" | "minimized" = "minimized";
  await assert.rejects(
    presentAgentBrowserNativeWindow(
      "ws://127.0.0.1:9222/devtools/browser/exact",
      "target-1",
      async (_cdpUrl, method, params) => {
        if (method === "Browser.getWindowForTarget") return { windowId: 9 };
        if (method === "Browser.setWindowBounds") {
          const next = asRecord(params.bounds).windowState;
          if (next !== "normal" && next !== "minimized") {
            throw new Error("unexpected window state");
          }
          state = next;
          return {};
        }
        return { bounds: { windowState: state } };
      },
      async () => {
        throw new Error("target focus failed");
      },
    ),
    /target focus failed/u,
  );
  assert.equal(state, "minimized");
});

test("native frame capture normalizes once without focusing and remains capturable", async () => {
  let state: "normal" | "minimized" = "minimized";
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const send = async (
    _cdpUrl: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "Browser.getWindowForTarget") {
      return { windowId: 17, bounds: { windowState: state } };
    }
    if (method === "Browser.setWindowBounds") {
      state = asRecord(params.bounds).windowState as "normal" | "minimized";
      return {};
    }
    if (method === "Browser.getWindowBounds") {
      return { bounds: { windowState: state } };
    }
    throw new Error(`unexpected ${method}`);
  };

  const presentation = await prepareAgentBrowserNativeCaptureWindow(
    "ws://127.0.0.1:9222/devtools/browser/exact",
    "target-1",
    send,
  );
  assert.deepEqual(presentation, { windowId: 17, targetId: "target-1" });
  assert.equal(state, "normal");
  assert.equal(
    calls.some((call) => call.method === "Page.bringToFront"),
    false,
  );
  const setBoundsCalls = calls.filter(
    (call) => call.method === "Browser.setWindowBounds",
  ).length;
  const repeated = await prepareAgentBrowserNativeCaptureWindow(
    "ws://127.0.0.1:9222/devtools/browser/exact",
    "target-1",
    send,
  );
  assert.deepEqual(repeated, presentation);
  assert.equal(
    calls.filter((call) => call.method === "Browser.setWindowBounds").length,
    setBoundsCalls,
  );
  await revokeAgentBrowserNativeWindow(
    "ws://127.0.0.1:9222/devtools/browser/exact",
    presentation,
    send,
  );
  assert.equal(state, "minimized");
});

test("pinned agent-browser metadata resolves the active CDP target rather than the CLI tab alias", () => {
  const stdout = JSON.stringify({
    _boundary: {
      nonce: "0123456789abcdef0123456789abcdef",
      origin: "unknown",
    },
    data: {
      lifecycle: {
        effectiveLaunch: {
          browserLaunched: true,
          engine: "chrome",
          launchHash: 123,
        },
        launched: false,
        relaunchedBrowser: false,
        restartedBackground: false,
        restoreStatus: "not_configured",
        reused: true,
        saveStatus: "not_attempted",
      },
      tabs: [
        {
          tabId: "t1",
          targetId: "CDP_TARGET_EXACT",
          label: null,
          title: "about:blank",
          url: "about:blank",
          type: "page",
          active: true,
        },
      ],
    },
    error: null,
    success: true,
  });

  assert.equal(requirePinnedViewerActiveTarget(stdout), "CDP_TARGET_EXACT");
});

test("agent-browser adapter requires the exact accepted operation token before invocation", async () => {
  const adapter = new AgentBrowserCliAdapter({
    engineExecutablePath: "/bin/echo",
    chromeExecutablePath: "/usr/bin/true",
  });
  const invocation = engineInvocation();
  const accepted = await adapter.acceptOperation({
    ...invocation,
    operationId: "call-exact",
    grantGeneration: invocation.proxy.generation,
  });
  adapter.releaseOperation(accepted);
  await assert.rejects(
    adapter.command({
      ...invocation,
      acceptedOperation: accepted,
      command: ["snapshot"],
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
  await assert.rejects(
    adapter.open({
      ...invocation,
      destination: PREVIEW_URL,
      acceptedOperation: { ...accepted, acceptanceToken: "forged" },
    }),
    hasCode("BROWSER_SESSION_LOST"),
  );
});

test("agent-browser adapter uploads only an exact Browser-owned staged file through the pinned CLI", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-browser-upload-cli-"),
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, "agent-browser-upload-fixture");
  const argumentsPath = path.join(root, "arguments.txt");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsPath}'\n`,
  );
  await chmod(executable, 0o755);
  const invocation = {
    ...engineInvocation(),
    runtimePath: path.join(root, "runtime"),
    profilePath: path.join(root, "runtime", "profile"),
    configPath: path.join(root, "runtime", "config"),
    screenshotPath: path.join(root, "runtime", "screenshot.png"),
    blockedDownloadPath: path.join(root, "runtime", "downloads-disabled"),
  };
  await mkdir(invocation.runtimePath, { recursive: true, mode: 0o700 });
  const stagedPath = path.join(invocation.runtimePath, "upload-exact.bin");
  await writeFile(stagedPath, "approved attachment", { mode: 0o600 });
  const adapter = new AgentBrowserCliAdapter({
    engineExecutablePath: executable,
    chromeExecutablePath: "/usr/bin/true",
  });
  const accepted = await adapter.acceptOperation({
    ...invocation,
    operationId: "call-upload-exact",
    grantGeneration: invocation.proxy.generation,
  });
  await adapter.uploadFile({
    ...invocation,
    targetRef: "@e1",
    ownedPath: stagedPath,
    acceptedOperation: accepted,
  });
  const args = (await readFile(argumentsPath, "utf8")).trim().split("\n");
  assert.deepEqual(args.slice(-3), ["upload", "@e1", stagedPath]);
  adapter.releaseOperation(accepted);
});

test("agent-browser file-input label parsing never falls back to wrapper JSON or origin", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-browser-upload-label-"),
  );
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "agent-browser-label-fixture");
  await writeFile(
    executable,
    `#!/bin/sh
case "$*" in
  *"get local-name @e1"*) printf '%s\\n' '{"success":true,"data":{"localName":"input","type":"file"},"error":null}' ;;
  *"get attr @e1 aria-label"*) printf '%s\\n' '{"success":true,"data":{"value":null,"origin":"https://secret.example/token"},"error":null}' ;;
  *) exit 2 ;;
esac
`,
  );
  await chmod(executable, 0o755);
  const invocation = {
    ...engineInvocation(),
    runtimePath: path.join(root, "runtime"),
    profilePath: path.join(root, "runtime", "profile"),
    configPath: path.join(root, "runtime", "config"),
    screenshotPath: path.join(root, "runtime", "screenshot.png"),
    blockedDownloadPath: path.join(root, "runtime", "downloads-disabled"),
  };
  await mkdir(invocation.runtimePath, { recursive: true, mode: 0o700 });
  const adapter = new AgentBrowserCliAdapter({
    engineExecutablePath: executable,
    chromeExecutablePath: "/usr/bin/true",
  });
  const accepted = await adapter.acceptOperation({
    ...invocation,
    operationId: "call-upload-label",
    grantGeneration: invocation.proxy.generation,
  });
  assert.deepEqual(
    await adapter.describeFileInput({
      ...invocation,
      targetRef: "@e1",
      acceptedOperation: accepted,
    }),
    {
      targetRef: "@e1",
      targetLabel: "File input",
    },
  );
  adapter.releaseOperation(accepted);
});

test("agent-browser file-input description rejects a non-input ref even when it reports type=file", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-browser-upload-tag-"),
  );
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "agent-browser-tag-fixture");
  await writeFile(
    executable,
    `#!/bin/sh
case "$*" in
  *"get local-name @e1"*) printf '%s\\n' '{"success":true,"data":{"localName":"button","type":"file"},"error":null}' ;;
  *) exit 2 ;;
esac
`,
  );
  await chmod(executable, 0o755);
  const invocation = {
    ...engineInvocation(),
    runtimePath: path.join(root, "runtime"),
    profilePath: path.join(root, "runtime", "profile"),
    configPath: path.join(root, "runtime", "config"),
    screenshotPath: path.join(root, "runtime", "screenshot.png"),
    blockedDownloadPath: path.join(root, "runtime", "downloads-disabled"),
  };
  await mkdir(invocation.runtimePath, { recursive: true, mode: 0o700 });
  const adapter = new AgentBrowserCliAdapter({
    engineExecutablePath: executable,
    chromeExecutablePath: "/usr/bin/true",
  });
  const accepted = await adapter.acceptOperation({
    ...invocation,
    operationId: "call-upload-tag",
    grantGeneration: invocation.proxy.generation,
  });
  await assert.rejects(
    adapter.describeFileInput({
      ...invocation,
      targetRef: "@e1",
      acceptedOperation: accepted,
    }),
    /target is not input\[type=file\]/u,
  );
  adapter.releaseOperation(accepted);
});

test("agent-browser file-input description rejects failed and noncanonical local-name envelopes", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-browser-tag-envelope-"),
  );
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const responses = [
    '{"success":false,"data":{"localName":"input","type":"file"},"error":"forged"}',
    '{"success":true,"data":{},"localName":"input","error":null}',
    '{"success":true,"data":{"localName":"input"},"type":"file","error":null}',
  ];
  for (const [index, response] of responses.entries()) {
    const executable = path.join(
      root,
      `agent-browser-envelope-fixture-${index}`,
    );
    await writeFile(
      executable,
      `#!/bin/sh
case "$*" in
  *"get local-name @e1"*) printf '%s\\n' '${response}' ;;
  *) exit 2 ;;
esac
`,
    );
    await chmod(executable, 0o755);
    const invocation = {
      ...engineInvocation(),
      runtimePath: path.join(root, `runtime-${index}`),
      profilePath: path.join(root, `runtime-${index}`, "profile"),
      configPath: path.join(root, `runtime-${index}`, "config"),
      screenshotPath: path.join(root, `runtime-${index}`, "screenshot.png"),
      blockedDownloadPath: path.join(
        root,
        `runtime-${index}`,
        "downloads-disabled",
      ),
    };
    await mkdir(invocation.runtimePath, { recursive: true, mode: 0o700 });
    const adapter = new AgentBrowserCliAdapter({
      engineExecutablePath: executable,
      chromeExecutablePath: "/usr/bin/true",
    });
    const accepted = await adapter.acceptOperation({
      ...invocation,
      operationId: `call-upload-envelope-${index}`,
      grantGeneration: invocation.proxy.generation,
    });
    await assert.rejects(
      adapter.describeFileInput({
        ...invocation,
        targetRef: "@e1",
        acceptedOperation: accepted,
      }),
      /BROWSER_ENGINE_FAILURE/u,
    );
    adapter.releaseOperation(accepted);
  }
});

test("agent-browser cleanup treats a missing pre-PID socket as already clean", async () => {
  const adapter = new AgentBrowserCliAdapter({
    engineExecutablePath: "/bin/echo",
    chromeExecutablePath: "/usr/bin/true",
  });
  const invocation = engineInvocation();
  await rm(invocation.socketPath, { recursive: true, force: true });
  await adapter.close(invocation);
  await adapter.close(invocation);
});

test("agent-browser cleanup accepts only ps-confirmed process absence as termination proof", async () => {
  const adapter = new AgentBrowserCliAdapter({
    engineExecutablePath: "/bin/echo",
    chromeExecutablePath: "/usr/bin/true",
  });
  const invocation = {
    ...engineInvocation(),
    daemonPid: 99_998,
  };
  await adapter.close(invocation);
  await adapter.close(invocation);

  await assert.rejects(
    adapter.close({ ...engineInvocation(), daemonPid: 2_147_483_647 }),
    /process inspection was unavailable/u,
  );
});

test("launcher process-group cleanup alone cannot prove pre-PID daemon termination", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-launch-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, "agent-browser-launch-fixture");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "/bin/sleep 30 </dev/null >/dev/null 2>&1 &",
      'printf \'%s\\n\' "$!" > "$PWD/launched-child.pid"',
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
  const runtimePath = path.join(root, "runtime");
  const socketPath = path.join(root, "socket");
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(socketPath, { recursive: true }),
    mkdir(path.join(runtimePath, "profile"), { recursive: true }),
    mkdir(path.join(runtimePath, "config"), { recursive: true }),
  ]);
  await chmod(socketPath, 0o700);
  const invocation: DesktopBrowserEngineInvocation = {
    ...engineInvocation(),
    sessionId: "launch-without-pid",
    runtimePath,
    socketPath,
    profilePath: path.join(runtimePath, "profile"),
    configPath: path.join(runtimePath, "config"),
    screenshotPath: path.join(runtimePath, "screenshot.png"),
    blockedDownloadPath: path.join(runtimePath, "downloads-disabled"),
    proxy: {
      ...engineInvocation().proxy,
      sessionId: "launch-without-pid",
    },
  };
  const adapter = new AgentBrowserCliAdapter({
    engineExecutablePath: executable,
    chromeExecutablePath: "/usr/bin/true",
  });
  const accepted = await adapter.acceptOperation({
    ...invocation,
    operationId: "launch-operation",
    grantGeneration: invocation.proxy.generation,
  });
  const openInvocation = {
    ...invocation,
    destination: PREVIEW_URL,
    acceptedOperation: accepted,
  };
  await assert.rejects(adapter.open(openInvocation), /pid_binding failed/u);
  assert.equal(typeof openInvocation.launchProcessGroupId, "number");
  const launchedPid = Number(
    (
      await readFile(path.join(runtimePath, "launched-child.pid"), "utf8")
    ).trim(),
  );
  process.kill(launchedPid, 0);

  await assert.rejects(
    adapter.close(openInvocation),
    /termination could not be proven by PID or the owned session socket/u,
  );
  await waitFor(async () => {
    try {
      process.kill(launchedPid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  });
  adapter.releaseOperation(accepted);
});

test("real adapter shuts down a setsid daemon and child through the exact owned session socket before PID publication", async (t) => {
  const root = await mkdtemp("/tmp/kb-setsid-");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, "agent-browser-setsid-fixture.cjs");
  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      'const path = require("node:path");',
      'const sessionIndex = process.argv.indexOf("--session");',
      "const session = process.argv[sessionIndex + 1];",
      "const socketDirectory = process.env.AGENT_BROWSER_SOCKET_DIR;",
      "const socketPath = path.join(socketDirectory, `${session}.sock`);",
      'if (process.env.KESTREL_TEST_SETSID_DAEMON === "1") {',
      "  fs.mkdirSync(socketDirectory, { recursive: true });",
      '  const browserChild = spawn("/bin/sleep", ["30"], { stdio: "ignore" });',
      '  fs.writeFileSync(path.join(process.cwd(), "setsid-daemon.pid"), String(process.pid));',
      '  fs.writeFileSync(path.join(process.cwd(), "setsid-child.pid"), String(browserChild.pid));',
      "  let serverClosed = false;",
      "  let childClosed = false;",
      "  const finish = () => { if (serverClosed && childClosed) { fs.rmSync(socketPath, { force: true }); process.exit(0); } };",
      '  browserChild.once("exit", () => { childClosed = true; finish(); });',
      "  const server = net.createServer((socket) => {",
      '    let request = "";',
      '    socket.on("data", (chunk) => {',
      '      request += chunk.toString("utf8");',
      '      const newline = request.indexOf("\\n");',
      "      if (newline < 0) return;",
      "      const message = JSON.parse(request.slice(0, newline));",
      '      if (message.action !== "__agent_browser_internal_shutdown") return;',
      "      socket.end(`${JSON.stringify({ success: true, data: { closed: true } })}\\n`);",
      "      setTimeout(() => {",
      "        socket.destroy();",
      "        server.close(() => { serverClosed = true; finish(); });",
      '        browserChild.kill("SIGTERM");',
      '        setTimeout(() => browserChild.kill("SIGKILL"), 500).unref();',
      "      }, 25).unref();",
      "    });",
      "  });",
      "  server.listen(socketPath);",
      "} else {",
      "  const daemon = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {",
      "    detached: true,",
      '    stdio: "ignore",',
      '    env: { ...process.env, KESTREL_TEST_SETSID_DAEMON: "1" },',
      "  });",
      "  daemon.unref();",
      "  for (let attempt = 0; attempt < 200 && !fs.existsSync(socketPath); attempt += 1) {",
      "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
      "  }",
      "  process.exit(fs.existsSync(socketPath) ? 0 : 2);",
      "}",
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
  const runtimePath = path.join(root, "runtime");
  const socketPath = path.join(root, "socket");
  await Promise.all([
    mkdir(runtimePath, { recursive: true }),
    mkdir(socketPath, { recursive: true }),
    mkdir(path.join(runtimePath, "profile"), { recursive: true }),
    mkdir(path.join(runtimePath, "config"), { recursive: true }),
  ]);
  await chmod(socketPath, 0o700);
  const invocation: DesktopBrowserEngineInvocation = {
    ...engineInvocation(),
    sessionId: "setsid-without-pid",
    runtimePath,
    socketPath,
    profilePath: path.join(runtimePath, "profile"),
    configPath: path.join(runtimePath, "config"),
    screenshotPath: path.join(runtimePath, "screenshot.png"),
    blockedDownloadPath: path.join(runtimePath, "downloads-disabled"),
    proxy: {
      ...engineInvocation().proxy,
      sessionId: "setsid-without-pid",
    },
  };
  const adapter = new AgentBrowserCliAdapter({
    engineExecutablePath: executable,
    chromeExecutablePath: "/usr/bin/true",
  });
  const accepted = await adapter.acceptOperation({
    ...invocation,
    operationId: "setsid-launch-operation",
    grantGeneration: invocation.proxy.generation,
  });
  const openInvocation = {
    ...invocation,
    destination: PREVIEW_URL,
    acceptedOperation: accepted,
  };
  await assert.rejects(adapter.open(openInvocation), /pid_binding failed/u);
  const daemonPid = Number(
    await readFile(path.join(runtimePath, "setsid-daemon.pid"), "utf8"),
  );
  const childPid = Number(
    await readFile(path.join(runtimePath, "setsid-child.pid"), "utf8"),
  );
  process.kill(daemonPid, 0);
  process.kill(childPid, 0);

  await adapter.close(openInvocation);

  for (const pid of [daemonPid, childPid]) {
    await waitFor(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
  }
  await assert.rejects(
    stat(path.join(socketPath, `${invocation.sessionId}.sock`)),
    { code: "ENOENT" },
  );
  adapter.releaseOperation(accepted);
});

test("engine command collection waits for stdio close after process exit", async () => {
  const result = await spawnAndCollect({
    executable: "/bin/sh",
    args: ["-c", "(sleep 0.05; printf late-output) & exit 0"],
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    timeoutMs: 2_000,
  });
  assert.equal(result.stdout, "late-output");
});

test("viewer screenshot capture uses the pinned CDP Session without files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-viewer-cdp-"));
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const targetA = "TARGET_A";
  const targetB = "TARGET_B";
  type ScenarioMode =
    | "exact"
    | "raw_plus_one"
    | "oversized_message"
    | "malformed"
    | "mismatched_id"
    | "wrong_session"
    | "unrelated_event"
    | "attach_target_mismatch"
    | "attach_session_mismatch"
    | "duplicate_attach_event"
    | "duplicate_attach_response"
    | "detach_target_mismatch"
    | "detach_session_mismatch"
    | "duplicate_detach_event"
    | "close"
    | "timeout";
  const startCdpServer = async (
    name: string,
    mode: ScenarioMode,
    dataBase64?: string,
  ) => {
    const requests: Record<string, unknown>[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    let resolveClientClosed!: () => void;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    server.on("connection", (socket) => {
      socket.once("close", resolveClientClosed);
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString("utf8")) as Record<
          string,
          unknown
        >;
        requests.push(request);
        if (request.id === 1) {
          if (mode === "timeout") return;
          if (mode === "malformed") {
            socket.send("{");
            return;
          }
          if (mode === "mismatched_id") {
            socket.send(JSON.stringify({ id: 9, result: {} }));
            return;
          }
          if (mode === "unrelated_event") {
            socket.send(
              JSON.stringify({
                method: "Target.targetInfoChanged",
                params: {},
              }),
            );
            return;
          }
          const eventSessionId =
            mode === "attach_session_mismatch"
              ? "EVENT_SESSION"
              : "CDP_SESSION";
          const attachedEvent = {
            method: "Target.attachedToTarget",
            params: {
              sessionId: eventSessionId,
              targetInfo: {
                targetId: mode === "attach_target_mismatch" ? targetB : targetA,
                type: "page",
                title: "Example",
                url: "https://example.com/",
                attached: true,
              },
              waitingForDebugger: false,
            },
          };
          socket.send(JSON.stringify(attachedEvent));
          if (mode === "duplicate_attach_event") {
            socket.send(JSON.stringify(attachedEvent));
          }
          const attached = {
            id: 1,
            result: { sessionId: "CDP_SESSION" },
          };
          socket.send(JSON.stringify(attached));
          if (mode === "duplicate_attach_response") {
            socket.send(JSON.stringify(attached));
          }
          return;
        }
        if (request.method === "Page.getLayoutMetrics") {
          socket.send(
            JSON.stringify({
              id: request.id,
              sessionId: "CDP_SESSION",
              result: {
                cssContentSize: { x: 0, y: 0, width: 1200, height: 2400 },
              },
            }),
          );
          return;
        }
        if (request.method === "Page.captureScreenshot") {
          if (mode === "oversized_message") {
            socket.send(
              "x".repeat(HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES + 1),
            );
            return;
          }
          if (mode === "close") {
            socket.close();
            return;
          }
          socket.send(
            JSON.stringify({
              id: request.id,
              sessionId:
                mode === "wrong_session" ? "OTHER_SESSION" : "CDP_SESSION",
              result: { data: dataBase64 },
            }),
          );
          return;
        }
        if (request.method === "Target.detachFromTarget") {
          const detachedEvent = {
            method: "Target.detachedFromTarget",
            params: {
              sessionId:
                mode === "detach_session_mismatch"
                  ? "OTHER_SESSION"
                  : "CDP_SESSION",
              targetId: mode === "detach_target_mismatch" ? targetB : targetA,
            },
          };
          socket.send(JSON.stringify(detachedEvent));
          if (mode === "duplicate_detach_event") {
            socket.send(JSON.stringify(detachedEvent));
          }
          socket.send(JSON.stringify({ id: request.id, result: {} }));
        }
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("CDP test server did not bind a TCP port.");
    }
    return {
      url: `ws://127.0.0.1:${String(address.port)}/devtools/browser/${name}`,
      requests,
      clientClosed,
      close: async () => {
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };
  const writePinnedCli = async (
    name: string,
    cdpUrl: string,
    afterTargetId: string,
  ) => {
    const executable = path.join(root, `${name}-agent-browser`);
    const statePath = path.join(root, `${name}-tab-state`);
    const commandLog = path.join(root, `${name}-commands.log`);
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        `const statePath = ${JSON.stringify(statePath)};`,
        `const commandLog = ${JSON.stringify(commandLog)};`,
        "const args = process.argv.slice(2);",
        'if (args.includes("screenshot")) process.exit(9);',
        'if (args.includes("tab") && args.includes("list")) {',
        '  const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;',
        "  fs.writeFileSync(statePath, String(count + 1));",
        '  fs.appendFileSync(commandLog, "tab\\n");',
        `  const targetId = count === 0 ? ${JSON.stringify(targetA)} : ${JSON.stringify(afterTargetId)};`,
        '  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ tabId: "t1", targetId, label: null, title: "Example", url: "https://example.com/", type: "page", active: true }] }, error: null }));',
        '} else if (args.includes("get") && args.includes("cdp-url")) {',
        '  fs.appendFileSync(commandLog, "cdp\\n");',
        `  process.stdout.write(JSON.stringify({ success: true, data: { cdpUrl: ${JSON.stringify(cdpUrl)} }, error: null }));`,
        "} else { process.exit(10); }",
      ].join("\n"),
    );
    await chmod(executable, 0o755);
    return { executable, commandLog };
  };
  const runScenario = async (input: {
    name: string;
    mode: ScenarioMode;
    dataBase64?: string | undefined;
    afterTargetId?: string | undefined;
    fullPage?: boolean | undefined;
  }) => {
    const server = await startCdpServer(
      input.name,
      input.mode,
      input.dataBase64,
    );
    const runtimePath = path.join(root, `${input.name}-runtime`);
    await mkdir(runtimePath, { mode: 0o700 });
    const cli = await writePinnedCli(
      input.name,
      server.url,
      input.afterTargetId ?? targetA,
    );
    const adapter = new AgentBrowserCliAdapter({
      engineExecutablePath: cli.executable,
      chromeExecutablePath: "/usr/bin/true",
    });
    let frame: { mediaType: "image/png"; dataBase64: string } | undefined;
    let failure: unknown;
    const invocation = {
      ...engineInvocation(),
      runtimePath,
      socketPath: runtimePath,
      profilePath: runtimePath,
      configPath: runtimePath,
      screenshotPath: path.join(runtimePath, "screenshot.png"),
    };
    let accepted:
      | Awaited<ReturnType<typeof adapter.acceptOperation>>
      | undefined;
    try {
      if (input.fullPage === true) {
        accepted = await adapter.acceptOperation({
          ...invocation,
          operationId: `${input.name}-capture`,
          grantGeneration: invocation.proxy.generation,
        });
        frame = await adapter.captureScreenshot({
          ...invocation,
          fullPage: true,
          acceptedOperation: accepted,
        });
      } else {
        frame = await adapter.captureViewerFrame(invocation);
      }
    } catch (error) {
      failure = error;
    } finally {
      if (accepted !== undefined) adapter.releaseOperation(accepted);
    }
    await settleWithin(server.clientClosed, 1000);
    await server.close();
    return {
      frame,
      failure,
      requests: server.requests,
      commands: (await readFile(cli.commandLog, "utf8")).trim().split("\n"),
    };
  };

  try {
    const exactBytes = Buffer.alloc(HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES);
    pngHeader.copy(exactBytes);
    const exactBase64 = exactBytes.toString("base64");
    const exact = await runScenario({
      name: "exact",
      mode: "exact",
      dataBase64: exactBase64,
    });
    assert.equal(
      exact.failure,
      undefined,
      JSON.stringify({ requests: exact.requests, commands: exact.commands }),
    );
    assert.equal(exact.frame?.dataBase64, exactBase64);
    assert.deepEqual(exact.commands, ["tab", "cdp", "tab"]);
    assert.deepEqual(
      exact.requests.map((request) => request.method),
      [
        "Target.attachToTarget",
        "Page.captureScreenshot",
        "Target.detachFromTarget",
      ],
    );
    assert.deepEqual(exact.requests[0], {
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: targetA, flatten: true },
    });
    assert.deepEqual(exact.requests[1], {
      id: 2,
      sessionId: "CDP_SESSION",
      method: "Page.captureScreenshot",
      params: { format: "png", fromSurface: true },
    });

    const fullPageBytes = Buffer.alloc(24);
    pngHeader.copy(fullPageBytes);
    fullPageBytes.writeUInt32BE(1200, 16);
    fullPageBytes.writeUInt32BE(2400, 20);
    const fullPage = await runScenario({
      name: "full-page",
      mode: "exact",
      dataBase64: fullPageBytes.toString("base64"),
      fullPage: true,
    });
    assert.equal(fullPage.failure, undefined);
    assert.equal(
      Buffer.from(fullPage.frame!.dataBase64, "base64").readUInt32BE(16),
      1200,
    );
    assert.equal(
      Buffer.from(fullPage.frame!.dataBase64, "base64").readUInt32BE(20),
      2400,
    );
    assert.deepEqual(
      fullPage.requests.map((request) => request.method),
      [
        "Target.attachToTarget",
        "Page.getLayoutMetrics",
        "Page.captureScreenshot",
        "Target.detachFromTarget",
      ],
    );
    assert.deepEqual(fullPage.requests[2], {
      id: 3,
      sessionId: "CDP_SESSION",
      method: "Page.captureScreenshot",
      params: {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1200, height: 2400, scale: 1 },
      },
    });

    const plusOneBytes = Buffer.alloc(
      HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES + 1,
    );
    pngHeader.copy(plusOneBytes);
    const plusOne = await runScenario({
      name: "plus-one",
      mode: "raw_plus_one",
      dataBase64: plusOneBytes.toString("base64"),
    });
    assert.match(String(plusOne.failure), /Browser viewer capture failed/u);
    assert.equal(plusOne.frame, undefined);
    assert.equal(plusOne.requests.at(-1)?.method, "Target.detachFromTarget");

    for (const mode of [
      "oversized_message",
      "malformed",
      "mismatched_id",
      "wrong_session",
      "unrelated_event",
      "attach_target_mismatch",
      "attach_session_mismatch",
      "duplicate_attach_event",
      "duplicate_attach_response",
      "detach_target_mismatch",
      "detach_session_mismatch",
      "duplicate_detach_event",
      "close",
    ] as const) {
      const result = await runScenario({
        name: mode.replaceAll("_", "-"),
        mode,
        dataBase64: exactBase64,
      });
      assert.match(String(result.failure), /Browser viewer capture failed/u);
      assert.equal(result.frame, undefined);
      if (
        mode === "wrong_session" ||
        mode === "duplicate_attach_response" ||
        mode.startsWith("detach_") ||
        mode === "duplicate_detach_event"
      ) {
        assert.equal(result.requests.at(-1)?.method, "Target.detachFromTarget");
      }
    }

    const drift = await runScenario({
      name: "target-drift",
      mode: "exact",
      dataBase64: exactBase64,
      afterTargetId: targetB,
    });
    assert.match(String(drift.failure), /target changed during capture/u);
    assert.deepEqual(drift.commands, ["tab", "cdp", "tab"]);

    const timeout = await runScenario({
      name: "timeout",
      mode: "timeout",
    });
    assert.match(String(timeout.failure), /capture was not acknowledged/u);
    assert.equal(timeout.frame, undefined);

    const genericExecutable = path.join(root, "generic-large-output");
    await writeFile(
      genericExecutable,
      [
        `#!${process.execPath}`,
        'process.stdout.write("x".repeat(2 * 1024 * 1024));',
      ].join("\n"),
    );
    await chmod(genericExecutable, 0o755);
    const generic = await spawnAndCollect({
      executable: genericExecutable,
      args: [],
      cwd: root,
      env: { PATH: "", LANG: "C.UTF-8" },
      timeoutMs: 2000,
    });
    assert.equal(Buffer.byteLength(generic.stdout, "utf8"), 512 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "viewer screenshot capture matches a real Chrome CDP lifecycle when enabled",
  { timeout: 20_000 },
  async (t) => {
    const chromiumPath = process.env.KESTREL_BROWSER_CDP_PROBE_EXECUTABLE;
    if (chromiumPath === undefined) {
      t.skip("set KESTREL_BROWSER_CDP_PROBE_EXECUTABLE for the real CDP probe");
      return;
    }
    const root = await mkdtemp(
      path.join(os.tmpdir(), "kestrel-viewer-chrome-"),
    );
    const profilePath = path.join(root, "profile");
    await mkdir(profilePath, { mode: 0o700 });
    const portServer = createServer();
    await new Promise<void>((resolve, reject) => {
      portServer.once("error", reject);
      portServer.listen(0, "127.0.0.1", resolve);
    });
    const portAddress = portServer.address();
    if (portAddress === null || typeof portAddress === "string") {
      throw new Error("Could not reserve a local Chrome CDP port.");
    }
    const devtoolsPort = String(portAddress.port);
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const chrome = spawn(
      chromiumPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--remote-debugging-port=${devtoolsPort}`,
        `--user-data-dir=${profilePath}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    try {
      let cdpUrl = "";
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (chrome.exitCode !== null) {
          throw new Error("Chrome exited before publishing its CDP endpoint.");
        }
        try {
          const versionResponse = await fetch(
            `http://127.0.0.1:${devtoolsPort}/json/version`,
          );
          const version = (await versionResponse.json()) as Record<
            string,
            unknown
          >;
          if (typeof version.webSocketDebuggerUrl === "string") {
            cdpUrl = version.webSocketDebuggerUrl;
            break;
          }
        } catch {
          // Chrome writes the endpoint only after its Browser process is ready.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.match(
        cdpUrl,
        /^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/devtools\/browser\/[A-Za-z0-9_-]+$/u,
      );
      const targetsResponse = await fetch(
        `http://127.0.0.1:${devtoolsPort}/json/list`,
      );
      assert.equal(targetsResponse.ok, true);
      const targets = (await targetsResponse.json()) as Array<
        Record<string, unknown>
      >;
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" && typeof candidate.id === "string",
      );
      if (typeof target?.id !== "string") {
        throw new Error("Chrome did not expose one exact page target.");
      }
      const targetId = target.id;
      const executable = path.join(root, "agent-browser");
      await writeFile(
        executable,
        [
          `#!${process.execPath}`,
          "const args = process.argv.slice(2);",
          `const tab = ${JSON.stringify({
            tabId: "t1",
            targetId,
            label: null,
            title: "about:blank",
            url: "about:blank",
            type: "page",
            active: true,
          })};`,
          `const cdpUrl = ${JSON.stringify(cdpUrl)};`,
          'if (args.includes("tab") && args.includes("list")) {',
          "  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [tab] }, error: null }));",
          '} else if (args.includes("get") && args.includes("cdp-url")) {',
          "  process.stdout.write(JSON.stringify({ success: true, data: { cdpUrl }, error: null }));",
          "} else { process.exit(10); }",
        ].join("\n"),
      );
      await chmod(executable, 0o755);
      const adapter = new AgentBrowserCliAdapter({
        engineExecutablePath: executable,
        chromeExecutablePath: chromiumPath,
      });
      const frame = await adapter.captureViewerFrame({
        ...engineInvocation(),
        runtimePath: root,
        socketPath: root,
        profilePath,
        configPath: root,
        screenshotPath: path.join(root, "screenshot.png"),
      });
      assert.equal(frame.mediaType, "image/png");
      assert.deepEqual(
        Buffer.from(frame.dataBase64, "base64").subarray(0, 8),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    } finally {
      if (chrome.exitCode === null && chrome.signalCode === null) {
        const exited = new Promise<void>((resolve) => {
          chrome.once("exit", () => resolve());
        });
        chrome.kill("SIGKILL");
        await settleWithin(exited, 2000);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function createFixture(
  input: {
    homePath?: string | undefined;
    engine?: FakeEngine | undefined;
    randomId?: (() => string) | undefined;
    authorityResolver?: DesktopBrowserAuthorityResolver | undefined;
    metrics?: DesktopBrowserMetric[] | undefined;
    viewerEvents?: DesktopBrowserViewerEventV1[] | undefined;
    nativeAuthenticationHandoff?: boolean | undefined;
    uploadStream?: {
      open(input: {
        threadId: string;
        sessionId: string;
        generation: number;
        attachmentId: string;
        maximumBytes: number;
      }): Promise<AsyncIterable<Uint8Array>>;
    };
    attachmentStore?: {
      importPath(input: {
        threadId: string;
        filename: string;
        sourcePath: string;
        mimeType?: string | undefined;
      }): Promise<{
        fileId: string;
        mimeType: string;
        sizeBytes: number;
        sha256: string;
      }>;
      list(threadId: string): Promise<
        Array<{
          fileId: string;
          mimeType: string;
          sizeBytes: number;
          sha256: string;
          lifecycleState: "ready";
        }>
      >;
      resolve?(
        threadId: string,
        attachmentIds: string[],
      ): Promise<
        Array<{
          attachmentId: string;
          threadId: string;
          filename: string;
          mimeType: string;
          sizeBytes: number;
          sha256: string;
        }>
      >;
    };
    projectRunRegistry?: ConstructorParameters<
      typeof DesktopBrowserService
    >[0]["projectRunRegistry"];
    now?: (() => Date) | undefined;
    scheduleExpiry?: boolean | undefined;
    initialize?: boolean | undefined;
    withAuthorityAdmission?:
      | (<T>(action: () => Promise<T>) => Promise<T>)
      | undefined;
    writeLedger?:
      | ConstructorParameters<typeof DesktopBrowserService>[0]["writeLedger"]
      | undefined;
  } = {},
) {
  const homePath =
    input.homePath ??
    (await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-host-")));
  const engine = input.engine ?? new FakeEngine();
  const proxies: FakeProxy[] = [];
  let id = 0;
  const service = new DesktopBrowserService({
    homePath,
    engineExecutablePath: "/bundle/agent-browser",
    chromeExecutablePath: "/bundle/Chrome",
    engine,
    uploadStream: input.uploadStream,
    attachmentStore: input.attachmentStore as never,
    authorityResolver: input.authorityResolver,
    withAuthorityAdmission: input.withAuthorityAdmission,
    writeLedger: input.writeLedger,
    metrics:
      input.metrics === undefined
        ? undefined
        : {
            record(metric) {
              input.metrics!.push(metric);
            },
          },
    viewerEvents:
      input.viewerEvents === undefined
        ? undefined
        : {
            record(event) {
              input.viewerEvents!.push(event);
            },
          },
    nativeAuthenticationHandoff:
      input.nativeAuthenticationHandoff === undefined
        ? true
        : input.nativeAuthenticationHandoff,
    now: input.now,
    scheduleExpiry: input.scheduleExpiry ?? false,
    randomId: input.randomId ?? (() => String(++id).padStart(8, "0")),
    projectRunRegistry:
      input.projectRunRegistry ??
      ({
        resolvePreviewUrl({ runId, urlId }) {
          if (runId !== "run-1") throw new Error("run missing");
          if (urlId !== PREVIEW_ID) {
            throw new Error(
              "Project run previews can only open URLs emitted by that managed run.",
            );
          }
          return {
            run: {
              runId,
              projectPath: PROJECT_ROOT,
            } as never,
            url: PREVIEW_URL,
          };
        },
      } satisfies ConstructorParameters<
        typeof DesktopBrowserService
      >[0]["projectRunRegistry"]),
    createProxy: async (binding) => {
      const proxy = new FakeProxy(binding);
      proxies.push(proxy);
      return proxy;
    },
  });
  if (input.initialize !== false) await service.initialize();
  return { service, engine, proxies, homePath };
}

async function openSession(service: DesktopBrowserService): Promise<string> {
  const output = asRecord(
    await service.execute(
      prepared("browser.open", {
        mode: "qa",
        target: {
          kind: "desktop_project_run",
          projectId: "project-1",
          runId: "run-1",
          urlId: PREVIEW_ID,
        },
      }),
      createLifecycle(),
    ),
  );
  return String(asRecord(output.session).sessionId);
}

class FakeEngine implements DesktopBrowserEngineAdapter {
  readonly opened: Array<
    DesktopBrowserEngineInvocation & { destination: string }
  > = [];
  readonly commands: string[][] = [];
  readonly closed: DesktopBrowserEngineInvocation[] = [];
  readonly accepted: Array<{ operationId: string; grantGeneration: number }> =
    [];
  snapshotContent: string;
  readonly #delaySnapshot: boolean;
  readonly tabs: Array<{
    tabId: string;
    url?: string | undefined;
    title: string;
    active: boolean;
  }>;
  concurrentCommands = 0;
  maxConcurrentCommands = 0;
  lossListener?: (() => void) | undefined;
  failNextCommand?: Error | undefined;
  failNextClose?: Error | undefined;
  failNextAcceptance?: Error | undefined;
  failNextOpen?: Error | undefined;
  urlAfterCommand?: { command: string; url: string } | undefined;
  downloadOnCommand?: string | undefined;
  downloadOnBarrierCommand?: string | undefined;
  failAfterDownloadCommand?: string | undefined;
  downloadOnOpen = false;
  pendingDownload = false;
  documentIdentity = "navigation-1";
  pauseCommand?: string | undefined;
  commandPaused?: (() => void) | undefined;
  resumeCommand?: Promise<void> | undefined;
  screenshotBytes?: number | undefined;
  readonly viewerInputs: unknown[] = [];
  readonly uploadedFiles: Array<{ targetRef: string; bytes: Buffer }> = [];
  fileInputLabel = "Fixture attachment";
  readonly nativeHandoffs: DesktopBrowserNativeHandoffAuthority[] = [];
  readonly revokedNativeHandoffs: DesktopBrowserNativeHandoffAuthority[] = [];
  failNextNativePresentation?: Error | undefined;
  failNextNativeRevocation?: Error | undefined;
  onNativePresentation?: (() => void) | undefined;
  viewerFrameBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xk1vAAAAAElFTkSuQmCC";
  viewerFramePaused?: (() => void) | undefined;
  resumeViewerFrame?: Promise<void> | undefined;
  constructor(
    input: {
      snapshotContent?: string;
      delaySnapshot?: boolean;
      tabs?: Array<{
        tabId: string;
        url?: string | undefined;
        title: string;
        active: boolean;
      }>;
    } = {},
  ) {
    this.snapshotContent = input.snapshotContent ?? '- button "Run" [ref=e1]';
    this.#delaySnapshot = input.delaySnapshot === true;
    this.tabs = input.tabs?.map((tab) => ({ ...tab })) ?? [
      { tabId: "t1", url: PREVIEW_URL, title: "Fixture", active: true },
    ];
  }

  async acceptOperation(input: {
    sessionId: string;
    operationId: string;
    grantGeneration: number;
  }): Promise<DesktopBrowserAcceptedOperation> {
    this.accepted.push({
      operationId: input.operationId,
      grantGeneration: input.grantGeneration,
    });
    if (this.failNextAcceptance !== undefined) {
      const error = this.failNextAcceptance;
      this.failNextAcceptance = undefined;
      throw error;
    }
    return {
      sessionId: input.sessionId,
      operationId: input.operationId,
      grantGeneration: input.grantGeneration,
      acceptanceToken: `${input.operationId}:${input.grantGeneration}`,
    };
  }

  releaseOperation(_operation: DesktopBrowserAcceptedOperation): void {}

  async open(
    input: DesktopBrowserEngineInvocation & { destination: string },
  ): Promise<void> {
    const activeTab = this.tabs.find((tab) => tab.active);
    if (activeTab !== undefined) activeTab.url = input.destination;
    input.synchronizeDownloads = async () => {
      if (!this.pendingDownload && !this.downloadOnOpen) return;
      this.pendingDownload = false;
      this.downloadOnOpen = false;
      await emitFakeDownload(input, "download-intercepted");
    };
    this.opened.push(input);
    if (this.failNextOpen !== undefined) {
      const error = this.failNextOpen;
      this.failNextOpen = undefined;
      throw error;
    }
  }

  async command(
    input: DesktopBrowserEngineInvocation & { command: readonly string[] },
  ) {
    this.commands.push([...input.command]);
    this.concurrentCommands += 1;
    this.maxConcurrentCommands = Math.max(
      this.maxConcurrentCommands,
      this.concurrentCommands,
    );
    try {
      if (input.command[0] === this.pauseCommand) {
        this.commandPaused?.();
        await this.resumeCommand;
      }
      if (this.failNextCommand !== undefined) {
        const error = this.failNextCommand;
        this.failNextCommand = undefined;
        throw error;
      }
      if (input.command[0] === "snapshot") {
        if (this.#delaySnapshot)
          await new Promise((resolve) => setTimeout(resolve, 5));
        return json({ snapshot: this.snapshotContent });
      }
      if (input.command[0] === "get" && input.command[1] === "url") {
        return json({
          url: this.tabs.find((tab) => tab.active)?.url ?? PREVIEW_URL,
        });
      }
      if (input.command[0] === "get" && input.command[1] === "title") {
        return json({ title: "Fixture" });
      }
      if (input.command[0] === "eval") {
        // The pinned CLI returns data.result, with a different boundary nonce
        // on every response. Do not teach the service a fixture-only shape.
        return {
          stdout: JSON.stringify({
            success: true,
            error: null,
            _boundary: { nonce: randomUUID() },
            data: { result: this.documentIdentity },
          }),
          stderr: "",
        };
      }
      if (input.command[0] === "tab") {
        if (input.command[1] === "close") {
          this.removeTab(String(input.command[2]));
        } else if (input.command[1] !== "--json") {
          const requested = this.tabs.find(
            (tab) => tab.tabId === input.command[1],
          );
          if (requested === undefined) throw new Error("tab_gone");
          for (const tab of this.tabs) tab.active = tab === requested;
        }
        return json({ tabs: this.tabs });
      }
      if (input.command[0] === "screenshot") {
        await writeFile(
          String(input.command[1]),
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xk1vAAAAAElFTkSuQmCC",
            "base64",
          ),
        );
        if (this.screenshotBytes !== undefined) {
          await truncate(String(input.command[1]), this.screenshotBytes);
        }
      }
      if (input.command[0] === this.downloadOnCommand) {
        const invocation = this.opened[0];
        if (invocation !== undefined) {
          await emitFakeDownload(invocation, "download-intercepted");
        }
      }
      if (input.command[0] === this.failAfterDownloadCommand) {
        throw new Error("engine failed after dispatching a download");
      }
      const urlAfterCommand = this.urlAfterCommand;
      if (
        urlAfterCommand !== undefined &&
        input.command[0] === urlAfterCommand.command
      ) {
        const activeTab = this.tabs.find((tab) => tab.active);
        if (activeTab !== undefined) activeTab.url = urlAfterCommand.url;
        this.urlAfterCommand = undefined;
      }
      if (input.command[0] === this.downloadOnBarrierCommand) {
        this.pendingDownload = true;
      }
      return json({ ok: true });
    } finally {
      this.concurrentCommands -= 1;
    }
  }

  async describeFileInput(input: { targetRef: string }) {
    return { targetRef: input.targetRef, targetLabel: this.fileInputLabel };
  }

  async uploadFile(input: { targetRef: string; ownedPath: string }) {
    this.uploadedFiles.push({
      targetRef: input.targetRef,
      bytes: await readFile(input.ownedPath),
    });
  }

  async close(input: DesktopBrowserEngineInvocation): Promise<void> {
    if (this.failNextClose !== undefined) {
      const error = this.failNextClose;
      this.failNextClose = undefined;
      throw error;
    }
    this.closed.push(input);
  }

  async captureViewerFrame() {
    this.viewerFramePaused?.();
    await this.resumeViewerFrame;
    return {
      mediaType: "image/png" as const,
      dataBase64: this.viewerFrameBase64,
    };
  }

  async dispatchViewerInput(input: { viewerInput: unknown }): Promise<void> {
    this.viewerInputs.push(structuredClone(input.viewerInput));
  }

  async presentNativeHandoff(input: {
    authority: DesktopBrowserNativeHandoffAuthority;
  }): Promise<DesktopBrowserNativeHandoffPresentation> {
    if (this.failNextNativePresentation !== undefined) {
      const error = this.failNextNativePresentation;
      this.failNextNativePresentation = undefined;
      throw error;
    }
    this.nativeHandoffs.push(structuredClone(input.authority));
    this.onNativePresentation?.();
    return { windowId: 41, targetId: "t1" };
  }

  async revokeNativeHandoff(input: {
    authority: DesktopBrowserNativeHandoffAuthority;
  }): Promise<void> {
    if (this.failNextNativeRevocation !== undefined) {
      const error = this.failNextNativeRevocation;
      this.failNextNativeRevocation = undefined;
      throw error;
    }
    this.revokedNativeHandoffs.push(structuredClone(input.authority));
  }

  async emitDownload(): Promise<void> {
    const invocation = this.opened[0];
    if (invocation !== undefined) {
      await emitFakeDownload(invocation, "late-download");
    }
  }

  removeTab(tabId: string): void {
    const index = this.tabs.findIndex((tab) => tab.tabId === tabId);
    if (index < 0) throw new Error("tab_gone");
    const [removed] = this.tabs.splice(index, 1);
    if (removed?.active === true && this.tabs[0] !== undefined) {
      this.tabs[0].active = true;
    }
  }

  watchForLoss(
    _input: DesktopBrowserEngineInvocation,
    onLost: () => void,
  ): () => void {
    this.lossListener = onLost;
    return () => {
      if (this.lossListener === onLost) this.lossListener = undefined;
    };
  }

  triggerLoss(): void {
    this.lossListener?.();
  }
}

async function emitFakeDownload(
  invocation: DesktopBrowserEngineInvocation,
  downloadId: string,
): Promise<void> {
  const browserGuid = "123e4567-e89b-42d3-a456-426614174000";
  const bytes = Buffer.from(`download:${downloadId}`, "utf8");
  const ownedPath = path.join(invocation.blockedDownloadPath, browserGuid);
  await mkdir(invocation.blockedDownloadPath, { recursive: true, mode: 0o700 });
  await chmod(invocation.blockedDownloadPath, 0o700);
  await writeFile(ownedPath, bytes, { mode: 0o600 });
  const createdAt = new Date().toISOString();
  await invocation.onDownloadIntercepted?.({
    downloadId,
    browserGuid,
    filename: "blocked.bin",
    declaredMediaType: "application/octet-stream",
    normalizedSourceOrigin: "https://example.com",
    measuredBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 30 * 60 * 1000).toISOString(),
    ownedPath,
  });
}

class FakeProxy implements LocalCoreBrowserEgressProxy {
  readonly version = "local_core_browser_egress_proxy_v1" as const;
  readonly binding: CreateLocalCoreBrowserEgressProxyInput;
  launchBinding: LocalCoreBrowserEgressLaunchBindingV1;
  closed = false;
  adoptions = 0;
  failNextAdoption = false;

  constructor(binding: CreateLocalCoreBrowserEgressProxyInput) {
    this.binding = binding;
    this.launchBinding = proxyBinding(binding);
  }

  async adoptAuthority(binding: CreateLocalCoreBrowserEgressProxyInput) {
    this.adoptions += 1;
    if (this.failNextAdoption) {
      this.failNextAdoption = false;
      throw new Error("proxy adoption failed");
    }
    this.launchBinding = proxyBinding(binding);
    return {
      receipt: {
        version: "browser_allowlist_adoption_receipt_v1" as const,
        sessionId: binding.sessionId,
        effectiveAllowlistRevision:
          binding.authority.effectiveAllowlistRevision,
        closedUnauthorizedConnections: 0,
      },
      launchBinding: this.launchBinding,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function proxyBinding(
  binding: CreateLocalCoreBrowserEgressProxyInput,
): LocalCoreBrowserEgressLaunchBindingV1 {
  return {
    version: "local_core_browser_egress_launch_binding_v1",
    proxyServer: "http://127.0.0.1:4444",
    username: "proxy-user",
    password: "proxy-secret",
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    generation: binding.generation,
    effectiveAllowlistRevision: binding.authority.effectiveAllowlistRevision,
    chromiumFlags: ["--disable-quic"],
  };
}

function operatorAuthority(
  revision: string,
  domains: string[],
): BrowserEffectiveDomainAuthorityV1 {
  return {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environmentId: "environment-1",
    projectId: "project-1",
    userId: "user-1",
    enabledModes: ["operator"],
    personalGrantsEnabled: true,
    publicDomains: domains.map((domain) =>
      canonicalizePublicBrowserDestination(`https://${domain}/`),
    ),
    qaTarget: null,
    effectiveAllowlistRevision: revision,
  };
}

function realSignedInBrowserAccount() {
  return {
    status: "signed_in",
    baseUrl: "https://kestrel.test",
    projection: {
      account: {
        id: "account-1",
        name: "Person",
        email: "person@example.com",
      },
      organizations: [
        {
          organizationId: "organization-1",
          organizationName: "Organization",
          organizationSlug: "organization",
          organizationRole: "member",
        },
      ],
      projects: [
        {
          id: "local-project",
          organizationId: "organization-1",
          name: "Project",
          environmentId: "environment-1",
          environmentProvider: "desktop",
          desktopWorkspaceRef: "workspace-ref-1",
          role: "owner",
          browserAuthority: {
            environment: {
              version: "browser_environment_domain_authority_v1",
              environmentId: "environment-1",
              revision: "environment-revision-1",
              enabledModes: ["operator"],
              personalGrantsEnabled: true,
              configuredPublicDomains: [
                realBrowserDomain("configured-example.com"),
              ],
              blockedPublicDomains: [],
            },
            project: {
              version: "browser_project_domain_authority_v1",
              projectId: "local-project",
              revision: "project-revision-1",
              enabledModes: ["operator"],
              personalGrantsEnabled: true,
              blockedPublicDomains: [],
            },
          },
        },
      ],
      threads: [],
    },
  };
}

function realDesktopBrowserEnvironment() {
  return {
    enrollments: [],
    environments: [
      {
        connectionId: "connection-1",
        environmentId: "environment-1",
        organizationId: "organization-1",
        baseUrl: "https://kestrel.test",
        desktopName: "Desktop",
        status: "active",
        connectionStatus: "online",
        capacity: 1,
        activeRuns: 0,
        models: [],
        workspaces: [
          {
            projectId: "local-project",
            workspaceRef: "workspace-ref-1",
            label: "Project",
            available: true,
          },
        ],
      },
    ],
    globalCapacity: 1,
    activeRuns: 0,
    activity: [],
  };
}

function realBrowserDomain(canonicalDomain: string) {
  return {
    version: "browser_public_domain_authority_v1",
    scheme: "https",
    canonicalDomain,
    includeSubdomains: true,
    port: 443,
  };
}

function prepared(
  toolName: string,
  effectiveInput: Record<string, unknown>,
): PreparedToolCallV1 {
  const id = `${toolName}-${Math.random().toString(36).slice(2)}`;
  return {
    version: "v1",
    runId: `run-${id}`,
    sessionId: "runtime-session-1",
    callId: `call-${id}`,
    activation: {
      version: "v1",
      descriptor: {
        version: "v1",
        toolId: toolName,
        sourceKind: "builtin",
        sourceId: "kestrel.browser",
        contractRevision: "browser-contract",
        inputSchemaHash: "input",
        outputContractHash: "output",
      },
      registryGeneration: "registry-1",
      scopeFingerprint: "scope-1",
    },
    origin: {
      kind: "trusted_runtime",
      producerId: "desktop-browser-test",
      adapterId: "desktop-browser-test:v1",
    },
    effectiveInput:
      toolName === "browser.open" || effectiveInput.generation !== undefined
        ? effectiveInput
        : { ...effectiveInput, generation: 1 },
    inputAdapters: [],
    policy: { decision: "allow", policyRevision: "policy-1" },
    preparedAt: "2026-08-29T12:00:00.000Z",
  };
}

function createLifecycle(
  input: {
    projectId?: string;
    projectRoot?: string;
    threadId?: string;
    signal?: AbortSignal;
  } = {},
) {
  const events: string[] = [];
  const lifecycle: BrowserOperationLifecycleV1 & { events: string[] } = {
    authority: {
      threadId: input.threadId ?? "thread-1",
      projectId: input.projectId ?? "project-1",
      projectRoot: input.projectRoot ?? PROJECT_ROOT,
    },
    ...(input.signal ? { signal: input.signal } : {}),
    events,
    async acknowledgeDispatch() {
      events.push("ack");
    },
    async persistCompletedResult() {
      events.push("persist");
    },
  };
  return lifecycle;
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser operation did not settle.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function engineInvocation(): DesktopBrowserEngineInvocation {
  return {
    sessionId: "browser-1",
    runtimePath: "/runtime",
    socketPath: "/tmp/kestrel-browser-501/session-hash",
    profilePath: "/runtime/profile",
    configPath: "/runtime/config",
    screenshotPath: "/runtime/screenshot.png",
    blockedDownloadPath: "/runtime/downloads-disabled",
    proxy: {
      version: "local_core_browser_egress_launch_binding_v1",
      proxyServer: "http://127.0.0.1:4444",
      username: "proxy-user",
      password: "proxy-secret",
      threadId: "thread-1",
      sessionId: "browser-1",
      generation: 1,
      effectiveAllowlistRevision: "revision-1",
      chromiumFlags: ["--disable-quic"],
    },
  };
}

function json(data: unknown) {
  return { stdout: JSON.stringify({ data }), stderr: "" };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function requireAvailableViewer(
  viewer: DesktopBrowserViewerStateV1,
): DesktopBrowserViewerStateV1 & {
  available: true;
  sessionId: string;
  generation: number;
  connectionId: string;
} {
  assert.equal(viewer.available, true);
  assert.equal(typeof viewer.sessionId, "string");
  assert.equal(typeof viewer.generation, "number");
  assert.equal(typeof viewer.connectionId, "string");
  return viewer as DesktopBrowserViewerStateV1 & {
    available: true;
    sessionId: string;
    generation: number;
    connectionId: string;
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Desktop Browser state transition.");
}
