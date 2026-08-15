import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const databaseWorkflow = source(".github/workflows/production-database.yml");
const flyWorkflow = source(".github/workflows/production-fly.yml");
const runPodWorkflow = source(".github/workflows/production-runpod.yml");
const deployScript = source("scripts/deploy-production-image.ts");
const migrator = source("apps/web/lib/db/migrate.ts");
const personalWorkspace = source("apps/web/lib/personal-workspace.ts");
const promotionScript = source("scripts/promote-environment-runtime.ts");
const cutoverPreflight = source("scripts/production-cutover-preflight.ts");
const rootPackage = JSON.parse(source("package.json")) as {
  dependencies?: Record<string, string>;
};
const webPackage = JSON.parse(source("apps/web/package.json")) as {
  devDependencies?: Record<string, string>;
};

test("production delivery exposes four independent branch-owned lanes", () => {
  for (const workflow of [databaseWorkflow, flyWorkflow, runPodWorkflow]) {
    assert.match(workflow, /branches: \[production\]/u);
    assert.match(workflow, /workflow_dispatch:/u);
    assert.doesNotMatch(workflow, /branches: \[main\]/u);
    assert.doesNotMatch(workflow, /^\s*schedule:/mu);
    assert.doesNotMatch(workflow, /cancel-in-progress: true/u);
  }
  assert.match(databaseWorkflow, /environment: Production/u);
  assert.match(databaseWorkflow, /DATABASE_URL_UNPOOLED/u);
  assert.match(
    databaseWorkflow,
    /DATABASE_URL_UNPOOLED: \$\{\{ secrets\.POSTGRES_URL_NON_POOLING \}\}/u,
  );
  assert.match(databaseWorkflow, /pnpm db:migrate:deploy/u);
  assert.doesNotMatch(databaseWorkflow, /POSTGRES_URL:|DATABASE_URL:/u);
  assert.doesNotMatch(databaseWorkflow, /release-control|bootstrap/iu);
  assert.match(
    migrator,
    /backfillPersonalWorkspaceData\(drizzle\(connection, \{ schema \}\)\)/u,
  );
  assert.match(
    personalWorkspace,
    /database: typeof knowledgeDb = knowledgeDb/u,
  );

  assert.match(flyWorkflow, /select-production-images\.ts fly/u);
  assert.match(flyWorkflow, /flyctl auth docker/u);
  assert.match(flyWorkflow, /production-fly-\$\{\{ matrix\.role \}\}/u);
  assert.match(flyWorkflow, /promote-environment-runtime\.ts/u);
  assert.match(flyWorkflow, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/u);
  assert.match(
    flyWorkflow,
    /KESTREL_RUNTIME_API_URL: \$\{\{ vars\.KESTREL_ONE_PRODUCTION_URL \}\}/u,
  );
  assert.doesNotMatch(flyWorkflow, /runpod-worker"/u);
  assert.doesNotMatch(flyWorkflow, /vercel.*sha|sha.*vercel/iu);

  assert.match(runPodWorkflow, /select-production-images\.ts runpod/u);
  assert.match(runPodWorkflow, /flyctl auth docker/u);
  assert.match(runPodWorkflow, /deploy-production-image\.ts runpod-worker/u);
  assert.match(
    runPodWorkflow,
    /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/u,
  );
  assert.doesNotMatch(
    runPodWorkflow,
    /production-fly|promote-runtime|KESTREL_RUNTIME_API_URL|environment-runtime/iu,
  );
  assert.equal(webPackage.devDependencies?.vercel, "50.23.2");
  assert.equal(rootPackage.dependencies?.postgres, "^3.4.7");
  assert.match(cutoverPreflight, /JOIN "fly_image_releases" release/u);
  assert.match(
    cutoverPreflight,
    /release\."status" NOT IN \('completed', 'superseded'\)/u,
  );
  assert.match(cutoverPreflight, /canary_environment_id/u);
  assert.match(cutoverPreflight, /environment\."provider" = 'fly'/u);
  assert.match(
    cutoverPreflight,
    /environment\."status" IN \('ready', 'degraded'\)/u,
  );
});

test("image deployment smokes before mutation and restores the prior digest", () => {
  const smoke = deployScript.indexOf('run("bash", [image.smoke, digest]');
  const config = deployScript.indexOf('"sync:worker-config"');
  const deploy = deployScript.indexOf('"--image",\n      digest');
  assert.ok(smoke >= 0 && smoke < config && config < deploy);
  assert.match(deployScript, /const previousImage = currentMachineImage/u);
  assert.match(deployScript, /has no prior Machine digest to restore safely/u);
  assert.match(deployScript, /"--image",\s*previousImage/u);
  assert.ok((deployScript.match(/assertMachinesUseImage/g) ?? []).length >= 2);
  assert.ok((deployScript.match(/assertWorkerChecksPass/g) ?? []).length >= 2);
  assert.match(deployScript, /cosign", \["sign"/u);
  assert.match(deployScript, /cosign", \[\s*"verify"/u);
  assert.doesNotMatch(deployScript, /(?:run|capture)\("fly"/u);
  assert.match(deployScript, /run\("flyctl"/u);
  assert.doesNotMatch(deployScript, /:production\b/u);
});

test("runtime promotion uses a fresh OIDC token for every API call", () => {
  assert.match(
    promotionScript,
    /async function runtimeRequest[\s\S]*const token = await freshOidcToken\(\)/u,
  );
  assert.match(promotionScript, /canary:environment:workspace/u);
  assert.match(promotionScript, /canary:environment:preview/u);
  assert.ok(
    promotionScript.indexOf("canary:environment:preview") <
      promotionScript.indexOf("/promote`"),
  );
  assert.doesNotMatch(promotionScript, /DATABASE_URL|POSTGRES_URL/u);
});

test("the coordinated workflows and application release subsystem are retired", () => {
  assert.equal(existsSync(".github/workflows/fly-image-release.yml"), false);
  assert.equal(
    existsSync(".github/workflows/prepare-release-candidate.yml"),
    false,
  );
  assert.equal(
    existsSync("apps/web/scripts/vercel-production-preflight.ts"),
    false,
  );
  const staleImport = ["app", "components", "lib", "scripts"]
    .flatMap((directory) => sourceFiles(join("apps/web", directory)))
    .find((path) => source(path).includes("@/lib/releases"));
  assert.equal(staleImport, undefined, staleImport);
});

function source(path: string) {
  return readFileSync(path, "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
}
