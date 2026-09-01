import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  DesktopBrowserViewerAuthorityCoordinator,
  sameDesktopBrowserViewerPrincipal,
  type DesktopBrowserViewerPrincipal,
} from "../src/browserViewerAuthority.js";
import { DesktopBrowserViewerAuthorityJournal } from "../src/browserViewerAuthorityJournal.js";

test("viewer reconnect identity must exactly match retained authority", () => {
  const exact = principal();
  assert.equal(sameDesktopBrowserViewerPrincipal(exact, { ...exact }), true);
  assert.equal(
    sameDesktopBrowserViewerPrincipal(exact, {
      ...exact,
      connectionId: "connection-drift",
    }),
    false,
  );
  assert.equal(sameDesktopBrowserViewerPrincipal(undefined, exact), false);
});

test("restart revokes retained exact authority before a reused sender and bootstrap connect", async (t) => {
  const fixture = await journalFixture(t);
  const exact = principal();
  let survivingLocalCoreAuthority: DesktopBrowserViewerPrincipal | undefined;
  const beforeRestart = new DesktopBrowserViewerAuthorityCoordinator({
    journal: fixture.journal(),
    async loseAuthority() {
      throw new Error("Desktop quit before Local Core cleanup");
    },
  });
  await beforeRestart.connect({
    senderId: exact.senderId,
    principalId: exact.principalId,
    threadId: exact.threadId,
    projectId: exact.projectId,
    async connect() {
      survivingLocalCoreAuthority = exact;
      return { value: undefined, principal: exact };
    },
  });
  await beforeRestart.loseCurrent({
    reason: "renderer_crashed",
    bestEffort: true,
  });

  const events: string[] = [];
  const restarted = new DesktopBrowserViewerAuthorityCoordinator({
    journal: fixture.journal(),
    async loseAuthority(retained, reason) {
      events.push(`lost:${reason}`);
      assert.deepEqual(retained, exact);
      assert.deepEqual(survivingLocalCoreAuthority, exact);
      survivingLocalCoreAuthority = undefined;
    },
  });
  const replacement = principal({
    sessionId: "browser-session-2",
    generation: 2,
    connectionId: "connection-2",
  });
  await restarted.connect({
    // Electron can reuse both values after a process restart. They are not
    // sufficient to inherit the retained Local Core connection.
    senderId: exact.senderId,
    principalId: exact.principalId,
    threadId: exact.threadId,
    projectId: exact.projectId,
    async connect(expected) {
      events.push("replacement-connected");
      assert.equal(expected, undefined);
      assert.equal(survivingLocalCoreAuthority, undefined);
      survivingLocalCoreAuthority = replacement;
      return { value: undefined, principal: replacement };
    },
  });

  assert.deepEqual(events, ["lost:renderer_crashed", "replacement-connected"]);
  assert.deepEqual(restarted.current(), replacement);
});

test("an abrupt restart converts durable current authority to pending desktop loss", async (t) => {
  const fixture = await journalFixture(t);
  const beforeRestart = new DesktopBrowserViewerAuthorityCoordinator({
    journal: fixture.journal(),
    async loseAuthority() {},
  });
  await connect(beforeRestart, principal());

  const losses: Array<{
    principal: DesktopBrowserViewerPrincipal;
    reason: string;
  }> = [];
  const restarted = new DesktopBrowserViewerAuthorityCoordinator({
    journal: fixture.journal(),
    async loseAuthority(retained, reason) {
      losses.push({ principal: retained, reason });
    },
  });
  await restarted.retryPending();
  assert.deepEqual(losses, [
    { principal: principal(), reason: "desktop_stopped" },
  ]);
  assert.deepEqual(restarted.snapshot(), {
    current: undefined,
    pending: undefined,
  });

  const anotherRestart = new DesktopBrowserViewerAuthorityCoordinator({
    journal: fixture.journal(),
    async loseAuthority() {
      assert.fail("confirmed exact loss must clear the durable journal");
    },
  });
  await anotherRestart.retryPending();
});

test("post-unlink directory sync failure converges and a restored stale record retries only exact loss", async (t) => {
  const fixture = await journalFixture(t);
  const exact = principal();
  const durable = fixture.journal();
  await durable.recordCurrent(exact);
  await durable.recordPending(exact, "renderer_crashed");
  const staleRecord = await readFile(fixture.journalPath, "utf8");

  let syncAttempts = 0;
  const postUnlinkFailure = new DesktopBrowserViewerAuthorityJournal(
    fixture.journalPath,
    {
      async syncDirectory() {
        syncAttempts += 1;
        throw new Error("injected post-unlink directory sync failure");
      },
    },
  );
  await assert.doesNotReject(postUnlinkFailure.clear(exact));
  assert.equal(syncAttempts, 1);
  assert.equal(await durable.load(), undefined);

  // A crash may expose the pre-sync directory entry again. It carries only
  // the old exact principal and therefore can retry that idempotent loss; it
  // cannot authorize a replacement connection.
  await fixture.writeRaw(staleRecord);
  const losses: DesktopBrowserViewerPrincipal[] = [];
  const restarted = new DesktopBrowserViewerAuthorityCoordinator({
    journal: fixture.journal(),
    async loseAuthority(retained, reason) {
      assert.equal(reason, "renderer_crashed");
      losses.push(retained);
    },
  });
  await restarted.retryPending();
  assert.deepEqual(losses, [exact]);
  assert.deepEqual(restarted.snapshot(), {
    current: undefined,
    pending: undefined,
  });
  assert.equal(await fixture.journal().load(), undefined);

  const anotherRestart = new DesktopBrowserViewerAuthorityCoordinator({
    journal: fixture.journal(),
    async loseAuthority() {
      assert.fail("converged exact loss must not be replayed again");
    },
  });
  await anotherRestart.retryPending();
});

test("malformed, partial, and identity-drifted journals fail closed", async (t) => {
  const cases: Array<{ name: string; source: string }> = [
    { name: "malformed", source: "{" },
    {
      name: "partial",
      source: JSON.stringify({ version: 1, current: principal() }),
    },
    {
      name: "drifted",
      source: JSON.stringify({
        version: 1,
        current: principal(),
        pendingLoss: {
          principal: principal({ sessionId: "another-session" }),
          reason: "renderer_crashed",
        },
      }),
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const fixture = await journalFixture(subtest);
      await fixture.writeRaw(entry.source);
      let losses = 0;
      let connects = 0;
      const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
        journal: fixture.journal(),
        async loseAuthority() {
          losses += 1;
        },
      });
      await assert.rejects(
        coordinator.connect({
          senderId: 41,
          principalId: "desktop-main-41-1",
          threadId: "thread-1",
          projectId: "project-1",
          async connect() {
            connects += 1;
            return { value: undefined, principal: principal() };
          },
        }),
        /viewer authority/u,
      );
      assert.equal(losses, 0);
      assert.equal(connects, 0);
    });
  }
});

test("symlinked and over-permissive journals fail closed", async (t) => {
  await t.test("symlinked", async (subtest) => {
    const fixture = await journalFixture(subtest);
    const targetPath = path.join(fixture.rootPath, "outside.json");
    await writeFile(targetPath, "{}", { mode: 0o600 });
    await mkdir(path.dirname(fixture.journalPath), {
      recursive: true,
      mode: 0o700,
    });
    await symlink(targetPath, fixture.journalPath);
    const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
      journal: fixture.journal(),
      async loseAuthority() {
        assert.fail("invalid journal must not change another Session");
      },
    });
    await assert.rejects(coordinator.retryPending(), /journal/u);
  });

  if (process.platform !== "win32") {
    await t.test("over-permissive", async (subtest) => {
      const fixture = await journalFixture(subtest);
      await fixture.journal().recordCurrent(principal());
      await chmod(fixture.journalPath, 0o644);
      const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
        journal: fixture.journal(),
        async loseAuthority() {
          assert.fail("invalid journal must not change another Session");
        },
      });
      await assert.rejects(coordinator.retryPending(), /journal/u);
    });
  }
});

test("a viewer created while exact persistence fails is immediately revoked", async (t) => {
  if (process.platform === "win32") return;
  const fixture = await journalFixture(t);
  const revoked: DesktopBrowserViewerPrincipal[] = [];
  const coordinator = new DesktopBrowserViewerAuthorityCoordinator({
    journal: fixture.journal(),
    async loseAuthority(retained, reason) {
      assert.equal(reason, "desktop_stopped");
      revoked.push(retained);
    },
  });
  await assert.rejects(
    coordinator.connect({
      senderId: 41,
      principalId: "desktop-main-41-1",
      threadId: "thread-1",
      projectId: "project-1",
      async connect() {
        await chmod(path.dirname(fixture.journalPath), 0o755);
        return { value: undefined, principal: principal() };
      },
    }),
    /journal/u,
  );
  assert.deepEqual(revoked, [principal()]);
  assert.equal(coordinator.current(), undefined);
});

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
    connect(
      coordinator,
      principal({ generation: 2, connectionId: "connection-2" }),
    ),
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

async function journalFixture(t: TestContext): Promise<{
  rootPath: string;
  journalPath: string;
  journal(): DesktopBrowserViewerAuthorityJournal;
  writeRaw(source: string): Promise<void>;
}> {
  const rootPath = await mkdtemp(
    path.join(os.tmpdir(), "kestrel-browser-viewer-authority-"),
  );
  t.after(async () => await rm(rootPath, { recursive: true, force: true }));
  const journalPath = path.join(
    rootPath,
    "desktop-private",
    "browser-viewer-authority.json",
  );
  return {
    rootPath,
    journalPath,
    journal: () => new DesktopBrowserViewerAuthorityJournal(journalPath),
    async writeRaw(source) {
      await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
      await writeFile(journalPath, source, { mode: 0o600 });
      // Verify fixtures do not accidentally gain a newline or normalization.
      assert.equal(await readFile(journalPath, "utf8"), source);
    },
  };
}
