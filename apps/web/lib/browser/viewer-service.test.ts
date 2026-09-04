import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  HostedBrowserViewerOutcomeUnknownError,
  HostedBrowserViewerService,
} from "./viewer-service";
import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import { HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES } from "../../../../src/browser/hostedViewerProtocol.js";
import type { HostedBrowserResourceRecord } from "./store";
import type {
  HostedBrowserViewerCleanupPendingV1,
  HostedBrowserViewerCleanupScopeV1,
  HostedBrowserViewerTicketStorePort,
} from "./viewer-transient-store";
import type { HostedBrowserViewerWorkerPort } from "./viewer-worker-client";
import { resolveHostedBrowserViewerPolicyAccess } from "./viewer-composition-access";

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

test("a proven live connection retains its marker until later exact convergence", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  assert.equal(fixture.cleanupPending?.reason, "connect_unknown");
  assert.equal(fixture.liveConnections.has(connection.claims.connectionId), true);

  fixture.cleanupClearFailure = true;
  fixture.terminationFailure = "before_terminal";
  const unavailable = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  assert.deepEqual(unavailable, {
    version: "hosted_browser_viewer_route_v1",
    available: false,
    cleanupPending: true,
  });
  assert.equal(fixture.liveConnections.size, 0);
  assert.equal(fixture.session.state, "ready");

  fixture.cleanupClearFailure = false;
  fixture.terminationFailure = undefined;
  const recovered = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  assert.equal(recovered.available, true);
  assert.equal(fixture.cleanupPending, null);
});

test("return marker-clear failure blocks replacement until exact old authority converges", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.cleanupClearFailure = true;
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "return_control",
    leaseId: connection.state.inputLeaseId!,
  });
  assert.equal(fixture.session.state, "ready");
  assert.equal(fixture.cleanupPending?.scope.connectionId, connection.claims.connectionId);
  await assert.rejects(fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  }), /BROWSER_ACTION_OUTCOME_UNKNOWN/u);

  fixture.cleanupClearFailure = false;
  const replacementTicket = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const replacement = await fixture.service.connect(replacementTicket.ticket);
  assert.notEqual(replacement.claims.connectionId, connection.claims.connectionId);
  assert.equal(fixture.cleanupPending?.scope.connectionId, replacement.claims.connectionId);
});

test("authorization loss during frame delivery closes the Browser Session instead of restoring agent control", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({ organizationId: "org-1", actorId: "user-1", threadId: "thread-1" });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({ version: "hosted_browser_viewer_route_v1", type: "accept_takeover" });
  fixture.accessAllowed = false;
  await assert.rejects(connection.frame(), /BROWSER_SESSION_LOST/u);
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.liveConnections.size, 0);
});

test("an approved domain revision blocks viewer effects without destroying the session before adoption", async () => {
  const fixture = createFixture();
  const caller = { organizationId: "org-1", actorId: "user-1", threadId: "thread-1" };
  const issued = await fixture.service.mintTicket(caller);
  const connection = await fixture.service.connect(issued.ticket);
  fixture.currentAllowlistRevision = "revision-2";
  const callsBefore = fixture.workerCalls.length;

  for (const action of [
    () => connection.frame(),
    () => connection.revalidate(),
    () => connection.dispatch({ version: "hosted_browser_viewer_route_v1", type: "accept_takeover" }),
  ]) await assert.rejects(action(), /BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED/u);
  await assert.rejects(fixture.service.mintTicket(caller), /BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED/u);
  await assert.rejects(fixture.service.status(caller), /BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED/u);
  assert.equal(fixture.workerCalls.length, callsBefore);
  assert.equal(fixture.session.state, "ready");
  assert.deepEqual(fixture.terminations, []);

  // Socket settlement removes only this viewer's authority while adoption proceeds.
  await connection.disconnect();
  assert.equal(fixture.liveConnections.size, 0);
  assert.equal(fixture.cleanupPending, null);
  assert.equal(fixture.workerCalls.at(-1)?.purpose, "disconnect");
  assert.equal(fixture.session.state, "ready");
  fixture.session.effectiveAllowlistRevision = "revision-2";
  fixture.resource.proxyAuthorityRevision = "revision-2";
  const renewed = await fixture.service.mintTicket(caller);
  const reconnected = await fixture.service.connect(renewed.ticket);
  assert.equal((await reconnected.frame()).type, "frame");
  assert.deepEqual(fixture.terminations, []);
});

test("real access loss still destroys the session even during allowlist adoption", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({ organizationId: "org-1", actorId: "user-1", threadId: "thread-1" });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.currentAllowlistRevision = "revision-2";
  fixture.accessAllowed = false;
  await assert.rejects(connection.frame(), /BROWSER_SESSION_LOST/u);
  assert.equal(fixture.session.state, "lost");
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
});

test("allowlist adoption blocks takeover input without returning control to the agent", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({ organizationId: "org-1", actorId: "user-1", threadId: "thread-1" });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({ version: "hosted_browser_viewer_route_v1", type: "accept_takeover" });
  fixture.currentAllowlistRevision = "revision-2";
  await assert.rejects(connection.dispatch({
    version: "hosted_browser_viewer_route_v1", type: "input", leaseId: connection.state.inputLeaseId!,
    input: { version: "desktop_browser_viewer_input_v1", kind: "keyboard", phase: "down", key: "x" },
  }), /BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED/u);
  assert.equal(fixture.workerInputs.length, 0);
  await connection.disconnect();
  assert.equal(fixture.session.state, "human_control");
  assert.equal(fixture.liveConnections.size, 0);
  assert.deepEqual(fixture.terminations, []);
});

test("a transient authorization read failure is not converted into authority loss", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.authorizeThrows = true;

  await assert.rejects(
    connection.revalidate(),
    /transient authorization read failure/u,
  );

  assert.equal(fixture.session.state, "human_control");
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.liveConnections.size, 1);
});

test("connected Environment readiness loss exact-cleans and fail-closes", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.environmentReady = false;

  await assert.rejects(connection.revalidate(), /BROWSER_SESSION_LOST/u);

  assert.equal(fixture.session.state, "lost");
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
  assert.equal(fixture.liveConnections.size, 0);
});

test("worker loss during viewing closes the Browser Session instead of restoring agent control", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({ organizationId: "org-1", actorId: "user-1", threadId: "thread-1" });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({ version: "hosted_browser_viewer_route_v1", type: "accept_takeover" });
  fixture.workerLost = true;
  await assert.rejects(connection.frame(), /BROWSER_ENGINE_FAILURE/u);
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
  assert.equal(fixture.session.state, "lost");
});

test("ordinary agent-operation frame unavailability preserves the Browser Session", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.frameUnavailable = true;

  await assert.rejects(
    connection.frame(),
    /BROWSER_VIEWER_FRAME_UNAVAILABLE/u,
  );

  assert.equal(fixture.session.state, "ready");
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.liveConnections.size, 1);
});

test("Web accepts the raw viewer-frame boundary and exact-releases authority one byte over", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  const encodedLength = 4 * Math.ceil(HOSTED_BROWSER_VIEWER_RAW_PNG_MAX_BYTES / 3);
  fixture.frameDataBase64 = `${"A".repeat(encodedLength - 1)}=`;
  assert.equal((await connection.frame()).type, "frame");
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.liveConnections.size, 1);

  fixture.frameDataBase64 = "A".repeat(encodedLength);
  await assert.rejects(connection.frame(), /BROWSER_SESSION_LOST/u);
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.liveConnections.size, 0);
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
  assert.equal(fixture.workerCalls[1]?.action, "cleanup");
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
  assert.equal(fixture.session.state, "lost");
  assert.deepEqual(
    fixture.workerCalls.map((call) => call.action),
    ["connect", "cleanup", "cleanup"],
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

test("explicit return removes exact worker authority before durable ready", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  const returned = await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "return_control",
    leaseId: connection.state.inputLeaseId!,
  });

  assert.deepEqual(returned, {
    version: "hosted_browser_viewer_route_v1",
    type: "closed",
    reason: "returned_to_agent",
  });
  assert.equal(fixture.liveConnections.size, 0);
  assert.equal(fixture.session.state, "ready");
  assert.equal(connection.revoked, true);
});

test("failed established disconnect remains cleanup-pending and blocks ticket mint across service calls", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.disconnectLost = true;
  fixture.terminationFailure = "before_terminal";

  await assert.rejects(
    connection.disconnect(),
    (error: unknown) => error instanceof HostedBrowserViewerOutcomeUnknownError,
  );
  assert.equal(fixture.cleanupPending?.scope.connectionId, connection.claims.connectionId);
  assert.deepEqual(
    await fixture.service.status({
      organizationId: "org-1",
      actorId: "user-1",
      threadId: "thread-1",
    }),
    {
      version: "hosted_browser_viewer_route_v1",
      available: false,
      cleanupPending: true,
    },
  );
  await assert.rejects(
    fixture.service.mintTicket({
      organizationId: "org-1",
      actorId: "user-1",
      threadId: "thread-1",
    }),
    /BROWSER_ACTION_OUTCOME_UNKNOWN/u,
  );

  fixture.disconnectLost = false;
  fixture.terminationFailure = undefined;
  const convergedStatus = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  assert.equal(convergedStatus.available, true);
  assert.equal(fixture.cleanupPending, null);
  assert.equal(fixture.liveConnections.size, 0);
});

test("cleanup-marker failure prevents worker viewer authority from being created", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  fixture.cleanupMarkerFailure = true;

  await assert.rejects(
    fixture.service.connect(issued.ticket),
    /BROWSER_ACTION_OUTCOME_UNKNOWN/u,
  );

  assert.equal(fixture.session.state, "ready");
  assert.deepEqual(fixture.workerCalls, []);
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.cleanupPending, null);
});

test("a malformed worker frame revokes exact viewer authority before fail-close", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.invalidFrame = true;

  await assert.rejects(connection.frame(), /BROWSER_SESSION_LOST/u);

  assert.equal(fixture.liveConnections.size, 0);
  assert.equal(fixture.session.state, "lost");
  assert.ok(fixture.workerCalls.some((call) => call.action === "cleanup"));
});

test("a response-lost established disconnect stays pending until an idempotent cleanup proves release", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.cleanupResponseLost = true;

  await assert.rejects(
    connection.disconnect(),
    (error: unknown) => error instanceof HostedBrowserViewerOutcomeUnknownError,
  );
  assert.equal(fixture.liveConnections.size, 0);
  assert.ok(fixture.cleanupPending);
  assert.equal(
    fixture.evidence.filter((entry) =>
      JSON.stringify(entry).includes("browser_viewer_disconnected")).length,
    0,
  );

  fixture.cleanupResponseLost = false;
  const status = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  assert.equal(status.available, true);
  assert.equal(fixture.cleanupPending, null);
  assert.equal(
    fixture.evidence.filter((entry) =>
      JSON.stringify(entry).includes("browser_viewer_disconnected")).length,
    1,
  );
});

test("a frame rejection crossing ticket expiry exact-cleans without failing a human-control Session", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.crossExpiry("frame", "2026-08-30T12:01:00.000Z");

  await assert.rejects(connection.frame(), /BROWSER_SESSION_LOST/u);

  assert.equal(fixture.session.state, "human_control");
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.liveConnections.size, 0);
  assert.equal(connection.revoked, true);
  assert.ok(fixture.workerCalls.some((call) => call.action === "cleanup"));
});

test("a frame rejection crossing lease expiry exact-cleans without failing a human-control Session", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.crossExpiry("frame", "2026-08-30T12:00:30.000Z");

  await assert.rejects(connection.frame(), /BROWSER_SESSION_LOST/u);

  assert.equal(fixture.session.state, "human_control");
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.liveConnections.size, 0);
  assert.equal(connection.revoked, true);
});

for (const action of ["input", "renew"] as const) {
  test(`${action} rejection crossing lease expiry exact-cleans without failing human control`, async () => {
    const fixture = createFixture();
    const issued = await fixture.service.mintTicket({
      organizationId: "org-1",
      actorId: "user-1",
      threadId: "thread-1",
    });
    const connection = await fixture.service.connect(issued.ticket);
    await connection.dispatch({
      version: "hosted_browser_viewer_route_v1",
      type: "accept_takeover",
    });
    fixture.crossExpiry(action, "2026-08-30T12:00:30.000Z");

    await assert.rejects(
      connection.dispatch(action === "renew"
        ? {
            version: "hosted_browser_viewer_route_v1",
            type: "renew_lease",
            leaseId: connection.state.inputLeaseId!,
          }
        : {
            version: "hosted_browser_viewer_route_v1",
            type: "input",
            leaseId: connection.state.inputLeaseId!,
            input: {
              version: "desktop_browser_viewer_input_v1",
              kind: "keyboard",
              phase: "down",
              key: "x",
            },
          }),
      /BROWSER_SESSION_LOST/u,
    );

    assert.equal(fixture.session.state, "human_control");
    assert.deepEqual(fixture.terminations, []);
    assert.equal(fixture.liveConnections.size, 0);
    assert.equal(connection.revoked, true);
  });
}

test("a successful return crossing lease expiry still completes the durable ready transition", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.crossSuccess("return", "2026-08-30T12:00:30.000Z");

  const returned = await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "return_control",
    leaseId: connection.state.inputLeaseId!,
  });

  assert.equal(returned.type, "closed");
  assert.equal(fixture.session.state, "ready");
  assert.deepEqual(fixture.terminations, []);
  assert.equal(connection.revoked, true);
});

test("ticket-expired close is a proven pre-effect rejection that preserves human control", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.crossExpiry("close", "2026-08-30T12:01:00.000Z");

  await assert.rejects(
    connection.dispatch({
      version: "hosted_browser_viewer_route_v1",
      type: "close_session",
    }),
    /BROWSER_SESSION_LOST/u,
  );

  assert.equal(fixture.session.state, "human_control");
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.liveConnections.size, 0);
});

test("takeover response loss after commit is unknown and fail-closes", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.loseResponseAfter("accept");

  await assert.rejects(
    connection.dispatch({
      version: "hosted_browser_viewer_route_v1",
      type: "accept_takeover",
    }),
    /BROWSER_ENGINE_FAILURE/u,
  );

  assert.equal(fixture.session.state, "lost");
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
});

test("return response loss after commit is unknown and fail-closes", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.loseResponseAfter("return");

  await assert.rejects(
    connection.dispatch({
      version: "hosted_browser_viewer_route_v1",
      type: "return_control",
      leaseId: connection.state.inputLeaseId!,
    }),
    /BROWSER_ENGINE_FAILURE/u,
  );

  assert.equal(fixture.session.state, "lost");
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
});

for (const action of ["input", "renew"] as const) {
  test(`a successful ${action} crossing lease expiry remains an authoritative worker result`, async () => {
    const fixture = createFixture();
    const issued = await fixture.service.mintTicket({
      organizationId: "org-1",
      actorId: "user-1",
      threadId: "thread-1",
    });
    const connection = await fixture.service.connect(issued.ticket);
    await connection.dispatch({
      version: "hosted_browser_viewer_route_v1",
      type: "accept_takeover",
    });
    fixture.crossSuccess(action, "2026-08-30T12:00:30.000Z");

    const result = await connection.dispatch(action === "renew"
      ? {
          version: "hosted_browser_viewer_route_v1",
          type: "renew_lease",
          leaseId: connection.state.inputLeaseId!,
        }
      : {
          version: "hosted_browser_viewer_route_v1",
          type: "input",
          leaseId: connection.state.inputLeaseId!,
          input: {
            version: "desktop_browser_viewer_input_v1",
            kind: "keyboard",
            phase: "down",
            key: "x",
          },
        });

    assert.equal(result.type, "state");
    assert.equal(fixture.session.state, "human_control");
    assert.deepEqual(fixture.terminations, []);
    assert.equal(connection.revoked, false);
  });
}

test("proven worker cleanup survives Redis clear failure without terminalizing a healthy Session", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  await connection.dispatch({
    version: "hosted_browser_viewer_route_v1",
    type: "accept_takeover",
  });
  fixture.disconnectLost = true;
  await assert.rejects(connection.disconnect(), HostedBrowserViewerOutcomeUnknownError);
  fixture.disconnectLost = false;
  fixture.cleanupClearFailure = true;

  const pending = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });

  assert.equal(pending.cleanupPending, true);
  assert.equal(fixture.session.state, "human_control");
  assert.deepEqual(fixture.terminations, []);
  assert.equal(fixture.liveConnections.size, 0);

  fixture.cleanupClearFailure = false;
  const converged = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  assert.equal(converged.available, true);
  assert.equal(fixture.cleanupPending, null);
});

test("authority loss promotes pending cleanup and requires durable fail-close after worker cleanup", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  fixture.disconnectLost = true;
  await assert.rejects(connection.disconnect(), HostedBrowserViewerOutcomeUnknownError);
  assert.equal(fixture.cleanupPending?.reason, "connect_unknown");

  fixture.disconnectLost = false;
  fixture.accessAllowed = false;
  fixture.terminationFailure = "before_terminal";
  await assert.rejects(connection.revalidate(), /BROWSER_SESSION_LOST/u);

  assert.equal(fixture.liveConnections.size, 0);
  assert.equal(fixture.cleanupPending?.reason, "authority_loss");
  assert.equal(fixture.session.state, "ready");

  fixture.terminationFailure = undefined;
  await assert.rejects(
    fixture.service.status({
      organizationId: "org-1",
      actorId: "user-1",
      threadId: "thread-1",
    }),
    /BROWSER_SESSION_LOST/u,
  );
  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.cleanupPending, null);
});

test("an unauthorized status request reconciles exact authority loss without exposing viewer status", async () => {
  const fixture = createFixture({ requestAuthorized: false });
  fixture.cleanupPending = {
    version: "hosted_browser_viewer_cleanup_pending_v1",
    reason: "authority_loss",
    requestedAt: "2026-08-30T12:00:00.000Z",
    scope: {
      version: "hosted_browser_viewer_cleanup_scope_v1",
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      sessionId: "session-1",
      generation: 1,
      connectionId: "connection-1",
      appName: "browser-app",
      machineId: "machine-1",
    },
  };

  await assert.rejects(
    fixture.service.status({
      organizationId: "org-1",
      actorId: "replacement-user",
      threadId: "thread-1",
    }),
    /BROWSER_SESSION_LOST/u,
  );

  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.cleanupPending, null);
});

test("status rereads authority after pending reconciliation terminalizes the Session", async () => {
  const fixture = createFixture();
  fixture.cleanupPending = authorityLossPending();

  const status = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });

  assert.equal(status.available, false);
  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.cleanupPending, null);
});

test("ticket mint rereads authority after pending reconciliation terminalizes the Session", async () => {
  const fixture = createFixture();
  fixture.cleanupPending = authorityLossPending();

  await assert.rejects(
    fixture.service.mintTicket({
      organizationId: "org-1",
      actorId: "user-1",
      threadId: "thread-1",
    }),
    /BROWSER_SESSION_LOST/u,
  );

  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.cleanupPending, null);
});

test("authority loss without a marker dispatches worker fail-close before non-disclosure", async () => {
  const fixture = createFixture({ requestAuthorized: false });

  await assert.rejects(
    fixture.service.status({
      organizationId: "org-1",
      actorId: "replacement-user",
      threadId: "thread-1",
    }),
    /BROWSER_SESSION_LOST/u,
  );

  assert.equal(fixture.session.state, "lost");
  assert.ok(fixture.workerCalls.some((call) =>
    call.action === "cleanup" && call.purpose === "authority_loss"));
});

test("dual-store rejection without a marker does not claim durable authority loss and restored access may reconnect", async () => {
  const fixture = createFixture();
  fixture.accessAllowed = false;
  fixture.cleanupMarkerFailure = true;
  fixture.terminationFailure = "before_terminal";

  await assert.rejects(
    fixture.service.status({
      organizationId: "org-1",
      actorId: "user-1",
      threadId: "thread-1",
    }),
    /BROWSER_ACTION_OUTCOME_UNKNOWN/u,
  );

  assert.ok(fixture.workerCalls.some((call) =>
    call.action === "cleanup" && call.purpose === "authority_loss"));
  assert.deepEqual(fixture.terminations, ["BROWSER_SESSION_LOST"]);
  assert.equal(fixture.cleanupPending, null);
  assert.equal(fixture.session.state, "ready");

  fixture.accessAllowed = true;
  fixture.reloadService();
  const recovered = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  assert.equal(recovered.available, true);
  assert.equal(recovered.sessionId, "session-1");
});

test("dual-store rejection retains a weak live marker and restored access reconciles only its stored state", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  assert.equal(fixture.cleanupPending?.reason, "connect_unknown");

  fixture.accessAllowed = false;
  fixture.cleanupMarkerFailure = true;
  fixture.terminationFailure = "before_terminal";
  await assert.rejects(
    connection.revalidate(),
    HostedBrowserViewerOutcomeUnknownError,
  );
  assert.equal(fixture.cleanupPending?.reason, "connect_unknown");
  assert.equal(fixture.session.state, "ready");
  assert.equal(fixture.liveConnections.size, 0);

  fixture.accessAllowed = true;
  fixture.reloadService();
  const recovered = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  assert.equal(recovered.available, true);
  assert.equal(recovered.sessionId, "session-1");
  assert.equal(fixture.cleanupPending, null);
});

test("a proven connected marker never becomes ordinary availability through Redis and PostgreSQL outage recovery", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.mintTicket({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });
  const connection = await fixture.service.connect(issued.ticket);
  assert.equal(fixture.cleanupPending?.reason, "connect_unknown");

  fixture.accessAllowed = false;
  fixture.cleanupMarkerFailure = true;
  fixture.terminationFailure = "before_terminal";
  await assert.rejects(
    connection.revalidate(),
    HostedBrowserViewerOutcomeUnknownError,
  );
  assert.equal(fixture.cleanupPending?.reason, "connect_unknown");
  assert.equal(fixture.liveConnections.size, 0);
  fixture.reloadService();
  await assert.rejects(fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  }), /BROWSER_ACTION_OUTCOME_UNKNOWN/u);

  fixture.cleanupMarkerFailure = false;
  await assert.rejects(fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  }), /BROWSER_SESSION_LOST/u);
  assert.equal(fixture.cleanupPending?.reason, "authority_loss");
  assert.equal(fixture.session.state, "ready");

  fixture.terminationFailure = undefined;
  await assert.rejects(fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  }), /BROWSER_SESSION_LOST/u);
  assert.equal(fixture.session.state, "lost");
  assert.equal(fixture.cleanupPending, null);
});

test("a terminal Session clears its pending marker even without an active authority", async () => {
  const fixture = createFixture();
  fixture.session.state = "lost";
  fixture.session.terminalReason = "BROWSER_SESSION_LOST";
  fixture.resource.cleanupRequestedAt = new Date("2026-08-30T12:00:00.000Z");
  fixture.cleanupPending = {
    version: "hosted_browser_viewer_cleanup_pending_v1",
    reason: "authority_loss",
    requestedAt: "2026-08-30T12:00:00.000Z",
    scope: {
      version: "hosted_browser_viewer_cleanup_scope_v1",
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      sessionId: "session-1",
      generation: 1,
      connectionId: "connection-1",
      appName: "browser-app",
      machineId: "machine-1",
    },
  };

  const status = await fixture.service.status({
    organizationId: "org-1",
    actorId: "user-1",
    threadId: "thread-1",
  });

  assert.equal(status.available, false);
  assert.equal(fixture.cleanupPending, null);
});

function createFixture(options: { requestAuthorized?: boolean } = {}) {
  let currentNow = new Date("2026-08-30T12:00:00.000Z");
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
  let cleanupPending: Awaited<ReturnType<HostedBrowserViewerTicketStorePort["readCleanupPending"]>> = null;
  let cleanupMarkerFailure = false;
  let cleanupClearFailure = false;
  let cleanupResponseLost = false;
  const tickets: HostedBrowserViewerTicketStorePort = {
    async issue(input) { ticketValues.set(input.nonce, input.token); },
    async consume(input) {
      if (ticketValues.get(input.nonce) !== input.token) return false;
      ticketValues.delete(input.nonce);
      return true;
    },
    async revoke(nonce) { ticketValues.delete(nonce); },
    async readCleanupPending(threadId) {
      return cleanupPending?.scope.threadId === threadId ? cleanupPending : null;
    },
    async markCleanupPending(input) {
      if (cleanupMarkerFailure) throw new Error("redis unavailable");
      if (cleanupPending && !sameTestCleanupScope(cleanupPending.scope, input.scope)) {
        throw new Error("BROWSER_ACTION_OUTCOME_UNKNOWN");
      }
      if (!cleanupPending || input.reason === "authority_loss") {
        cleanupPending = input;
      }
      return cleanupPending;
    },
    async clearCleanupPending(expected) {
      if (cleanupClearFailure) throw new Error("redis unavailable");
      if (JSON.stringify(cleanupPending) !== JSON.stringify(expected)) return false;
      cleanupPending = null;
      return true;
    },
  };
  const workerInputs: Array<{ text?: string }> = [];
  const workerCalls: Array<{
    action: string;
    connectionId?: string;
    purpose?: "disconnect" | "authority_loss";
  }> = [];
  const liveConnections = new Set<string>();
  let workerLost = false;
  let frameUnavailable = false;
  let connectResponseLost = false;
  let disconnectLost = false;
  let invalidConnectState = false;
  let invalidFrame = false;
  let frameDataBase64 = "iVBORw0KGgo=";
  let authorizeThrows = false;
  let environmentReady = true;
  let crossExpiryAction: string | undefined;
  let crossExpiryAt: Date | undefined;
  let crossSuccessAction: string | undefined;
  let crossSuccessAt: Date | undefined;
  let responseLostAfterAction: string | undefined;
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
      if (frameUnavailable && input.action === "frame") {
        throw new Error("BROWSER_VIEWER_FRAME_UNAVAILABLE");
      }
      if (workerLost) throw new Error("BROWSER_ENGINE_FAILURE");
      if (crossExpiryAction === input.action && crossExpiryAt) {
        currentNow = crossExpiryAt;
        liveConnections.delete(input.connectionId!);
        throw new Error("BROWSER_VIEWER_AUTHORITY_EXPIRED");
      }
      if (crossSuccessAction === input.action && crossSuccessAt) {
        currentNow = crossSuccessAt;
      }
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
        sessionId: invalidFrame ? "identity-drifted" : "session-1",
        generation: 1,
        sequence: 1,
        capturedAt: currentNow.toISOString(),
        mediaType: "image/png",
        dataBase64: frameDataBase64,
      };
      if (input.action === "accept") {
        workerState = viewerState(
          "human_control",
          false,
          "lease-1",
          workerState.connectionId,
        );
        if (responseLostAfterAction === input.action) {
          throw new Error("BROWSER_ENGINE_FAILURE");
        }
        return workerState;
      }
      if (input.action === "input") {
        workerInputs.push({ text: input.viewerInput?.kind === "keyboard" ? input.viewerInput.text : undefined });
        return workerState;
      }
      if (input.action === "renew") return workerState;
      if (input.action === "return") {
        liveConnections.delete(input.connectionId!);
        workerState = viewerState(
          "ready",
          false,
          undefined,
          workerState.connectionId,
        );
        if (responseLostAfterAction === input.action) {
          throw new Error("BROWSER_ENGINE_FAILURE");
        }
        return workerState;
      }
      return null;
    },
    async cleanup(input) {
      workerCalls.push({
        action: "cleanup",
        connectionId: input.connectionId,
        purpose: input.purpose,
      });
      if (workerLost || disconnectLost) throw new Error("BROWSER_ENGINE_FAILURE");
      liveConnections.delete(input.connectionId);
      if (cleanupResponseLost) throw new Error("BROWSER_ENGINE_FAILURE");
    },
  };
  const evidence: unknown[] = [];
  const terminations: string[] = [];
  let buildService: () => HostedBrowserViewerService;
  const fixture = {
    session,
    workerInputs,
    evidence,
    terminations,
    workerCalls,
    liveConnections,
    resource,
    accessAllowed: true,
    currentAllowlistRevision: "revision-1",
    get authorizeThrows() { return authorizeThrows; },
    set authorizeThrows(value) { authorizeThrows = value; },
    get environmentReady() { return environmentReady; },
    set environmentReady(value) { environmentReady = value; },
    get workerState() { return workerState; },
    set workerState(value) { workerState = value; },
    get workerLost() { return workerLost; },
    set workerLost(value) { workerLost = value; },
    get frameUnavailable() { return frameUnavailable; },
    set frameUnavailable(value) { frameUnavailable = value; },
    get frameDataBase64() { return frameDataBase64; },
    set frameDataBase64(value) { frameDataBase64 = value; },
    get connectResponseLost() { return connectResponseLost; },
    set connectResponseLost(value) { connectResponseLost = value; },
    get disconnectLost() { return disconnectLost; },
    set disconnectLost(value) { disconnectLost = value; },
    get invalidConnectState() { return invalidConnectState; },
    set invalidConnectState(value) { invalidConnectState = value; },
    get invalidFrame() { return invalidFrame; },
    set invalidFrame(value) { invalidFrame = value; },
    get terminationFailure() { return terminationFailure; },
    set terminationFailure(value) { terminationFailure = value; },
    get cleanupPending() { return cleanupPending; },
    set cleanupPending(value) { cleanupPending = value; },
    get cleanupMarkerFailure() { return cleanupMarkerFailure; },
    set cleanupMarkerFailure(value) { cleanupMarkerFailure = value; },
    get cleanupClearFailure() { return cleanupClearFailure; },
    set cleanupClearFailure(value) { cleanupClearFailure = value; },
    get cleanupResponseLost() { return cleanupResponseLost; },
    set cleanupResponseLost(value) { cleanupResponseLost = value; },
    crossExpiry(action: string, at: string) {
      crossExpiryAction = action;
      crossExpiryAt = new Date(at);
    },
    crossSuccess(action: string, at: string) {
      crossSuccessAction = action;
      crossSuccessAt = new Date(at);
    },
    loseResponseAfter(action: string) {
      responseLostAfterAction = action;
    },
    reloadService() {
      fixture.service = buildService();
    },
    service: undefined as unknown as HostedBrowserViewerService,
  };
  buildService = () => new HostedBrowserViewerService({
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
        session.state = input.reason === "closed_by_user" ? "closed" : "lost";
        session.terminalReason = input.reason;
        session.updatedAt = currentNow.toISOString();
        resource.cleanupRequestedAt = currentNow;
      },
    },
    access: {
      async authorize() {
        if (authorizeThrows) throw new Error("transient authorization read failure");
        return fixture.accessAllowed && environmentReady &&
          resolveHostedBrowserViewerPolicyAccess({
            origin: { environmentId: "env-1", projectId: "project-1", userId: "user-1" },
            session,
            current: {
              decision: "allow",
              environmentId: "env-1",
              projectId: "project-1",
              userId: "user-1",
              effectiveAllowlistRevision: fixture.currentAllowlistRevision,
            },
          });
      },
    },
    tickets,
    worker,
    evidence: { emit(name, metadata) { evidence.push({ name, metadata }); } },
    privateKeyPem,
    publicKeyPem,
    appName: "browser-app",
    routerUrl: "https://router.example.test",
    requestAuthorized: options.requestAuthorized ?? true,
    now: () => currentNow,
  });
  fixture.service = buildService();
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

function sameTestCleanupScope(
  left: HostedBrowserViewerCleanupScopeV1,
  right: HostedBrowserViewerCleanupScopeV1,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function authorityLossPending(): HostedBrowserViewerCleanupPendingV1 {
  return {
    version: "hosted_browser_viewer_cleanup_pending_v1",
    reason: "authority_loss",
    requestedAt: "2026-08-30T12:00:00.000Z",
    scope: {
      version: "hosted_browser_viewer_cleanup_scope_v1",
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      sessionId: "session-1",
      generation: 1,
      connectionId: "connection-1",
      appName: "browser-app",
      machineId: "machine-1",
    },
  };
}
