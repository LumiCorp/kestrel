import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  HostedBrowserViewerOutcomeUnknownError,
  HostedBrowserViewerService,
} from "./viewer-service";
import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import type { HostedBrowserResourceRecord } from "./store";
import type { HostedBrowserViewerTicketStorePort } from "./viewer-transient-store";
import type { HostedBrowserViewerWorkerPort } from "./viewer-worker-client";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

test("only the originating actor gets a one-use viewer ticket and can accept, reconnect, return, and close", async () => {
  const fixture = createFixture();
  assert.equal((await fixture.service.status({ organizationId: "org-1", actorId: "other", threadId: "thread-1" })).available, false);
  assert.equal((await fixture.service.status({ organizationId: "other-org", actorId: "user-1", threadId: "thread-1" })).available, false);
  assert.equal((await fixture.service.status({ organizationId: "org-1", actorId: "user-1", threadId: "other-thread" })).available, false);
  await assert.rejects(fixture.service.mintTicket({ organizationId: "org-1", actorId: "other", threadId: "thread-1" }));

  const issued = await fixture.service.mintTicket({ organizationId: "org-1", actorId: "user-1", threadId: "thread-1" });
  assert.equal(issued.route, "/api/threads/thread-1/browser-viewer/v1");
  const connection = await fixture.service.connect(issued.ticket);
  assert.match(
    connection.claims.connectionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.notEqual(connection.claims.connectionId, connection.claims.nonce);
  assert.equal(
    fixture.workerCalls[0]?.connectionId,
    connection.claims.connectionId,
  );
  await assert.rejects(fixture.service.connect(issued.ticket), /BROWSER_SESSION_LOST/u);
  assert.equal(connection.state.takeoverRequested, true);

  const accepted = await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  assert.equal(accepted.type, "state");
  assert.equal(fixture.session.state, "human_control");
  const leaseId = connection.state.inputLeaseId!;
  const passwordSentinel = "KSTRL-PASSWORD-SENTINEL-91x";
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "input",
    leaseId,
    input: {
      version: "desktop_browser_viewer_input_v1",
      kind: "keyboard",
      phase: "down",
      key: "x",
      text: passwordSentinel,
    },
  });
  assert.equal(fixture.workerInputs[0]?.text, passwordSentinel);
  assert.doesNotMatch(JSON.stringify(fixture.evidence), new RegExp(passwordSentinel));

  await connection.disconnect();
  assert.equal(fixture.session.state, "human_control");
  fixture.workerState = { ...fixture.workerState, inputLeaseId: undefined, inputLeaseExpiresAt: undefined };
  const reconnectTicket = await fixture.service.mintTicket({ organizationId: "org-1", actorId: "user-1", threadId: "thread-1" });
  const reconnected = await fixture.service.connect(reconnectTicket.ticket);
  await reconnected.dispatch({ version: "hosted_browser_viewer_route_v1", type: "accept_takeover" });
  await reconnected.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "return_control",
    leaseId: reconnected.state.inputLeaseId!,
  });
  assert.equal(fixture.session.state, "ready");
  await reconnected.dispatch({ version: "hosted_browser_viewer_route_v1", type: "close_session" });
  assert.deepEqual(fixture.terminations, ["closed_by_user"]);
});

test("authorization loss during frame delivery closes the Browser Session instead of restoring agent control", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({ organizationId: "org-1", actorId: "user-1", threadId: "thread-1" });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({ version: "hosted_browser_viewer_route_v1", type: "accept_takeover" });
  fixture.accessAllowed = false;
  await assert.rejects(connection.frame(), /BROWSER_SESSION_LOST/u);
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
  assert.equal(fixture.session.state, "human_control");
});

test("worker loss during viewing closes the Browser Session instead of restoring agent control", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({ organizationId: "org-1", actorId: "user-1", threadId: "thread-1" });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({ version: "hosted_browser_viewer_route_v1", type: "accept_takeover" });
  fixture.workerLost = true;
  await assert.rejects(connection.frame(), /BROWSER_ENGINE_FAILURE/u);
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
  assert.equal(fixture.session.state, "human_control");
});

test("an uncertain connect releases the exact preselected connection without closing the Browser Session", async () => {
  const fixture = createFixture();
  fixture.connectResponseLost = true;
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });

  await assert.rejects(
    fixture.service.connect(issued.ticket),
    /BROWSER_ENGINE_FAILURE/u,
  );
  assert.equal(fixture.liveConnections.size, 0);
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.workerCalls.length, 2);
  assert.equal(fixture.workerCalls[0]?.action, "connect");
  assert.equal(fixture.workerCalls[1]?.action, "disconnect");
  assert.equal(
    fixture.workerCalls[1]?.connectionId,
    fixture.workerCalls[0]?.connectionId,
  );
});

test("an uncertain connect without disconnect or durable terminal proof returns unknown and retains exact cleanup identity", async () => {
  const fixture = createFixture();
  fixture.connectResponseLost = true;
  fixture.disconnectLost = true;
  fixture.terminationFailure = "before_terminal";
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });

  let unknown: HostedBrowserViewerOutcomeUnknownError | undefined;
  try {
    await fixture.service.connect(issued.ticket);
    assert.fail("connect must not report a handled failure without cleanup proof");
  } catch (error) {
    assert.ok(error instanceof HostedBrowserViewerOutcomeUnknownError);
    unknown = error;
  }
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
  assert.equal(fixture.session.state, "ready");
  assert.equal(fixture.liveConnections.size, 1);
  assert.doesNotMatch(JSON.stringify(fixture.evidence), /browser_viewer_authority_lost/u);

  fixture.disconnectLost = false;
  assert.ok(unknown);
  assert.equal(await unknown.retryCleanup(), true);
  assert.equal(fixture.liveConnections.size, 0);
});

test("cleanup failure after the exact durable terminal transition remains proven fail-close", async () => {
  const fixture = createFixture();
  fixture.connectResponseLost = true;
  fixture.disconnectLost = true;
  fixture.terminationFailure = "after_terminal";
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });

  await assert.rejects(
    fixture.service.connect(issued.ticket),
    /BROWSER_ENGINE_FAILURE/u,
  );
  assert.equal(fixture.session.state, "lost");
  assert.ok(fixture.resource.cleanupRequestedAt);
  assert.match(JSON.stringify(fixture.evidence), /browser_viewer_authority_lost/u);
});

test("an invalid connect state releases the exact connection and fail-closes once", async () => {
  const fixture = createFixture();
  fixture.invalidConnectState = true;
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });

  await assert.rejects(
    fixture.service.connect(issued.ticket),
    /BROWSER_SESSION_LOST/u,
  );
  assert.equal(fixture.liveConnections.size, 0);
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
});

test("an invalid connect state carries an exact disconnect and fail-close retry", async () => {
  const fixture = createFixture();
  fixture.invalidConnectState = true;
  fixture.disconnectLost = true;
  fixture.terminationFailure = "before_terminal";
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });

  let unknown: HostedBrowserViewerOutcomeUnknownError | undefined;
  try {
    await fixture.service.connect(issued.ticket);
    assert.fail("invalid connect cleanup must remain outcome unknown");
  } catch (error) {
    assert.ok(error instanceof HostedBrowserViewerOutcomeUnknownError);
    unknown = error;
  }
  assert.equal(fixture.liveConnections.size, 1);

  fixture.disconnectLost = false;
  fixture.terminationFailure = undefined;
  assert.equal(await unknown?.retryCleanup(), true);
  assert.equal(fixture.liveConnections.size, 0);
  assert.deepEqual(
    fixture.workerCalls.map((call) => call.action),
    ["connect", "disconnect", "disconnect"],
  );
});

test("invalid pre-dispatch authority carries a real durable fail-close retry", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  fixture.accessAllowed = false;
  fixture.terminationFailure = "before_terminal";

  let unknown: HostedBrowserViewerOutcomeUnknownError | undefined;
  try {
    await fixture.service.connect(issued.ticket);
    assert.fail("unconfirmed fail-close must remain outcome unknown");
  } catch (error) {
    assert.ok(error instanceof HostedBrowserViewerOutcomeUnknownError);
    unknown = error;
  }
  assert.equal(fixture.workerCalls.length, 0);

  fixture.terminationFailure = undefined;
  assert.equal(await unknown?.retryCleanup(), true);
  assert.equal(fixture.workerCalls.length, 0);
  assert.deepEqual(fixture.terminations, [
    "BROWSER_SESSION_LOST",
    "BROWSER_SESSION_LOST",
  ]);
});

test("frame fail-close uncertainty carries a real durable retry", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.workerLost = true;
  fixture.terminationFailure = "before_terminal";

  let unknown: HostedBrowserViewerOutcomeUnknownError | undefined;
  try {
    await connection.frame();
    assert.fail("unconfirmed frame fail-close must remain outcome unknown");
  } catch (error) {
    assert.ok(error instanceof HostedBrowserViewerOutcomeUnknownError);
    unknown = error;
  }

  fixture.terminationFailure = undefined;
  assert.equal(await unknown?.retryCleanup(), true);
});

test("dispatch fail-close uncertainty carries a real durable retry", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.workerLost = true;
  fixture.terminationFailure = "before_terminal";

  let unknown: HostedBrowserViewerOutcomeUnknownError | undefined;
  try {
    await connection.dispatch({
      version: "hosted_browser_viewer_route_v1",
      type: "accept_takeover",
    });
    assert.fail("unconfirmed dispatch fail-close must remain outcome unknown");
  } catch (error) {
    assert.ok(error instanceof HostedBrowserViewerOutcomeUnknownError);
    unknown = error;
  }

  fixture.terminationFailure = undefined;
  assert.equal(await unknown?.retryCleanup(), true);
});

function createFixture() {
  const currentNow = new Date("2026-08-30T12:00:00.000Z");
  const session: BrowserSessionV1 = {
    version: "browser_session_v1",
    sessionId: "session-1",
    threadId: "thread-1",
    mode: "operator",
    state: "ready",
    engineRevision: "engine-1",
    generation: 1,
    effectiveAllowlistRevision: "revision-1",
    createdAt: "2026-08-30T11:00:00.000Z",
    updatedAt: "2026-08-30T11:00:00.000Z",
    lastActivityAt: "2026-08-30T11:00:00.000Z",
    idleExpiresAt: "2026-08-30T12:30:00.000Z",
    hardExpiresAt: "2026-08-30T19:00:00.000Z",
  };
  const resource: HostedBrowserResourceRecord = {
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
  const ticketValues = new Map<string, string>();
  const tickets: HostedBrowserViewerTicketStorePort = {
    async issue(input) { ticketValues.set(input.nonce, input.token); },
    async consume(input) {
      if (ticketValues.get(input.nonce) !== input.token) return false;
      ticketValues.delete(input.nonce);
      return true;
    },
    async revoke(nonce) { ticketValues.delete(nonce); },
  };
  const workerInputs: Array<{ text?: string }> = [];
  const workerCalls: Array<{ action: string; connectionId?: string }> = [];
  const liveConnections = new Set<string>();
  let workerLost = false;
  let connectResponseLost = false;
  let disconnectLost = false;
  let invalidConnectState = false;
  let terminationFailure: "before_terminal" | "after_terminal" | undefined;
  let workerState = viewerState("ready", true);
  const worker: HostedBrowserViewerWorkerPort = {
    async invoke(input) {
      workerCalls.push({
        action: input.action,
        ...(input.connectionId === undefined
          ? {}
          : { connectionId: input.connectionId }),
      });
      if (workerLost) throw new Error("BROWSER_ENGINE_FAILURE");
      if (input.action === "connect") {
        liveConnections.add(input.connectionId!);
        workerState = {
          ...workerState,
          connectionId: invalidConnectState
            ? "identity-drifted"
            : input.connectionId!,
        };
        if (connectResponseLost) throw new Error("BROWSER_ENGINE_FAILURE");
        return workerState;
      }
      if (input.action === "disconnect") {
        if (disconnectLost) throw new Error("BROWSER_ENGINE_FAILURE");
        liveConnections.delete(input.connectionId!);
        return null;
      }
      if (input.action === "frame") return {
        version: "desktop_browser_viewer_frame_v1",
        sessionId: "session-1",
        generation: 1,
        sequence: 1,
        capturedAt: currentNow.toISOString(),
        mediaType: "image/png",
        dataBase64: "iVBORw0KGgo=",
      };
      if (input.action === "accept") {
        workerState = viewerState(
          "human_control",
          false,
          "lease-1",
          workerState.connectionId,
        );
        return workerState;
      }
      if (input.action === "input") {
        workerInputs.push({ text: input.viewerInput?.kind === "keyboard" ? input.viewerInput.text : undefined });
        return workerState;
      }
      if (input.action === "renew") return workerState;
      if (input.action === "return") {
        workerState = viewerState(
          "ready",
          false,
          undefined,
          workerState.connectionId,
        );
        return workerState;
      }
      return null;
    },
  };
  const evidence: unknown[] = [];
  const terminations: string[] = [];
  const fixture = {
    session,
    workerInputs,
    evidence,
    terminations,
    workerCalls,
    liveConnections,
    resource,
    accessAllowed: true,
    get workerState() { return workerState; },
    set workerState(value) { workerState = value; },
    get workerLost() { return workerLost; },
    set workerLost(value) { workerLost = value; },
    get connectResponseLost() { return connectResponseLost; },
    set connectResponseLost(value) { connectResponseLost = value; },
    get disconnectLost() { return disconnectLost; },
    set disconnectLost(value) { disconnectLost = value; },
    get invalidConnectState() { return invalidConnectState; },
    set invalidConnectState(value) { invalidConnectState = value; },
    get terminationFailure() { return terminationFailure; },
    set terminationFailure(value) { terminationFailure = value; },
    service: undefined as unknown as HostedBrowserViewerService,
  };
  fixture.service = new HostedBrowserViewerService({
    store: {
      async readActiveForThread(threadId) { return threadId === session.threadId ? { session, resource } : null; },
      async read(sessionId) { return sessionId === session.sessionId ? { session, resource } : null; },
      async resolveCurrentOrigin() {
        return { organizationId: "org-1", environmentId: "env-1", projectId: "project-1", threadId: "thread-1", runId: "run-1", turnId: "turn-1", userId: "user-1" };
      },
      async transitionViewerControl(input) {
        if (session.state !== input.from) throw new Error("BROWSER_SESSION_LOST");
        session.state = input.to;
        session.updatedAt = input.now.toISOString();
        session.lastActivityAt = input.now.toISOString();
        return session;
      },
    },
    lifecycle: {
      async terminateViewerSession(input) {
        terminations.push(input.reason);
        if (terminationFailure === "before_terminal") {
          throw new Error("terminal transition unavailable");
        }
        if (terminationFailure === "after_terminal") {
          session.state = "lost";
          session.terminalReason = "BROWSER_SESSION_LOST";
          session.updatedAt = currentNow.toISOString();
          resource.cleanupRequestedAt = currentNow;
          throw new Error("machine cleanup unavailable");
        }
      },
    },
    access: { async authorize() { return fixture.accessAllowed; } },
    tickets,
    worker,
    evidence: { emit(name, metadata) { evidence.push({ name, metadata }); } },
    privateKeyPem,
    publicKeyPem,
    appName: "browser-app",
    routerUrl: "https://router.example.test",
    now: () => currentNow,
  });
  return fixture;
}

function viewerState(
  sessionState: "ready" | "human_control",
  takeoverRequested: boolean,
  inputLeaseId?: string,
  connectionId = "connection-1",
) {
  return {
    version: "desktop_browser_viewer_state_v1" as const,
    available: true,
    threadId: "thread-1",
    projectId: "project-1",
    sessionId: "session-1",
    generation: 1,
    connectionId,
    sessionState,
    takeoverRequested,
    ...(inputLeaseId ? {
      inputLeaseId,
      inputLeaseExpiresAt: "2026-08-30T12:00:30.000Z",
      nativeHandoffActive: false,
    } : {}),
  };
}
