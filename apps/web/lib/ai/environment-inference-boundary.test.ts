import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const read = (relativePath: string) =>
  fs.readFileSync(path.join(appRoot, relativePath), "utf8");

test("Environment inference routes use organization-admin authority", () => {
  for (const route of [
    "app/api/admin/environments/[id]/inference/route.ts",
    "app/api/admin/environments/[id]/inference/deployments/[deploymentId]/route.ts",
    "app/api/admin/environments/[id]/inference/gateways/[gatewayId]/route.ts",
    "app/api/admin/environments/[id]/inference/default/route.ts",
  ]) {
    assert.match(read(route), /requireOrganizationAdmin/u);
  }
});

test("connected inference remains independent from the managed feature gate", () => {
  const route = read("app/api/admin/environments/[id]/inference/route.ts");
  const connectedBranch = route.indexOf('body.kind === "connected"');
  const managedGate = route.indexOf("assertManagedRunPodEnabled()");
  assert.ok(connectedBranch >= 0);
  assert.ok(managedGate > connectedBranch);
  assert.match(route, /assertEnvironmentPrivateInferenceEnabled/u);
});

test("managed jobs are produced by Vercel and consumed by the persistent worker", () => {
  const queue = read("lib/knowledge/queue.ts");
  const worker = read("scripts/managed-runpod-worker.ts");
  const packageJson = read("package.json");
  const workerDockerfile = read(
    "../../deploy/fly/kestrel-one-runpod-worker/Dockerfile"
  );
  const workerFlyConfig = read(
    "../../deploy/fly/kestrel-one-runpod-worker/fly.toml"
  );
  assert.match(queue, /getKnowledgeBossProducer\(\)/u);
  assert.match(queue, /startManagedRunPodWorker/u);
  assert.match(worker, /await startManagedRunPodWorker\(\)/u);
  for (const launchContract of [
    packageJson,
    workerDockerfile,
    workerFlyConfig,
  ]) {
    assert.match(launchContract, /--conditions=react-server/u);
  }
});

test("managed maintenance idles until its provider connection is enabled", () => {
  const runtime = read("lib/ai/managed-runpod-runtime.ts");
  assert.match(runtime, /await getRunPodProviderConnection\(\)/u);
  assert.equal(runtime.match(/if \(!connection\?\.enabled\) return/g)?.length, 2);
});

test("connected inference exposes recovery after model discovery fails", () => {
  const route = read(
    "app/api/admin/environments/[id]/inference/gateways/[gatewayId]/route.ts"
  );
  const client = read(
    "app/(workspace)/settings/environments/[id]/inference/page-client.tsx"
  );
  assert.match(route, /action: z\.literal\("sync"\)/u);
  assert.match(route, /resyncEnvironmentRunPodEndpoint/u);
  assert.match(client, /Retry discovery/u);
});

test("turn Environment is enforced before runtime credential use", () => {
  assert.match(
    read("lib/agent/kestrel-runtime.ts"),
    /expectedEnvironmentId: input\.environmentId/u
  );
  assert.match(
    read("lib/environments/execution-route.ts"),
    /resolved\.binding\.environmentId !== input\.expectedEnvironmentId/u
  );
  const lease = read("lib/ai/gateway-credential-lease.ts");
  assert.match(
    lease,
    /eq\(schema\.aiGateways\.environmentId, input\.environmentId\)/u
  );
  assert.match(
    lease,
    /eq\(schema\.aiDeployments\.environmentId, input\.environmentId\)/u
  );
});

test("Environment deletion refuses owned private inference", () => {
  const provisioner = read("lib/environments/provisioner.ts");
  assert.match(provisioner, /ENVIRONMENT_HAS_PRIVATE_INFERENCE/u);
  assert.match(
    provisioner,
    /Remove private inference before deleting this Environment/u
  );
});
