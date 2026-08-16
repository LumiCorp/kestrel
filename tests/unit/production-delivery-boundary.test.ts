import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const flyWorkflow = source(".github/workflows/production-fly.yml");
const runtimeWorkflow = source(".github/workflows/production-runtime.yml");
const runPodWorkflow = source(".github/workflows/production-runpod.yml");
const buildScript = source("scripts/build-production-image.ts");
const productionImageRoute = source(
  "apps/web/app/api/internal/production-images/route.ts",
);
const productionImages = source(
  "apps/web/lib/deployment/production-images.ts",
);
const productionImageReadiness = source(
  "apps/web/lib/deployment/production-image-readiness.ts",
);
const runtimeChannel = source(
  "apps/web/lib/environments/runtime-channel.ts",
);
const runtimeChannelClient = source(
  "apps/web/app/(workspace)/platform/runtime/runtime-channel-client.tsx",
);
const cutoverPreflight = source("scripts/production-cutover-preflight.ts");
const vercel = source("apps/web/vercel.json");

test("production delivery has three build-only image channels", () => {
  for (const workflow of [flyWorkflow, runtimeWorkflow, runPodWorkflow]) {
    assert.match(workflow, /branches: \[production\]/u);
    assert.match(workflow, /workflow_dispatch:/u);
    assert.match(workflow, /build-production-image\.ts/u);
    assert.doesNotMatch(workflow, /flyctl deploy|fly deploy|cosign|id-token:|VERCEL_TOKEN/u);
  }
  assert.match(flyWorkflow, /select-production-images\.ts fly/u);
  assert.match(runPodWorkflow, /select-production-images\.ts runpod/u);
  assert.match(
    runtimeWorkflow,
    /select-production-images\.ts environment-runtime/u,
  );
  assert.match(runtimeWorkflow, /notify-production-runtime\.ts/u);
  assert.match(runtimeWorkflow, /needs\.build\.result == 'success'/u);
});

test("image publication smokes locally before push and notifies Kestrel afterward", () => {
  const smoke = buildScript.indexOf(
    'run("bash", [image.smoke, taggedImage])',
  );
  const push = buildScript.indexOf('run("docker", ["push", taggedImage])');
  const notify = buildScript.indexOf("await notifyKestrel");
  assert.ok(smoke >= 0 && smoke < push && push < notify);
  assert.match(buildScript, /production-\$\{runNumber\}-\$\{runAttempt\}/u);
  assert.doesNotMatch(buildScript, /flyctl|cosign|github\.sha|GITHUB_SHA/u);
  assert.match(buildScript, /waitForKestrelProductionReceiver/u);
  assert.match(buildScript, /READINESS_TIMEOUT_MS = 15 \* 60 \* 1000/u);
  assert.match(buildScript, /READINESS_POLL_INTERVAL_MS = 5000/u);
  assert.match(buildScript, /AbortSignal\.timeout\(810_000\)/u);
  assert.match(productionImageRoute, /export function GET/u);
  assert.match(productionImageRoute, /maxDuration = 800/u);
  assert.match(buildScript, /latestProductionMigration/u);
  assert.match(buildScript, /readiness\?\.migration === input\.requiredMigration/u);
  assert.match(productionImageRoute, /migrationApplied\(requiredMigration\)/u);
  assert.match(productionImageRoute, /runtimeConsumerReady/u);
  assert.match(productionImageReadiness, /drizzle\.__drizzle_migrations/u);
  assert.match(productionImageReadiness, /CONTROL_WORKER_IMAGE/u);
});

test("application-owned deployment fails closed on stale and unconverged provider state", () => {
  assert.match(productionImages, /isNewerProductionImage/u);
  assert.match(productionImages, /retry after the app reaches a stable state/u);
  assert.match(productionImages, /const finalMachines = await input\.fly\.listAppMachines/u);
  assert.match(productionImages, /did not converge/u);
});

test("runtime recovery is explicit and uses fresh canary evidence", () => {
  assert.match(runtimeChannel, /status: "recovery_required" as const/u);
  assert.match(runtimeChannel, /retryDesiredEnvironmentRuntime/u);
  assert.match(runtimeChannel, /selectPreviousEnvironmentRuntime/u);
  assert.match(
    runtimeChannel,
    /operation\.createdAt < runtimeDate\(channel\.updatedAt\)/u,
  );
  assert.match(runtimeChannelClient, /Retry desired/u);
  assert.match(runtimeChannelClient, /Canary previous version/u);
});

test("cutover preflight prefers the runtime-channel canary authority", () => {
  const runtimeAuthority = cutoverPreflight.indexOf(
    "environment_runtime_channels",
  );
  const legacyFallback = cutoverPreflight.indexOf("fly_image_release_settings");
  assert.ok(runtimeAuthority >= 0 && runtimeAuthority < legacyFallback);
  assert.match(cutoverPreflight, /to_regclass\('public\.environment_runtime_channels'\)/u);
});

test("production database migration belongs to the Vercel production build", () => {
  assert.match(vercel, /VERCEL_ENV/u);
  const validateConfiguration = vercel.indexOf("config:validate:production");
  const migrate = vercel.indexOf("db:migrate:deploy");
  assert.ok(validateConfiguration >= 0 && validateConfiguration < migrate);
  assert.match(vercel, /db:migrate:deploy/u);
});

test("retired production orchestration is absent", () => {
  for (const path of [
    "scripts/deploy-production-image.ts",
    "scripts/promote-environment-runtime.ts",
    "apps/web/scripts/sync-worker-config.ts",
    "apps/web/lib/runtime/github-actions-oidc.ts",
    ".github/workflows/production-database.yml",
    ".github/workflows/fly-image-release.yml",
    ".github/workflows/prepare-release-candidate.yml",
  ]) {
    assert.equal(existsSync(path), false, path);
  }
});

function source(path: string) {
  return readFileSync(path, "utf8");
}
