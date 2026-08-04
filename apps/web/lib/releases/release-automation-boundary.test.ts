import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../../", import.meta.url);

test("Fly image release automation covers every managed image and authenticates with OIDC", async () => {
  const [catalog, workflow, publisher, oidc] = await Promise.all([
    read("deploy/fly/image-catalog.json"),
    read(".github/workflows/fly-image-release.yml"),
    read("scripts/publish-fly-images.ts"),
    read("apps/web/lib/releases/github-oidc.ts"),
  ]);
  for (const role of [
    "workspace-runtime",
    "environment-router",
    "preview-edge",
    "turn-worker",
    "runpod-worker",
  ]) {
    assert.match(catalog, new RegExp(`"role": "${role}"`, "u"));
  }
  assert.match(workflow, /cron: "0 14 \* \* 1"/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /pnpm validate/u);
  assert.match(publisher, /--build-only/u);
  assert.match(publisher, /--push/u);
  assert.match(publisher, /"image",\s*"inspect"/u);
  assert.doesNotMatch(publisher, /"image", "show"/u);
  assert.match(publisher, /EXPECTED_GIT_SHA/u);
  assert.match(oidc, /workflow_ref/u);
  assert.doesNotMatch(oidc, /job_workflow_ref/u);
  assert.match(oidc, /refs\/heads\/main/u);
  assert.doesNotMatch(workflow, /FLY_API_TOKEN: \$\{\{ vars\./u);
  const jobEnvironment =
    workflow.match(/timeout-minutes: 90\n\s+env:\n([\s\S]*?)\n\s+steps:/u)?.[1] ??
    "";
  assert.doesNotMatch(jobEnvironment, /FLY_API_TOKEN/u);
  assert.match(workflow, /FLY_API_TOKEN: \$\{\{ secrets\.FLY_API_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /setup-flyctl@master/u);
  assert.match(publisher, /selectFlyImageDiffBase/u);
  assert.match(publisher, /const changedPaths = diffBase/u);
  assert.match(publisher, /impactedFlyImages\(\{ catalog, changedPaths, forceAll \}\)/u);
});

test("promotion drains sequentially and preserves stopped Workspaces", async () => {
  const [
    runtime,
    provisioner,
    executionRoute,
    releaseStore,
    environmentStore,
    queue,
  ] = await Promise.all([
    read("apps/web/lib/releases/runtime.ts"),
    read("apps/web/lib/environments/provisioner.ts"),
    read("apps/web/lib/environments/execution-route.ts"),
    read("apps/web/lib/releases/store.ts"),
    read("apps/web/lib/environments/store.ts"),
    read("apps/web/lib/knowledge/queue.ts"),
  ]);
  assert.match(runtime, /30 \* 60 \* 1000/u);
  assert.match(runtime, /"routed",\s*"running"/u);
  assert.match(runtime, /canaryEnvironmentId/u);
  assert.match(runtime, /status: "paused"/u);
  assert.match(runtime, /automaticRollback: false/u);
  assert.match(provisioner, /preserveStoppedWorkspaces/u);
  assert.match(provisioner, /createVolumeSnapshot/u);
  assert.match(provisioner, /configureStoppedWorkspaceRuntime/u);
  assert.match(executionRoute, /activeReleaseTarget/u);
  assert.match(releaseStore, /RELEASE_MIGRATION_BLOCKED/u);
  assert.match(releaseStore, /acknowledgeFlyImageReleaseMigration/u);
  assert.match(releaseStore, /trigger: "rollback"/u);
  assert.match(runtime, /completeFlyImageReleaseIfReady/u);
  assert.match(runtime, /environment\.awaiting_provisioning/u);
  assert.match(runtime, /environment\.skipped_unavailable/u);
  assert.match(runtime, /isFlyImageReleaseMachineVerified/u);
  assert.match(releaseStore, /FLY_IMAGE_RELEASE_LOCK_KEY/u);
  assert.match(
    releaseStore,
    /FLY_IMAGE_RELEASE_TARGETABLE_ENVIRONMENT_STATUSES/u,
  );
  assert.match(
    releaseStore,
    /FLY_IMAGE_RELEASE_DEPLOYABLE_ENVIRONMENT_STATUSES/u,
  );
  assert.match(releaseStore, /attachActiveFlyImageReleaseTarget/u);
  assert.match(releaseStore, /mergePinnedFlyImageReleaseHistory/u);
  assert.match(environmentStore, /attachActiveFlyImageReleaseTarget/u);
  assert.match(queue, /policy: "singleton"/u);
  assert.match(queue, /singletonKey: releaseId/u);

  const environmentTarget = runtime.indexOf(
    "async function applyEnvironmentTarget",
  );
  const lifecycleLock = runtime.indexOf(
    "environmentLifecycleLockKey(environmentId)",
    environmentTarget,
  );
  const environmentClassification = runtime.indexOf(
    "classifyFlyImageReleaseEnvironment",
    lifecycleLock,
  );
  assert.ok(environmentTarget >= 0);
  assert.ok(lifecycleLock > environmentTarget);
  assert.ok(environmentClassification > lifecycleLock);
});

async function read(path: string) {
  return readFile(new URL(path, root), "utf8");
}
