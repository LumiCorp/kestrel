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
    turnWorkerSmoke,
    candidateRoute,
    releaseContracts,
    streamingCommand,
    canonicalStreamingCommand,
    preflightRuntime,
    controllerCandidateRuntime,
    controllerDeployRuntime,
    controllerArtifactRuntime,
    preparationWorkflow,
    preparationRuntime,
    smokeHarness,
    routerSmoke,
    previewSmoke,
    workspaceSmoke,
    manifestSmoke,
    pullRequestTemplate,
  ] = await Promise.all([
    read("deploy/fly/image-catalog.json"),
    read(".github/workflows/fly-image-release.yml"),
    read("scripts/publish-fly-images.ts"),
    read("scripts/fly-image-publisher.ts"),
    read("apps/web/lib/releases/github-oidc.ts"),
    read("deploy/fly/kestrel-one-runpod-worker/Dockerfile"),
    read("deploy/fly/kestrel-one-runpod-worker/smoke.sh"),
    read("deploy/fly/kestrel-one-turn-worker/smoke.sh"),
    read("apps/web/app/api/runtime/releases/candidates/route.ts"),
    read("apps/web/lib/releases/contracts.ts"),
    read("scripts/lib/streaming-command.ts"),
    read("apps/web/scripts/streaming-command.ts"),
    read("scripts/preflight-fly-image-publication.ts"),
    read("apps/web/scripts/publish-control-worker-candidate.ts"),
    read("apps/web/scripts/deploy-control-worker-candidate.ts"),
    read("apps/web/scripts/control-worker-artifact.ts"),
    read(".github/workflows/prepare-release-candidate.yml"),
    read("apps/web/scripts/prepare-release-candidate.ts"),
    read("scripts/lib/image-smoke.sh"),
    read("apps/environment-router/scripts/image-smoke.sh"),
    read("apps/preview-edge/scripts/image-smoke.sh"),
    read("apps/workspace-runtime/scripts/image-smoke.sh"),
    read("scripts/smoke-release-manifest.ts"),
    read(".github/pull_request_template.md"),
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
  assert.match(workflow, /packages: write/u);
  assert.match(workflow, /docker login ghcr\.io/u);
  assert.match(workflow, /sigstore\/cosign-installer@[a-f0-9]{40}/u);
  assert.match(workflow, /publish-candidate:\n\s+environment: Production/u);
  assert.match(workflow, /pnpm validate/u);
  assert.match(workflow, /run: flyctl auth docker/u);
  assert.match(workflow, /Build, smoke, and publish the complete candidate/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(pullRequestTemplate, /dispatch `Prepare release candidate`/u);
  assert.match(
    pullRequestTemplate,
    /release:control-worker` only for an explicit\s+bootstrap or repair/u,
  );
  assert.doesNotMatch(workflow, /deploy-control-worker-candidate/u);
  assert.doesNotMatch(workflow, /machine (?:list|status|update)|flyctl logs/u);
  assert.doesNotMatch(workflow, /run: fly auth docker/u);
  assert.match(publisherRuntime, /--build-only/u);
  assert.match(publisherRuntime, /--push/u);
  assert.match(publisherRuntime, /Promise\.allSettled/u);
  assert.match(publisherRuntime, /runFlyImageBuild/u);
  assert.match(publisherRuntime, /appBuildQueues/u);
  assert.match(publisher, /publishFlyImages/u);
  assert.match(publisherRuntime, /dependencies\.run\("flyctl", args\)/u);
  assert.doesNotMatch(publisher, /await run\("fly", \[/u);
  assert.match(publisherRuntime, /"image",\s*"inspect"/u);
  assert.doesNotMatch(publisherRuntime, /"image", "show"/u);
  assert.match(publisherRuntime, /EXPECTED_GIT_SHA/u);
  assert.match(publisherRuntime, /"linux\/amd64"/u);
  assert.match(publisherRuntime, /cosign", \["sign"/u);
  assert.match(publisherRuntime, /"verify"/u);
  assert.match(publisherRuntime, /verifyAnonymousGhcrDigestPull/u);
  assert.match(publisherRuntime, /pullPublishedImage/u);
  assert.match(publisherRuntime, /publicationToken/u);
  assert.match(oidc, /workflow_ref/u);
  assert.match(oidc, /run_id/u);
  assert.match(oidc, /run_attempt/u);
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
  assert.match(
    workflow,
    /setup-flyctl@ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1\n\s+with:\n\s+version: 0\.4\.82/u,
  );
  assert.match(publisherRuntime, /selectFlyImageDiffBase/u);
  assert.match(publisherRuntime, /const changedPaths = diffBase/u);
  assert.match(publisherRuntime, /forceAll\s*\?\s*false/u);
  assert.match(publisherRuntime, /attempt\.id\.slice/u);
  assert.match(publisherRuntime, /RELEASE_ATTEMPT_RENEW_INTERVAL_MS/u);
  assert.match(publisher, /labelSuffix: input\.forceAll/u);
  assert.match(runPodDockerfile, /WORKDIR \/workspace\/apps\/web/u);
  assert.match(runPodSmoke, /--import tsx scripts\/managed-runpod-worker\.ts/u);
  assert.doesNotMatch(
    runPodSmoke,
    /\.\/apps\/web\/scripts\/managed-runpod-worker\.ts/u,
  );
  assert.match(turnWorkerSmoke, /docker run --rm "\$image"/u);
  assert.doesNotMatch(turnWorkerSmoke, /--entrypoint|tsx --version/u);
  assert.match(
    turnWorkerSmoke,
    /Kestrel One durable turn worker failed to start: turn-worker configuration is incomplete/u,
  );
  assert.match(turnWorkerSmoke, /\.kestrel-source-revision/u);
  assert.match(turnWorkerSmoke, /org\.opencontainers\.image\.revision/u);
  assert.match(publisherRuntime, /RELEASE_CONTROLLER_CONTRACT_REVISION/u);
  assert.match(publisherRuntime, /version: 3 as const/u);
  assert.match(publisherRuntime, /ReleaseArtifactAggregateError/u);
  assert.match(publisher, /publishControlWorkerImage/u);
  assert.doesNotMatch(publisherRuntime, /controllerContractRevision:\s*1/u);
  assert.match(
    releaseContracts,
    /flyImageReleaseCandidatePublicationResponseSchema/u,
  );
  assert.match(
    candidateRoute,
    /flyImageReleaseCandidatePublicationResponseSchema\.parse/u,
  );
  assert.match(candidateRoute, /claims\.run_id !== input\.githubRunId/u);
  assert.match(
    candidateRoute,
    /claims\.run_id !== manifest\.attempt\.githubRunId/u,
  );
  assert.match(
    publisherRuntime,
    /flyImageReleaseCandidatePublicationResponseSchema\.parse/u,
  );
  assert.match(streamingCommand, /apps\/web\/scripts\/streaming-command/u);
  assert.match(canonicalStreamingCommand, /spawn\(command, args/u);
  assert.match(canonicalStreamingCommand, /64 \* 1024/u);
  for (const runtime of [
    publisher,
    preflightRuntime,
    controllerCandidateRuntime,
    controllerDeployRuntime,
    controllerArtifactRuntime,
  ]) {
    assert.match(runtime, /(?:run|capture)StreamingCommand/u);
    assert.doesNotMatch(runtime, /execFile|maxBuffer/u);
  }

  const orderedSteps = [
    "Validate the release revision",
    "Authenticate Docker to the Fly registry",
    "Wait for the exact Kestrel One production revision",
    "Preflight release publication",
    "Build, smoke, and publish the complete candidate",
  ].map((name) => workflow.indexOf(`- name: ${name}`));
  assert.ok(orderedSteps.every((index) => index >= 0));
  assert.deepEqual(
    orderedSteps,
    [...orderedSteps].sort((left, right) => left - right),
  );
  assert.match(
    workflow,
    /run: pnpm tsx scripts\/preflight-fly-image-publication\.ts/u,
  );
  assert.match(preparationWorkflow, /workflow_dispatch/u);
  assert.match(preparationWorkflow, /cancel-in-progress: false/u);
  assert.match(
    preparationWorkflow,
    /setup-flyctl@ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1\n\s+with:\n\s+version: 0\.4\.82/u,
  );
  assert.match(preparationRuntime, /deployStoredControlWorkerCandidate/u);
  assert.doesNotMatch(preparationRuntime, /buildControlWorkerArtifact/u);
  assert.match(preparationRuntime, /preparationCompletionSchema\.parse/u);
  assert.match(controllerDeployRuntime, /KESTREL_RELEASE_IMAGE=/u);
  assert.match(smokeHarness, /State\.Running/u);
  assert.match(smokeHarness, /docker logs/u);
  assert.match(routerSmoke, /smoke_container_port/u);
  assert.match(routerSmoke, /kill -0 "\$fixture"/u);
  for (const smoke of [routerSmoke, previewSmoke, workspaceSmoke]) {
    assert.doesNotMatch(smoke, /docker run --rm --detach/u);
  }
  assert.match(manifestSmoke, /Promise\.allSettled/u);
  assert.match(manifestSmoke, /kestrel-one-control-worker\/smoke\.sh/u);
  for (const role of [
    "workspace-runtime",
    "environment-router",
    "preview-edge",
    "turn-worker",
    "runpod-worker",
  ]) {
    assert.match(manifestSmoke, new RegExp(`"${role}"`, "u"));
  }
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
  assert.match(
    runtime,
    /workspace\.verified_on_start[\s\S]*?\.returning\(\{[\s\S]*?completeFlyImageReleaseIfReady/u,
  );
  assert.match(runtime, /environment\.awaiting_provisioning/u);
  assert.match(runtime, /environment\.skipped_unavailable/u);
  assert.match(runtime, /environment\.removed_before_deploy/u);
  assert.match(runtime, /skippedReason: "environment_removed"/u);
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
  assert.match(releaseStore, /acquireFlyImageReleaseAttempt/u);
  assert.match(releaseStore, /completeFlyImageReleasePreparation/u);
  assert.match(releaseStore, /assertV3ReleasePrepared/u);
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
