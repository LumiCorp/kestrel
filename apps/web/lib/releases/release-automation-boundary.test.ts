import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../../", import.meta.url);

test("Fly image release automation covers every managed image and authenticates with OIDC", async () => {
  const [
    catalog,
    workflow,
    publisher,
    publisherRuntime,
    oidc,
    runPodDockerfile,
    runPodSmoke,
  ] = await Promise.all([
    read("deploy/fly/image-catalog.json"),
    read(".github/workflows/fly-image-release.yml"),
    read("scripts/publish-fly-images.ts"),
    read("scripts/fly-image-publisher.ts"),
    read("apps/web/lib/releases/github-oidc.ts"),
    read("deploy/fly/kestrel-one-runpod-worker/Dockerfile"),
    read("deploy/fly/kestrel-one-runpod-worker/smoke.sh"),
  ]);
  for (const role of [
    "workspace-runtime",
    "environment-router",
    "preview-edge",
    "turn-worker",
    "runpod-worker",
    "control-worker",
  ]) {
    assert.match(catalog, new RegExp(`"role": "${role}"`, "u"));
  }
  const parsedCatalog = JSON.parse(catalog) as {
    images: Array<{ inputs: string[] }>;
  };
  assert.equal(
    parsedCatalog.images.every((image) =>
      image.inputs.includes(".dockerignore"),
    ),
    true,
  );
  assert.match(workflow, /cron: "0 14 \* \* 1"/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /deploy-runtime:\n\s+environment: Production/u);
  assert.match(workflow, /pnpm validate/u);
  assert.match(workflow, /run: flyctl auth docker/u);
  assert.doesNotMatch(workflow, /run: fly auth docker/u);
  assert.match(publisherRuntime, /--build-only/u);
  assert.match(publisherRuntime, /--push/u);
  assert.match(publisher, /publishFlyImages/u);
  assert.match(publisherRuntime, /dependencies\.run\("flyctl", \[/u);
  assert.doesNotMatch(publisher, /await run\("fly", \[/u);
  assert.match(publisherRuntime, /"image",\s*"inspect"/u);
  assert.doesNotMatch(publisherRuntime, /"image", "show"/u);
  assert.match(publisherRuntime, /EXPECTED_GIT_SHA/u);
  assert.match(publisherRuntime, /pullPublishedImage/u);
  assert.match(publisherRuntime, /publicationToken/u);
  assert.match(oidc, /workflow_ref/u);
  assert.doesNotMatch(oidc, /job_workflow_ref/u);
  assert.match(oidc, /refs\/heads\/main/u);
  assert.doesNotMatch(workflow, /FLY_API_TOKEN: \$\{\{ vars\./u);
  const jobEnvironment =
    workflow.match(
      /timeout-minutes: 90\n\s+env:\n([\s\S]*?)\n\s+steps:/u,
    )?.[1] ?? "";
  assert.doesNotMatch(jobEnvironment, /FLY_API_TOKEN/u);
  assert.match(workflow, /FLY_API_TOKEN: \$\{\{ secrets\.FLY_API_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /setup-flyctl@master/u);
  assert.match(publisherRuntime, /activeSourceRevision/u);
  assert.match(publisherRuntime, /const changedPaths = diffBase/u);
  assert.match(
    publisherRuntime,
    /impactedFlyImages\(\{ catalog, changedPaths, forceAll \}\)/u,
  );
  assert.match(runPodDockerfile, /WORKDIR \/workspace\/apps\/web/u);
  assert.match(runPodSmoke, /--import tsx scripts\/managed-runpod-worker\.ts/u);
  assert.doesNotMatch(
    runPodSmoke,
    /\.\/apps\/web\/scripts\/managed-runpod-worker\.ts/u,
  );
});

test("runtime automation deploys global apps directly and publishes platform desired state", async () => {
  const [workflow, publisher, route] = await Promise.all([
    read(".github/workflows/fly-image-release.yml"),
    read("scripts/fly-image-publisher.ts"),
    read("apps/web/app/api/runtime/platform-images/route.ts"),
  ]);
  assert.doesNotMatch(workflow, /publish-candidate/u);
  assert.match(workflow, /KESTREL_PLATFORM_IMAGE_URL/u);
  assert.match(publisher, /globalComponents/u);
  assert.match(publisher, /"--image"/u);
  assert.match(publisher, /Published platform generation/u);
  assert.match(route, /publishPlatformImages/u);
  assert.match(route, /workflow_dispatch/u);
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
  assert.match(runtime, /automaticRollback: true/u);
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
