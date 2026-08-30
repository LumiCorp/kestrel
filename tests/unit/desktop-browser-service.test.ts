import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
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
import { PassThrough } from "node:stream";
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
  spawnAndCollect,
  type DesktopBrowserAuthorityResolver,
  type DesktopBrowserAcceptedOperation,
  type DesktopBrowserEngineAdapter,
  type DesktopBrowserEngineInvocation,
  type DesktopBrowserMetric,
  type DesktopBrowserViewerEventV1,
} from "../../src/localCore/desktopBrowserService.js";
import { LocalCoreBrowserAuthorityCriticalSection } from "../../src/localCore/api.js";
import { LocalCoreDesktopBrowserAuthorityResolver } from "../../src/localCore/desktopBrowserAuthority.js";
import {
  BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
  canonicalizePublicBrowserDestination,
  type BrowserEffectiveDomainAuthorityV1,
} from "../../src/browser/domainAuthority.js";
import type {
  BrowserOperationLifecycleV1,
  BrowserSessionV1,
} from "../../src/browser/contracts.js";
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
    await readFile(path.join(fixture.homePath, "browser", "sessions.json"), "utf8"),
    new RegExp(sentinel, "u"),
  );

  const returned = await fixture.service.returnViewerControl({
    ...viewer,
    principalId: "desktop-main-1",
    leaseId: accepted.inputLeaseId!,
  });
  assert.equal(returned.sessionState, "ready");
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
    }),
    hasCode("BROWSER_SESSION_CONFLICT"),
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
    hasCode("BROWSER_HUMAN_CONTROL_ACTIVE"),
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
  await fixture.service.close();
});

test("Desktop viewer authority loss and engine loss terminate human control instead of resuming the agent", async () => {
  const fixture = await createFixture();
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
    (await fixture.service.connectViewer({
      principalId: "desktop-main-1",
      threadId: "thread-1",
      projectId: "project-1",
    })).available,
    false,
  );

  const second = await createFixture();
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
  await second.service.loseViewerAuthority({
    ...secondViewer,
    principalId: "desktop-main-2",
  });
  assert.equal(second.engine.closed.length, 1);
  await assert.rejects(
    second.service.execute(
      prepared("browser.snapshot", { sessionId: secondSession }),
      createLifecycle(),
    ),
    hasCode("BROWSER_SESSION_LOST"),
  );
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
  const ledgerPath = path.join(
    fixture.homePath,
    "browser",
    "sessions.json",
  );
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
    sessions: BrowserSessionV1[];
    artifacts: unknown[];
    version: string;
  };
  ledger.sessions[0]!.sessionId = "../outside-runtime";
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const outsideRuntime = path.join(fixture.homePath, "browser", "outside-runtime");
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
    const ledgerPath = path.join(
      fixture.homePath,
      "browser",
      "sessions.json",
    );
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
  assert.equal(listedTabs.some((tab) => tab.tabId === "t104"), true);

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
  assert.equal(closedTabs.some((tab) => tab.tabId === "t1" && tab.active), true);
  assert.equal(closedTabs.some((tab) => tab.tabId === "t105"), false);
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

test("Desktop Browser derives a short private socket path and removes it on cleanup", async () => {
  const sessionSuffix = "123e4567-e89b-12d3-a456-426614174000";
  const fixture = await createFixture({ randomId: () => sessionSuffix });
  await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  const socketFile = path.join(
    invocation.socketPath,
    `${invocation.sessionId}.sock`,
  );
  assert.equal(Buffer.byteLength(socketFile, "utf8") <= 103, true, socketFile);
  assert.equal((await stat(invocation.socketPath)).mode & 0o777, 0o700);
  assert.equal(invocation.socketPath.startsWith("/tmp/kestrel-browser-"), true);
  await fixture.service.close();
  await assert.rejects(stat(invocation.socketPath), { code: "ENOENT" });
});

test("upload and download are rejected before engine dispatch and the download directory is non-writable", async () => {
  let uploadStreamsOpened = 0;
  const fixture = await createFixture({
    uploadStream: {
      async open() {
        uploadStreamsOpened += 1;
        return (async function* () {
          yield new Uint8Array([1]);
        })();
      },
    },
  });
  const sessionId = await openSession(fixture.service);
  const invocation = fixture.engine.opened[0]!;
  assert.equal((await stat(invocation.blockedDownloadPath)).mode & 0o777, 0);
  const commandCount = fixture.engine.commands.length;
  for (const [toolName, input] of [
    [
      "browser.upload",
      { sessionId, snapshotId: "s", targetRef: "@e1", attachmentId: "file-1" },
    ],
    ["browser.download", { sessionId, pendingDownloadId: "download-1" }],
  ] as const) {
    const lifecycle = createLifecycle();
    await assert.rejects(
      fixture.service.execute(prepared(toolName, input), lifecycle),
      hasCode(
        toolName === "browser.download"
          ? "BROWSER_DOWNLOAD_UNAVAILABLE"
          : "BROWSER_SERVICE_UNAVAILABLE",
      ),
    );
    assert.deepEqual(lifecycle.events, []);
  }
  assert.equal(fixture.engine.commands.length, commandCount);
  assert.equal(uploadStreamsOpened, 0);
  await fixture.service.close();
});

test("an intercepted page download returns stable unavailable without writing a default download", async () => {
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
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  assert.equal(
    (await stat(engine.opened[0]!.blockedDownloadPath)).mode & 0o777,
    0,
  );
  assert.equal(
    metrics.some((metric) => metric.name === "browser_unknown_outcome"),
    false,
  );
  await fixture.service.close();
});

test("download events queued behind a command are observed by the protocol barrier", async () => {
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
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
  assert.deepEqual(lifecycle.events, ["ack"]);
  await fixture.service.close();
});

test("an intercepted download wins over an engine error from the same command", async () => {
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
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.interact", {
        sessionId,
        snapshotId: snapshot.snapshotId,
        documentRevision: snapshot.documentRevision,
        tabId: "t1",
        action: { kind: "click", ref: "@e1" },
      }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
  await waitFor(async () => {
    const ledger = JSON.parse(
      await readFile(
        path.join(fixture.homePath, "browser", "sessions.json"),
        "utf8",
      ),
    ) as { sessions: BrowserSessionV1[] };
    return (
      ledger.sessions[0]?.terminalReason === "BROWSER_DOWNLOAD_UNAVAILABLE"
    );
  });
});

test("a download observed after command return terminalizes the session with its stable reason", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  await fixture.service.execute(
    prepared("browser.snapshot", { sessionId }),
    createLifecycle(),
  );

  engine.emitDownload();

  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
  await waitFor(async () => {
    const ledger = JSON.parse(
      await readFile(
        path.join(fixture.homePath, "browser", "sessions.json"),
        "utf8",
      ),
    ) as { sessions: BrowserSessionV1[] };
    return (
      ledger.sessions[0]?.state === "failed" &&
      ledger.sessions[0]?.terminalReason === "BROWSER_DOWNLOAD_UNAVAILABLE" &&
      engine.closed.length === 1
    );
  });
  await assert.rejects(
    fixture.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
});

test("a late download persists its first terminal reason before failed cleanup and restart converges it", async () => {
  const engine = new FakeEngine();
  const fixture = await createFixture({ engine });
  const sessionId = await openSession(fixture.service);
  const invocation = engine.opened[0]!;
  engine.failNextClose = new Error("termination unproven");

  engine.emitDownload();

  await waitFor(async () => {
    const ledger = JSON.parse(
      await readFile(
        path.join(fixture.homePath, "browser", "sessions.json"),
        "utf8",
      ),
    ) as { sessions: BrowserSessionV1[] };
    return (
      ledger.sessions[0]?.state === "failed" &&
      ledger.sessions[0]?.terminalReason === "BROWSER_DOWNLOAD_UNAVAILABLE"
    );
  });
  await stat(invocation.runtimePath);
  await stat(invocation.socketPath);

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
  assert.equal(ledger.sessions[0]?.state, "failed");
  assert.equal(
    ledger.sessions[0]?.terminalReason,
    "BROWSER_DOWNLOAD_UNAVAILABLE",
  );
  assert.equal(recoveringEngine.closed.length, 1);
  await assert.rejects(stat(invocation.runtimePath), { code: "ENOENT" });
  await assert.rejects(stat(invocation.socketPath), { code: "ENOENT" });
  await assert.rejects(
    recovered.service.execute(
      prepared("browser.snapshot", { sessionId }),
      createLifecycle(),
    ),
    hasCode("BROWSER_DOWNLOAD_UNAVAILABLE"),
  );
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
  assert.deepEqual(await fixture.service.authorizeArtifact(request), artifact);
  await fixture.service.close();

  const restarted = await createFixture({ homePath: fixture.homePath });
  assert.equal(
    await restarted.service.authorizeArtifact({
      ...request,
      callId: "replayed-by-another-call",
    }),
    undefined,
  );
  assert.deepEqual(
    await restarted.service.authorizeArtifact(request),
    artifact,
  );
  await restarted.service.close();
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
    const downloads: string[] = [];
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
                guid: "async-download",
                suggestedFilename: "async.bin",
                url: "https://example.com/private?token=not-recorded",
              },
            }),
          );
          setImmediate(() => {
            socket.send(JSON.stringify({ id: command.id, result: {} }));
          });
        });
      });
    });

    const interception = await installAgentBrowserDownloadInterception(
      `ws://127.0.0.1:${address.port}/devtools/browser/test`,
      (download) => downloads.push(download.downloadId),
    );
    t.after(() => interception.stop());
    await interception.synchronize();
    assert.deepEqual(downloads, ["async-download"]);
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

test("agent-browser launch uses explicit assets, empty Kestrel state, and keeps proxy secrets out of argv", () => {
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
  assert.doesNotMatch(JSON.stringify(built.args), /proxy-user|proxy-secret/u);
  assert.equal(built.env.AGENT_BROWSER_PROXY_USERNAME, "proxy-user");
  assert.equal(built.env.AGENT_BROWSER_PROXY_PASSWORD, "proxy-secret");
  assert.equal(built.env.AGENT_BROWSER_SOCKET_DIR, invocation.socketPath);
  assert.equal(built.env.TMPDIR, invocation.socketPath);
  assert.equal(
    Buffer.byteLength(
      path.join(
        "/tmp/kestrel-browser-4294967295",
        "0123456789abcdef",
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

async function createFixture(
  input: {
    homePath?: string | undefined;
    engine?: FakeEngine | undefined;
    randomId?: (() => string) | undefined;
    authorityResolver?: DesktopBrowserAuthorityResolver | undefined;
    metrics?: DesktopBrowserMetric[] | undefined;
    viewerEvents?: DesktopBrowserViewerEventV1[] | undefined;
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
    };
    projectRunRegistry?: ConstructorParameters<
      typeof DesktopBrowserService
    >[0]["projectRunRegistry"];
    now?: (() => Date) | undefined;
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
    now: input.now,
    scheduleExpiry: false,
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
  viewerFrameBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xk1vAAAAAElFTkSuQmCC";

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
      input.onDownloadIntercepted?.({
        downloadId: "download-intercepted",
        filename: "blocked.bin",
        sourceOrigin: "https://example.com",
      });
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
        return json({ value: this.documentIdentity });
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
        this.opened[0]?.onDownloadIntercepted?.({
          downloadId: "download-intercepted",
          filename: "blocked.bin",
          sourceOrigin: "https://example.com",
        });
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

  async close(input: DesktopBrowserEngineInvocation): Promise<void> {
    if (this.failNextClose !== undefined) {
      const error = this.failNextClose;
      this.failNextClose = undefined;
      throw error;
    }
    this.closed.push(input);
  }

  async captureViewerFrame() {
    return {
      mediaType: "image/png" as const,
      dataBase64: this.viewerFrameBase64,
    };
  }

  async dispatchViewerInput(input: { viewerInput: unknown }): Promise<void> {
    this.viewerInputs.push(structuredClone(input.viewerInput));
  }

  emitDownload(): void {
    this.opened[0]?.onDownloadIntercepted?.({
      downloadId: "late-download",
      filename: "late.bin",
      sourceOrigin: "https://example.com",
    });
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
  } = {},
) {
  const events: string[] = [];
  const lifecycle: BrowserOperationLifecycleV1 & { events: string[] } = {
    authority: {
      threadId: input.threadId ?? "thread-1",
      projectId: input.projectId ?? "project-1",
      projectRoot: input.projectRoot ?? PROJECT_ROOT,
    },
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
