import assert from "node:assert/strict";
import test from "node:test";

import {
  DesktopBrowserViewerAuthorityCoordinator,
  type DesktopBrowserViewerPrincipal,
} from "../src/browserViewerAuthority.js";

test("viewer authority loss survives an outage and blocks replacement until exact recovery", async () => {
  const lost: DesktopBrowserViewerPrincipal[] = [];
  let localCoreAvailable = false;
  const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
    async loseAuthority(principal) {
      lost.push(principal);
      if (!localCoreAvailable) throw new Error("Local Core unavailable");
    },
  });
  await connect(coordinator, principal());

  await coordinator.loseCurrent({
    expectedSenderId: 41,
    reason: "renderer_crashed",
    bestEffort: true,
  });
  assert.deepEqual(coordinator.snapshot(), {
    current: principal(),
    pending: { principal: principal(), reason: "renderer_crashed" },
  });

  let replacementConnects = 0;
  await assert.rejects(
    coordinator.connect({
      senderId: 52,
      principalId: "desktop-main-52-2",
      threadId: "thread-1",
      projectId: "project-1",
      async connect() {
        replacementConnects += 1;
        return { value: "connected" };
      },
    }),
    /Local Core unavailable/u,
  );
  assert.equal(replacementConnects, 0);

  localCoreAvailable = true;
  await coordinator.retryPending();
  assert.deepEqual(coordinator.snapshot(), {
    current: undefined,
    pending: undefined,
  });
  await coordinator.connect({
    senderId: 52,
    principalId: "desktop-main-52-2",
    threadId: "thread-1",
    projectId: "project-1",
    async connect() {
      replacementConnects += 1;
      return { value: "connected" };
    },
  });
  assert.equal(replacementConnects, 1);
  assert.deepEqual(lost, [principal(), principal(), principal()]);
});

test("concurrent replacement connection waits for one exact pending loss", async () => {
  let releaseLoss: (() => void) | undefined;
  const losing = new Promise<void>((resolve) => {
    releaseLoss = resolve;
  });
  const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
    async loseAuthority() {
      await losing;
    },
  });
  await connect(coordinator, principal());

  const cleanup = coordinator.loseCurrent({
    reason: "renderer_restarted",
    bestEffort: true,
  });
  let replacementConnects = 0;
  const replacement = coordinator.connect({
    senderId: 52,
    principalId: "desktop-main-52-2",
    threadId: "thread-1",
    projectId: "project-1",
    async connect() {
      replacementConnects += 1;
      return { value: "connected" };
    },
  });
  await Promise.resolve();
  assert.equal(replacementConnects, 0);
  releaseLoss?.();
  await cleanup;
  await replacement;
  assert.equal(replacementConnects, 1);
});

test("same renderer cannot replace a retained principal through generation drift", async () => {
  const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
    async loseAuthority() {},
  });
  await connect(coordinator, principal());
  await assert.rejects(
    connect(coordinator, principal({ generation: 2, connectionId: "connection-2" })),
    /connection identity changed/u,
  );
  assert.deepEqual(coordinator.snapshot(), {
    current: principal(),
    pending: undefined,
  });
});

test("a terminal g1 proof clears only g1 before a later connect installs active g2", async () => {
  const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
    async loseAuthority() {},
  });
  const generationOne = principal();
  await connect(coordinator, generationOne);
  const available = await coordinator.connect({
    senderId: 41,
    principalId: "desktop-main-41-1",
    threadId: "thread-1",
    projectId: "project-1",
    async connect(expected) {
      assert.deepEqual(expected, generationOne);
      return { value: false, previousSessionTerminal: true };
    },
  });
  assert.equal(available, false);
  assert.equal(coordinator.current(), undefined);
  const generationTwo = principal({
    sessionId: "browser-session-2",
    generation: 2,
    connectionId: "connection-2",
  });
  await connect(coordinator, generationTwo);
  assert.deepEqual(coordinator.current(), generationTwo);
});

test("explicit disconnect failure retains exact authority for retry", async () => {
  const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
    async loseAuthority() {},
  });
  const exact = principal();
  await connect(coordinator, exact);
  await assert.rejects(
    coordinator.releaseCurrent(exact, async () => {
      throw new Error("disconnect unavailable");
    }),
    /disconnect unavailable/u,
  );
  assert.deepEqual(coordinator.current(), exact);
  await coordinator.releaseCurrent(exact, async () => {});
  assert.equal(coordinator.current(), undefined);
});

async function connect(
  coordinator: DesktopBrowserViewerAuthorityCoordinator,
  exact: DesktopBrowserViewerPrincipal,
): Promise<void> {
  await coordinator.connect({
    senderId: exact.senderId,
    principalId: exact.principalId,
    threadId: exact.threadId,
    projectId: exact.projectId,
    async connect() {
      return { value: undefined, principal: exact };
    },
  });
}

function principal(
  input: Partial<DesktopBrowserViewerPrincipal> = {},
): DesktopBrowserViewerPrincipal {
  return {
    senderId: 41,
    principalId: "desktop-main-41-1",
    threadId: "thread-1",
    projectId: "project-1",
    sessionId: "browser-session-1",
    generation: 1,
    connectionId: "connection-1",
    ...input,
  };
}
