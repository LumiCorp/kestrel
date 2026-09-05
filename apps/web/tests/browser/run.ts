import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../../../src/browser/runtimeReleaseManifest.js";

assert.equal(
  process.platform,
  "linux",
  "Run via pnpm validate:browser (isolated Linux container)",
);
assert.equal(
  new URL(process.env.DATABASE_URL!).hostname,
  "postgres",
  "only disposable test PostgreSQL is allowed",
);
const root = await mkdtemp(path.join(os.tmpdir(), "browser-suite-"));
process.env.STORAGE_PROVIDER = "local";
process.env.STORAGE_LOCAL_ROOT = path.join(root, "files");
Reflect.deleteProperty(process.env, "POSTGRES_URL");
const db = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  await eventually(async () => {
    await db`SELECT 1`;
  });
  for (const script of ["lib/db/migrate.ts", "lib/db/contract-migrate.ts"]) {
    execFileSync(process.execPath, ["--import", "tsx", script], {
      stdio: "inherit",
      env: process.env,
    });
  }
  const { createHarness } = await import("./harness.js");
  const selected = process.argv[2] === "--case" ? process.argv[3] : undefined;
  const cases = {
    grant: grantCase,
    browse: browseCase,
    takeover: takeoverCase,
    upload: uploadCase,
    transfers: transfersCase,
    cleanup: cleanupCase,
  };
  const failures: string[] = [];
  assert.ok(!selected || selected in cases, "unknown Browser case");
  console.info("[browser-test] candidate", {
    revision: process.env.BROWSER_TEST_REVISION,
    testImageId: process.env.BROWSER_TEST_IMAGE_ID,
    engine: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
    chrome: BROWSER_RUNTIME_RELEASE_MANIFEST.chrome.revision,
    boundary: "connected local Browser services; no Thread UI or cloud hosting",
  });
  for (const [name, scenario] of Object.entries(cases)) {
    if (selected && selected !== name) continue;
    const started = Date.now();
    console.info(`[browser-test] ${name}: starting`);
    // A watchdog for broken test/cleanup code, not a sleep or production timer.
    const watchdog = setTimeout(() => {
      console.error(`[browser-test] ${name}: test exceeded 180 seconds`);
      process.exit(1);
    }, 180_000);
    let harness: Harness | undefined;
    let failure: unknown;
    try {
      harness = await createHarness();
      await scenario(harness);
    } catch (error) {
      failure = error;
      console.error(`[browser-test] ${name}: FAILED`, error);
    } finally {
      try {
        await harness?.close();
      } catch (error) {
        failure ??= error;
        console.error(`[browser-test] ${name}: CLEANUP FAILED`, error);
      }
      clearTimeout(watchdog);
    }
    if (failure) failures.push(name);
    else
      console.info(
        `[browser-test] ${name}: passed (${Date.now() - started}ms), cleanup passed`,
      );
  }
  if (failures.length)
    throw new Error(`Connected Browser suite failed: ${failures.join(", ")}`);
} finally {
  const { resetDbRuntimeForTests } = await import("../../lib/db/runtime.js");
  await resetDbRuntimeForTests();
  await db.end({ timeout: 0 });
  await rm(root, { recursive: true, force: true });
}

type Harness = Awaited<ReturnType<typeof import("./harness.js").createHarness>>;
async function open(h: Harness) {
  await h.call("browser.open", {
    mode: "operator",
    target: { kind: "public_url", url: "https://example.com/" },
  });
  assert.equal(h.session.state, "ready");
}
async function grantCase(h: Harness) {
  await open(h);
  const identity = {
    sessionId: h.session.sessionId,
    generation: h.session.generation,
  };
  const viewer = await h.viewer();
  await eventually(() =>
    assert.ok(viewer.messages.some((message) => message.type === "frame")),
  );
  const prepared = await h.prepare("browser.request_grant", {
    destination: "https://example.net/",
  });
  assert.equal(prepared.policy.decision, "approval_required");
  // The approval helper persists and resolves the real production interaction.
  const { approve } = await import("./approval.js");
  await approve(h, prepared, "remember_approval");
  // Deliberately let the real viewer observe the committed grant before worker
  // adoption. This catches the race without an arbitrary timing sleep.
  await eventually(() =>
    assert.ok(
      h.events.some(
        (event) =>
          (event as { name?: string }).name === "viewer_adoption_pending",
      ),
    ),
  );
  assert.equal(
    viewer.socket.readyState,
    1,
    "viewer must remain connected during grant adoption",
  );
  await h.execute(prepared);
  const remembered =
    await h.sql`SELECT canonical_domain, status FROM browser_personal_domains WHERE organization_id = ${h.ids.organizationId} AND user_id = ${h.ids.userId}`;
  assert.deepEqual(
    remembered.map((row) => ({ ...row })),
    [{ canonical_domain: "example.net", status: "active" }],
  );
  const current = (await h.store.read(identity.sessionId))!.session;
  assert.equal(
    h.registry.requireSession(identity).effectiveAllowlistRevision,
    current.effectiveAllowlistRevision,
  );
  assert.equal(current.generation, identity.generation);
  await h.call("browser.navigate", {
    kind: "url",
    url: "https://example.net/",
  });
  assert.match(
    String((await h.call("browser.snapshot")).content),
    /Connected Browser fixture/u,
  );
  const count =
    await h.sql`SELECT request_id, source, kind, request_envelope->>'version' AS version FROM thread_interactions WHERE thread_id = ${h.ids.threadId}`;
  assert.equal(count.length, 1, JSON.stringify(count));
  const beforeNavigation = viewer.messages.length;
  await h.call("browser.navigate", {
    kind: "url",
    url: "https://example.net/again",
  });
  const afterNavigation =
    await h.sql`SELECT request_id, source, kind, request_envelope->>'version' AS version FROM thread_interactions WHERE thread_id = ${h.ids.threadId}`;
  assert.equal(
    afterNavigation.length,
    count.length,
    JSON.stringify(afterNavigation),
  );
  assert.equal(
    viewer.socket.readyState,
    1,
    "viewer must remain connected after grant adoption",
  );
  await eventually(() =>
    assert.ok(
      viewer.messages
        .slice(beforeNavigation)
        .some((message) => message.type === "frame"),
    ),
  );
  await h.call("browser.close");
}
async function browseCase(h: Harness) {
  await open(h);
  const tabs = await h.call("browser.tabs", { operation: "list" });
  assert.equal(typeof tabs.activeTabId, "string");
  // Exact production failure: the model invented a starting cursor on its first read.
  await assert.rejects(
    h.call("browser.snapshot", { tabId: tabs.activeTabId, scope: "document", cursor: "0" }),
    /BROWSER_TARGET_STALE/u,
  );
  const snapshot = await h.call("browser.snapshot", { tabId: tabs.activeTabId, cursor: null });
  assert.match(String(snapshot.content), /Connected Browser fixture/u);
  assert.match(
    String(
      (await h.call("browser.inspect", { kind: "accessibility" })).content,
    ),
    /Connected Browser fixture/u,
  );
  await interact(h, "Change status", "click");
  assert.match(
    String((await h.call("browser.snapshot")).content),
    /Clicked successfully/u,
  );
  await interact(h, "Message", "fill", "non-secret fixture message");
  await interact(h, "Submit message", "click");
  await eventually(() =>
    assert.deepEqual(h.site.submissions, ["non-secret fixture message"]),
  );
  assert.match(
    String((await h.call("browser.snapshot")).content),
    /Submitted successfully/u,
  );
  const screenshot = await h.call("browser.capture", { kind: "screenshot" });
  const bytes = await artifactBytes(h, screenshot.artifact.id);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    screenshot.artifact.sha256,
  );
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, "png");
  assert.ok(
    metadata.width &&
      metadata.width > 0 &&
      metadata.height &&
      metadata.height > 0,
  );
  await h.call("browser.close");
}
async function takeoverCase(h: Harness) {
  await open(h);
  const viewer = await h.viewer();
  await eventually(() =>
    assert.ok(viewer.messages.some((message) => message.type === "frame")),
  );
  await h.call("browser.request_takeover", {
    reason: "Enter synthetic local-test credentials",
  });
  viewer.send({ type: "accept_takeover" });
  const state = await eventually(() => {
    const message = viewer.messages.findLast(
      (message) =>
        message.type === "state" &&
        message.state.sessionState === "human_control",
    );
    assert.ok(message?.type === "state" && message.state.inputLeaseId);
    return message.state;
  });
  const sentinels = { password: "BrowserTestSecret-P9x", otp: "581932", note: "PrivateHumanNote-Q7" };
  for (const [name, value, y] of [
    ["password", sentinels.password, 334],
    ["otp", sentinels.otp, 404],
    ["note", sentinels.note, 474],
  ] as const) {
    for (const phase of ["down", "up"])
      viewer.send({
        type: "input",
        leaseId: state.inputLeaseId,
        input: {
          version: "desktop_browser_viewer_input_v1",
          kind: "pointer",
          phase,
          x: 90,
          y,
          button: "left",
        },
      });
    for (const key of value) {
      viewer.send({
        type: "input",
        leaseId: state.inputLeaseId,
        input: {
          version: "desktop_browser_viewer_input_v1",
          kind: "keyboard",
          phase: "down",
          key,
          text: key,
        },
      });
      viewer.send({
        type: "input",
        leaseId: state.inputLeaseId,
        input: {
          version: "desktop_browser_viewer_input_v1",
          kind: "keyboard",
          phase: "up",
          key,
        },
      });
    }
    await eventually(() =>
      assert.equal(
        h.site.secretProofs[name],
        createHash("sha256").update(value).digest("hex"),
      ),
    );
  }
  const dispatches = h.events.length;
  await assert.rejects(
    h.call("browser.navigate", {
      kind: "url",
      url: "https://example.com/agent-must-not-navigate",
    }),
    /BROWSER_SESSION_CONFLICT|BROWSER_HUMAN_CONTROL/u,
  );
  assert.equal(
    h.events
      .slice(dispatches)
      .some((event) => (event as { name?: string }).name === "dispatch"),
    false,
  );
  const beforeReturn = viewer.messages.length;
  viewer.send({ type: "return_control", leaseId: state.inputLeaseId });
  await eventually(() =>
    assert.ok(
      viewer.messages
        .slice(beforeReturn)
        .some(
          (message) =>
            message.type === "closed" && message.reason === "returned_to_agent",
        ),
    ),
  );
  assert.equal(
    (await h.store.read(h.session.sessionId))!.session.state,
    "ready",
  );
  await h.call("browser.snapshot");
  await h.call("browser.navigate", {
    kind: "url",
    url: "https://example.com/after-takeover",
  });
  const resumedViewer = await h.viewer();
  await eventually(() =>
    assert.ok(
      resumedViewer.messages.some((message) => message.type === "frame"),
    ),
  );
  await h.call("browser.close");
}
async function uploadCase(h: Harness) {
  await h.checkTransferAuthorization();
  await exerciseUploads(h);
  await h.call("browser.close");
}
async function exerciseUploads(h: Harness) {
  await open(h);
  const identity = {
    sessionId: h.session.sessionId,
    generation: h.session.generation,
    machineId: (await h.store.read(h.session.sessionId))!.resource!.machineId,
  };
  console.info("[browser-test] upload session", identity);
  const { approve } = await import("./approval.js");
  const bytes = Buffer.from("Kestrel approved upload: exact fixture bytes\n");
  const file = await h.attach(bytes, "upload.txt");
  for (const decision of ["decline", "approve_once"] as const) {
    const snapshot = await h.call("browser.snapshot");
    const targetRef = String(snapshot.content)
      .split("\n")
      .find((line) => line.includes('"Attachment"'))
      ?.match(/\[ref=([^\]]+)\]/u)?.[1];
    assert.ok(targetRef, "file input must have a real snapshot ref");
    const prepared = await h.prepare("browser.upload", {
      snapshotId: snapshot.snapshotId,
      targetRef: `@${targetRef}`,
      attachmentId: file.id,
    });
    assert.equal(
      h.site.uploads.length,
      0,
      "preparation must not upload bytes to the page",
    );
    const dispatches = h.events.filter(
      (event) => (event as { name?: string }).name === "dispatch",
    ).length;
    await approve(h, prepared, decision);
    if (decision === "decline") {
      assert.equal(h.site.uploads.length, 0);
      assert.equal(
        h.events.filter(
          (event) => (event as { name?: string }).name === "dispatch",
        ).length,
        dispatches,
      );
      // The very next Browser operation after decline must succeed without
      // replacing the session or worker. Do not retry operational failures.
      await h.call("browser.snapshot");
      const current = (await h.store.read(identity.sessionId))!;
      assert.equal(current.session.state, "ready");
      assert.equal(current.session.generation, identity.generation);
      assert.equal(current.resource!.machineId, identity.machineId);
      console.info("[browser-test] upload decline and subsequent snapshot passed");
    } else {
      const result = await h.execute(prepared);
      assert.equal(result.outcome, "uploaded");
      assert.equal(
        result.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      await eventually(() => assert.deepEqual(h.site.uploads, [bytes]));
      console.info("[browser-test] fresh approved upload bytes passed");
    }
  }
}
async function transfersCase(h: Harness) {
  await exerciseUploads(h);
  const { approve } = await import("./approval.js");
  for (const decision of ["decline", "approve_once"] as const) {
    await interact(h, "Download fixture", "click");
    await eventually(() => assert.equal(h.site.downloadStarted, true));
    const incomplete = await h.call("browser.snapshot");
    assert.deepEqual(
      incomplete.pendingDownloads,
      [],
      "incomplete bytes must not be offered for promotion",
    );
    h.site.finishDownload();
    let downloadId: string | undefined;
    await eventually(async () => {
      const snapshot = await h.call("browser.snapshot");
      assert.equal(snapshot.pendingDownloads?.length, 1);
      downloadId = snapshot.pendingDownloads[0].downloadId;
      assert.ok(downloadId);
    });
    const before =
      await h.sql`SELECT id FROM kestrel_files WHERE organization_id = ${h.ids.organizationId} AND lifecycle_state = 'ready'`;
    const prepared = await h.prepare("browser.download", {
      pendingDownloadId: downloadId,
    });
    assert.deepEqual(
      await h.sql`SELECT id FROM kestrel_files WHERE organization_id = ${h.ids.organizationId} AND lifecycle_state = 'ready'`,
      before,
      "preparation must not promote quarantined bytes",
    );
    await approve(h, prepared, decision);
    if (decision === "decline") {
      assert.deepEqual(
        await h.sql`SELECT id FROM kestrel_files WHERE organization_id = ${h.ids.organizationId} AND lifecycle_state = 'ready'`,
        before,
      );
    } else {
      const result = await h.execute(prepared);
      assert.deepEqual(
        await artifactBytes(h, result.artifact.id),
        h.site.download,
      );
      assert.equal(
        result.artifact.sha256,
        createHash("sha256").update(h.site.download).digest("hex"),
      );
    }
    assert.deepEqual(
      (await h.call("browser.snapshot")).pendingDownloads,
      [],
      "consumed quarantine must disappear from discovery",
    );
  }
  await h.call("browser.close");
}
async function cleanupCase(h: Harness) {
  const { reconcileHostedBrowserSessionsForEnvironment } =
    await import("../../lib/browser/reconciliation.js");
  for (const failure of [false, true]) {
    await open(h);
    const session = h.session;
    const resource = (await h.store.read(session.sessionId))!.resource!;
    const owned = h.machines.records.get(resource.machineId)!;
    assert.ok(
      (await h.machines.ownedPids(owned.directory)).length >= 2,
      "real worker and browser processes must exist before cleanup",
    );
    const binding = h.registry.requireSession(session);
    const viewer = await h.viewer();
    await eventually(() =>
      assert.ok(viewer.messages.some((message) => message.type === "frame")),
    );
    const stale = await h.prepare("browser.snapshot", {});
    if (failure) {
      await assert.rejects(
        h.execute(stale, () => h.machines.crash(resource.machineId)),
        /BROWSER_ACTION_OUTCOME_UNKNOWN/u,
      );
    } else {
      await h.call("browser.snapshot");
      await h.call("browser.close");
    }
    for (let pass = 0; pass < 2; pass++) {
      const reconciled = await reconcileHostedBrowserSessionsForEnvironment({
        organizationId: h.ids.organizationId,
        environmentId: h.ids.environmentId,
        appName: "browser-test",
        region: "iad",
        workerImageDigest: h.imageDigest,
        store: h.store,
        machines: h.machines,
      });
      assert.equal(reconciled.failureCount, 0);
    }
    const terminal = await h.store.read(session.sessionId);
    assert.ok(terminal?.resource?.cleanupConfirmedAt);
    assert.ok(["closed", "lost", "failed"].includes(terminal.session.state));
    assert.equal(
      await h.machines.getMachine({
        appName: "browser-test",
        machineId: resource.machineId,
      }),
      null,
    );
    assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null);
    await assert.rejects(access(owned.directory));
    assert.deepEqual(await h.machines.ownedPids(owned.directory), []);
    assert.throws(
      () => h.registry.requireSession(session),
      /BROWSER_SESSION_LOST/u,
    );
    const rejectedProxyStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          "http://[::1]:43109/",
          {
            headers: {
              "proxy-authorization": `Basic ${Buffer.from(`${binding.username}:${binding.password}`).toString("base64")}`,
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    assert.equal(rejectedProxyStatus, 407);
    await assert.rejects(
      h.execute(stale),
      /BROWSER_SESSION_LOST|BROWSER_SESSION_EXPIRED|BROWSER_ACTION_OUTCOME_UNKNOWN/u,
    );
    await assert.rejects(
      h.viewerService.mintTicket(h.actor),
      /BROWSER_SESSION_LOST/u,
    );
    await eventually(() => assert.notEqual(viewer.socket.readyState, 1));
    assert.equal(await h.tickets.readCleanupPending(h.ids.threadId), null);
  }
}

async function interact(
  h: Harness,
  label: string,
  kind: "click" | "fill",
  text?: string,
) {
  const tabs = await h.call("browser.tabs", { operation: "list" });
  const snapshot = await h.call("browser.snapshot");
  const lines = String(snapshot.content)
    .split("\n")
    .filter((line) => line.includes(`"${label}"`));
  assert.equal(lines.length, 1, `fixture must expose one ${label} target`);
  const ref = lines[0]!.match(/\[ref=([^\]]+)\]/u)?.[1];
  assert.ok(ref, `fixture ${label} must carry a snapshot ref`);
  return h.call("browser.interact", {
    snapshotId: snapshot.snapshotId,
    documentRevision: snapshot.documentRevision,
    tabId: tabs.activeTabId,
    action: { kind, ref: `@${ref}`, ...(text === undefined ? {} : { text }) },
  });
}

async function artifactBytes(h: Harness, fileId: string) {
  const { getThreadFileForUser } = await import("../../lib/files/service.js");
  const { getManagedFileStorageProvider } =
    await import("../../lib/files/storage-provider.js");
  const file = await getThreadFileForUser({
    fileId,
    threadId: h.ids.threadId,
    organizationId: h.ids.organizationId,
    userId: h.ids.userId,
  });
  assert.equal(file.lifecycleState, "ready");
  return getManagedFileStorageProvider().readBuffer(file.objectKey);
}

export async function eventually<T>(
  check: () => T | Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await check();
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      if (Date.now() >= deadline) throw error;
      await delay(50);
    }
  }
}
