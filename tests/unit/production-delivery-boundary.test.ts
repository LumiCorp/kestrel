import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const publishImage = source("scripts/publish-production-image.ts");
const deployFlyMachine = source("scripts/deploy-production-fly-machine.ts");
const cutoverPreflight = source("scripts/production-cutover-preflight.ts");
const reconcileSchedule = source(
  "apps/web/lib/environments/reconcile-schedule.ts",
);
const runtimeUpdate = source(
  "apps/web/scripts/update-environment-runtime.ts",
);
const runtimeActivation = source(
  "apps/web/scripts/activate-production-runtime.ts",
);
const vercel = source("apps/web/vercel.json");
const webPackage = JSON.parse(source("apps/web/package.json"));
const docsPackage = JSON.parse(source("apps/docs/package.json"));

test("production pushes have no Fly, RunPod, runtime, or migration workflow", () => {
  for (const path of [
    ".github/workflows/production-fly.yml",
    ".github/workflows/production-runpod.yml",
    ".github/workflows/production-runtime.yml",
    ".github/workflows/production-database.yml",
  ]) {
    assert.equal(existsSync(path), false, path);
  }
});

test("Vercel production build retains configuration validation and migration", () => {
  const validateConfiguration = vercel.indexOf("config:validate:production");
  const migrate = vercel.indexOf("db:migrate:deploy");
  assert.ok(validateConfiguration >= 0 && validateConfiguration < migrate);
  assert.match(vercel, /VERCEL_ENV/u);
});

test("Vercel project roots select Node.js 22", () => {
  assert.equal(webPackage.engines?.node, "22.x");
  assert.equal(docsPackage.engines?.node, "22.x");
});

test("production cutover preflight loads and removes the temporary One environment", () => {
  assert.match(cutoverPreflight, /loadProductionEnvironment/u);
  assert.match(cutoverPreflight, /POSTGRES_URL_NON_POOLING/u);
  assert.match(cutoverPreflight, /environment_runtime_channels/u);
  assert.match(cutoverPreflight, /fly-image\.release/u);
  assert.doesNotMatch(
    cutoverPreflight,
    /fly_image_releases|fly_image_release_targets|fly_image_release_settings/u,
  );
  assert.doesNotMatch(cutoverPreflight, /vercel env pull|production\.env/u);
});

test("local image publication smokes before push and never deploys or notifies", () => {
  const smoke = publishImage.indexOf("productionImageBuildCommands");
  const push = publishImage.indexOf('{ command: "docker", args: ["push"');
  assert.ok(smoke >= 0 && push > smoke);
  assert.match(publishImage, /linux\/amd64/u);
  assert.doesNotMatch(publishImage, /revision|imagetools|digest/u);
  assert.doesNotMatch(
    publishImage,
    /production-images|KESTREL_ONE_PRODUCTION_URL|PRODUCTION_IMAGE_DEPLOY_TOKEN/u,
  );
  assert.doesNotMatch(publishImage, /fly machine update|fly deploy/u);
});

test("local Fly deployment accepts one exact Machine and operator tag only", () => {
  assert.match(deployFlyMachine, /--machine/u);
  assert.match(deployFlyMachine, /--tag/u);
  assert.doesNotMatch(deployFlyMachine, /revision|digest/u);
  assert.match(deployFlyMachine, /Confirmation did not match the exact target/u);
  assert.match(deployFlyMachine, /flyMachineUpdateArgs/u);
  assert.doesNotMatch(deployFlyMachine, /for \(const machine|listAppMachines/u);
});

test("runtime delivery is explicit and exact-environment only", () => {
  assert.match(runtimeUpdate, /registerEnvironmentRuntimeVersion/u);
  assert.match(runtimeUpdate, /logAdminEvent/u);
  assert.match(runtimeActivation, /activateEnvironmentRuntimeVersion/u);
  assert.match(runtimeActivation, /logAdminEvent/u);
  assert.match(runtimeActivation, /canary-operation/u);
  assert.match(runtimeUpdate, /--environment/u);
  assert.match(runtimeUpdate, /--tag/u);
  assert.doesNotMatch(runtimeUpdate, /actor-user-id|revision|digest/u);
  assert.doesNotMatch(runtimeUpdate, /--batch|findMany|for \(const environment/u);
  assert.doesNotMatch(reconcileSchedule, /runtime-channel|reconcileDesired/u);
});

test("web automatic deployment receivers and controls are absent", () => {
  for (const path of [
    "apps/web/app/api/internal/production-images/route.ts",
    "apps/web/lib/deployment/production-images.ts",
    "apps/web/app/api/admin/runtime-channel/route.ts",
    "apps/web/app/api/organization/environments/[id]/runtime-updates/route.ts",
  ]) {
    assert.equal(existsSync(path), false, path);
  }
});

test("platform runtime is limited to explicit Turn Worker capacity control", () => {
  const runtimePage = source(
    "apps/web/app/(workspace)/platform/runtime/page.tsx",
  );
  const runtimeRoute = source(
    "apps/web/app/api/platform/runtime/turn-workers/route.ts",
  );

  assert.match(runtimePage, /TurnWorkerCapacityClient/u);
  assert.match(runtimeRoute, /requestTurnWorkerCapacityOperation/u);
  assert.doesNotMatch(
    `${runtimePage}\n${runtimeRoute}`,
    /production-images|runtime-channel|activateEnvironmentRuntimeVersion|deploy-production/u,
  );
});

function source(path: string) {
  return readFileSync(path, "utf8");
}
