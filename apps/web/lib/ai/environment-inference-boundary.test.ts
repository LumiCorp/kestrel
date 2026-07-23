import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const read = (relativePath: string) =>
  fs.readFileSync(path.join(appRoot, relativePath), "utf8");

contractTest("web.hermetic", "Environment inference routes use organization-admin authority", () => {
  for (const route of [
    "app/api/organization/environments/[id]/inference/route.ts",
    "app/api/organization/environments/[id]/inference/deployments/[deploymentId]/route.ts",
    "app/api/organization/environments/[id]/inference/gateways/[gatewayId]/route.ts",
    "app/api/organization/environments/[id]/inference/default/route.ts",
  ]) {
    assert.match(read(route), /requireOrganizationAdmin/u);
  }
});

contractTest("web.hermetic", "connected inference remains independent from the managed feature gate", () => {
  const route = read("app/api/organization/environments/[id]/inference/route.ts");
  const connectedBranch = route.indexOf('body.kind === "connected"');
  const managedGate = route.indexOf("assertManagedRunPodEnabled()");
  assert.ok(connectedBranch >= 0);
  assert.ok(managedGate > connectedBranch);
  assert.match(route, /assertEnvironmentPrivateInferenceEnabled/u);
});

contractTest("web.hermetic", "managed jobs are produced by Vercel and consumed by the persistent worker", () => {
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

contractTest("web.hermetic", "managed maintenance idles until its provider connection is enabled", () => {
  const runtime = read("lib/ai/managed-runpod-runtime.ts");
  assert.equal(
    runtime.match(/await listEnabledRunPodProviderConnections\(\)/gu)?.length,
    2
  );
  assert.equal(
    runtime.match(/if \(!connection\.organizationId\) continue;/gu)?.length,
    2
  );
});

contractTest("web.hermetic", "Qwen bootstrap preserves the administrator-selected credential source", () => {
  const bootstrap = read("scripts/bootstrap-qwen3-runpod-profile.ts");
  assert.match(
    bootstrap,
    /await testRunPodProviderConnection\(\{ organizationId \}\)/u
  );
  assert.doesNotMatch(bootstrap, /configureRunPodProviderConnection/u);
  assert.doesNotMatch(bootstrap, /useEnvironment/u);
});

contractTest("web.hermetic", "managed inference validates the declared model without discovery", () => {
  const runtime = read("lib/ai/managed-runpod-runtime.ts");
  assert.match(
    runtime,
    /validateRunPodToolRoundTrip\([\s\S]{0,240}model: profile\.expectedModelId/u
  );
  assert.match(
    runtime,
    /validateRunPodGatewayModelByRawId\([\s\S]{0,180}rawModelId: snapshot\.expectedModelId/u
  );
  assert.match(
    runtime,
    /timeoutMs: runPodEndpointSpecSchema[\s\S]{0,100}executionTimeoutMs/u
  );
  assert.match(
    runtime,
    /timeoutMs: snapshot\.endpointSpec\.executionTimeoutMs/u
  );
  assert.doesNotMatch(runtime, /\/models/u);
});

contractTest("web.hermetic", "qualification warms one temporary worker without changing scale-to-zero deployments", () => {
  const runtime = read("lib/ai/managed-runpod-runtime.ts");
  const profile = read("lib/ai/qwen3-runpod-profile.ts");
  assert.match(
    runtime,
    /processQualification[\s\S]*workersMin: 1[\s\S]*validateRunPodToolRoundTrip/u
  );
  assert.match(profile, /workersMin: 0/u);
});

contractTest("web.hermetic", "connected inference supports explicit model validation when discovery fails", () => {
  const route = read(
    "app/api/organization/environments/[id]/inference/gateways/[gatewayId]/route.ts"
  );
  const connectRoute = read(
    "app/api/organization/environments/[id]/inference/route.ts"
  );
  const client = read(
    "app/(workspace)/settings/environments/[id]/inference/page-client.tsx"
  );
  assert.match(route, /action: z\.literal\("sync"\)/u);
  assert.match(route, /action: z\.literal\("validate_served_model"\)/u);
  assert.match(route, /resyncEnvironmentRunPodEndpoint/u);
  assert.match(connectRoute, /servedModelId/u);
  assert.match(client, /Validate model/u);
  assert.match(client, /Retry discovery/u);
  assert.match(client, /Queue-only \/run and \/runsync/u);
});

contractTest("web.hermetic", "manual RunPod model validation still requires tool round-trip evidence", () => {
  const gateways = read("lib/ai/gateways.ts");
  assert.match(
    gateways,
    /validateRunPodGatewayModelByRawId[\s\S]*approved: false[\s\S]*validateRunPodGatewayModel\(/u
  );
  assert.match(
    gateways,
    /validateRunPodGatewayModelByRawId[\s\S]*validateRunPodGatewayModel\([\s\S]*approved: true/u
  );
});

contractTest("web.hermetic", "turn Environment is enforced before runtime credential use", () => {
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

contractTest("web.hermetic", "Environment deletion refuses owned private inference", () => {
  const provisioner = read("lib/environments/provisioner.ts");
  assert.match(provisioner, /ENVIRONMENT_HAS_PRIVATE_INFERENCE/u);
  assert.match(
    provisioner,
    /Remove private inference before deleting this Environment/u
  );
});

contractTest("web.hermetic", "private inference creation shares the Environment lifecycle lock", () => {
  const gateways = read("lib/ai/gateways.ts");
  const managedStore = read("lib/ai/managed-runpod-store.ts");

  for (const source of [gateways, managedStore]) {
    assert.match(source, /environmentLifecycleLockKey/u);
    assert.match(
      source,
      /pg_advisory_xact_lock\(hashtextextended\(\$\{environmentLifecycleLockKey\(/u
    );
    assert.match(
      source,
      /notInArray\([^\n]+status, \["deleting", "deleted"\]\)/u
    );
  }
});
