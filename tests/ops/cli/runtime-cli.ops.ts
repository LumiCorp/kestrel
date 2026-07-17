import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { startLocalCoreApiServer, type LocalCoreApiServer } from "../../../src/localCore/api.js";
import { ensureLocalCoreStore } from "../../../src/localCore/store.js";
import { OPS_FIXTURE_IDS, seedOpsInspectionFixtures } from "../helpers/fixtures.js";
import { runRuntimeCli } from "../helpers/runtimeCli.js";

let coreHome = "";
let core: LocalCoreApiServer | undefined;

before(async () => {
  coreHome = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-ops-core-"));
  core = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: coreHome },
    platform: "darwin",
    coreVersion: "0.5.1",
    idleTimeoutMs: 0,
  });
  const store = await ensureLocalCoreStore({ homePath: coreHome });
  await seedOpsInspectionFixtures(store.store);
});

after(async () => {
  await core?.close();
  if (coreHome.length > 0) {
    await rm(coreHome, { recursive: true, force: true });
  }
});

test("runtime replay renders focus header, approval chain, and delegation milestones", async () => {
  const result = await runRuntimeCli({
    args: ["replay", "--thread-id", OPS_FIXTURE_IDS.approvalChild.threadId],
    env: runtimeEnv(),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /thread=ops-approval-child-thread/);
  assert.match(result.stdout, /delegation id=ops-delegation-approval status=WAITING/);
  assert.match(result.stdout, /activeWait kind=approval/);
  assert.match(result.stdout, /approval requestId=ops-approval-request status=pending/i);
  assert.match(result.stdout, /delegation id=ops-delegation-approval status=WAITING/);
  assert.match(result.stdout, /assembly bundle=bundle:ops:approval-child:downgraded/);
});

test("runtime replay surfaces compaction summaries for compacted threads", async () => {
  const result = await runRuntimeCli({
    args: ["replay", "--run-id", OPS_FIXTURE_IDS.compaction.runId],
    env: runtimeEnv(),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /contextCompaction summary=ops-compaction-summary action=compact/);
  assert.match(result.stdout, /adaptation status=auto_applied action=compact/);
  assert.match(result.stdout, /\[compaction\] context compaction applied/);
});

test("runtime doctor reports blocked parent threads with child blocker details", async () => {
  const result = await runRuntimeCli({
    args: ["doctor", "--run-id", OPS_FIXTURE_IDS.root.runId],
    env: runtimeEnv(),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /status=WAITING/);
  assert.match(result.stdout, /blocking kind=approval/);
  assert.match(result.stdout, /classification=approval_wait/);
  assert.match(result.stdout, /childBlocker delegationId=ops-delegation-approval childThreadId=ops-approval-child-thread status=WAITING/);
  assert.match(result.stdout, /assemblyProvider provider=openrouter model=google\/gemini-3\.1-flash-lite-preview/);
  assert.match(result.stdout, /variant="reference-react:root"/);
  assert.match(result.stdout, /assemblyCompatibility status=downgraded source=policy downgrade="provider_variant_unavailable" capabilityLoss="structured_output_unavailable"/);
});

test("runtime replay surfaces multi-child supervision outcomes for parent threads", async () => {
  const result = await runRuntimeCli({
    args: ["replay", "--run-id", OPS_FIXTURE_IDS.root.runId],
    env: runtimeEnv(),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /children total=3 active=1 waiting=1 completed=2 failed=0 superseded=1/);
  assert.match(result.stdout, /supersededChildren ops-superseded-child-thread/);
  assert.match(result.stdout, /child thread=ops-completed-child-thread status=COMPLETED delegation=COMPLETED outcome="Collected supporting evidence\."/);
  assert.match(result.stdout, /child thread=ops-superseded-child-thread status=COMPLETED delegation=CANCELLED outcome="Superseded by a newer delegation branch\."/);
});

test("runtime doctor reports delegation failure and stalled runs", async () => {
  const failed = await runRuntimeCli({
    args: ["doctor", "--run-id", OPS_FIXTURE_IDS.failureRoot.runId],
    env: runtimeEnv(),
  });

  assert.equal(failed.exitCode, 0);
  assert.match(failed.stdout, /classification=delegation_failed/);

  const stalled = await runRuntimeCli({
    args: ["doctor", "--run-id", OPS_FIXTURE_IDS.stalled.runId],
    env: runtimeEnv(),
  });

  assert.equal(stalled.exitCode, 0);
  assert.match(stalled.stdout, /status=STALLED/);
});

test("runtime doctor reports user-input wait classification for explicit operator reply blockers", async () => {
  const result = await runRuntimeCli({
    args: ["doctor", "--run-id", OPS_FIXTURE_IDS.userInput.runId],
    env: runtimeEnv(),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /status=WAITING/);
  assert.match(result.stdout, /blocking kind=user_input/);
  assert.match(result.stdout, /classification=user_input_wait/);
  assert.match(result.stdout, /Clarify the target report format\./);
});

test("runtime doctor reports mode-switch blockers with explicit wait classification", async () => {
  const result = await runRuntimeCli({
    args: ["doctor", "--run-id", OPS_FIXTURE_IDS.modeBlocked.runId],
    env: runtimeEnv(),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /status=WAITING/);
  assert.match(result.stdout, /blocking kind=user_input/);
  assert.match(result.stdout, /classification=user_input_wait/);
  assert.match(result.stdout, /eventType=user\.mode_switch/);
  assert.match(result.stdout, /Run is blocked on user input\./);
});

function runtimeEnv(): NodeJS.ProcessEnv {
  if (core === undefined) {
    throw new Error("Runtime ops Local Core was not initialized.");
  }
  return {
    ...process.env,
    KESTREL_CORE_HOME: coreHome,
    KESTREL_LOCAL_CORE_API_SOCKET: core.socketPath,
    KESTREL_LOCAL_CORE_API_TOKEN: core.token,
    DATABASE_URL: "",
    KESTREL_DISABLE_DOTENV: "1",
  };
}
