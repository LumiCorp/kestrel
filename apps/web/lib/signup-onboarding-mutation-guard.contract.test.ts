import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function route(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

function methodSource(source: string, method: string) {
  const marker = `export async function ${method}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${method} route handler is missing`);
  const next = source.indexOf("export async function ", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function assertGuardPrecedes(
  source: string,
  method: string,
  sideEffect: string,
) {
  const handler = methodSource(source, method);
  const guard = handler.indexOf("signupOnboardingSetupMutationGuard");
  const mutation = handler.indexOf(sideEffect);
  assert.notEqual(guard, -1, `${method} must enforce signup onboarding`);
  assert.notEqual(mutation, -1, `${method} mutation marker is missing`);
  assert.ok(guard < mutation, `${method} must guard before ${sideEffect}`);
}

test("the signup setup guard returns the existing setup-required contract", async () => {
  const source = await route("./signup-onboarding-mutation-guard.ts");
  assert.match(source, /shouldDeferPersonalEnvironmentCreation/u);
  assert.match(source, /code: "ORGANIZATION_SETUP_REQUIRED"/u);
  assert.match(source, /status: 409/u);
});

test("generic organization setup mutations guard before side effects", async () => {
  const [
    gateways,
    gateway,
    sync,
    models,
    validation,
    fly,
    environments,
    setup,
    inference,
    inferenceDefault,
    inferenceGateway,
    inferenceDeployment,
  ] = await Promise.all([
    route("../app/api/organization/ai/gateways/route.ts"),
    route("../app/api/organization/ai/gateways/[id]/route.ts"),
    route("../app/api/organization/ai/gateways/[id]/sync/route.ts"),
    route("../app/api/organization/ai/gateways/[id]/models/route.ts"),
    route(
      "../app/api/organization/ai/gateways/[id]/models/[modelId]/validate/route.ts",
    ),
    route("../app/api/organization/infrastructure/connections/fly/route.ts"),
    route("../app/api/organization/environments/route.ts"),
    route("../app/api/organization/setup/route.ts"),
    route("../app/api/organization/environments/[id]/inference/route.ts"),
    route(
      "../app/api/organization/environments/[id]/inference/default/route.ts",
    ),
    route(
      "../app/api/organization/environments/[id]/inference/gateways/[gatewayId]/route.ts",
    ),
    route(
      "../app/api/organization/environments/[id]/inference/deployments/[deploymentId]/route.ts",
    ),
  ]);

  assertGuardPrecedes(gateways, "POST", "createGateway(");
  assertGuardPrecedes(gateway, "PUT", "updateGateway(");
  assertGuardPrecedes(gateway, "DELETE", "deleteGateway(");
  assertGuardPrecedes(sync, "POST", "syncGatewayModels(");
  assertGuardPrecedes(models, "POST", "saveGatewayModel(");
  assertGuardPrecedes(models, "DELETE", "deleteGatewayModel(");
  assertGuardPrecedes(validation, "POST", "validateRunPodGatewayModel(");
  assertGuardPrecedes(fly, "POST", "testFlyProviderConnection(");
  assertGuardPrecedes(environments, "PATCH", "setAdminEnvironmentRollout(");
  assertGuardPrecedes(environments, "POST", "createAdminEnvironment(");
  assertGuardPrecedes(setup, "POST", "recoverAdminDefaultEnvironment(");
  assertGuardPrecedes(
    inference,
    "POST",
    "connectEnvironmentRunPodEndpoint(",
  );
  assertGuardPrecedes(
    inferenceDefault,
    "PUT",
    "setEnvironmentDefaultModel(",
  );
  assertGuardPrecedes(
    inferenceGateway,
    "POST",
    "resyncEnvironmentRunPodEndpoint(",
  );
  assertGuardPrecedes(
    inferenceGateway,
    "DELETE",
    "removeEnvironmentConnectedEndpoint(",
  );
  assertGuardPrecedes(
    inferenceDeployment,
    "POST",
    "queueManagedRunPodRetry(",
  );
  assertGuardPrecedes(
    inferenceDeployment,
    "DELETE",
    "queueManagedRunPodDeletion(",
  );
});

test("generic organization setup reads remain available", async () => {
  const [gateways, gateway, models, fly, environments, setup, inference] =
    await Promise.all([
      route("../app/api/organization/ai/gateways/route.ts"),
      route("../app/api/organization/ai/gateways/[id]/route.ts"),
      route("../app/api/organization/ai/gateways/[id]/models/route.ts"),
      route("../app/api/organization/infrastructure/connections/fly/route.ts"),
      route("../app/api/organization/environments/route.ts"),
      route("../app/api/organization/setup/route.ts"),
      route("../app/api/organization/environments/[id]/inference/route.ts"),
    ]);

  for (const source of [
    gateways,
    gateway,
    models,
    fly,
    environments,
    setup,
    inference,
  ]) {
    assert.doesNotMatch(
      methodSource(source, "GET"),
      /signupOnboardingSetupMutationGuard/u,
    );
  }
});
