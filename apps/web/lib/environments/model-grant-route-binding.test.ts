import assert from "node:assert/strict";
import test from "node:test";

import { modelGrantRouteBinding } from "./model-grant-route-binding";

test("reconstructs a qualified grant binding for every credential reissue path", () => {
  const binding = modelGrantRouteBinding({
    routeBindingStatus: "qualified",
    routeProvider: "openai",
    rawModelId: "gpt-test",
    modelRegistrationId: "registration:gpt-test",
    modelRegistrationRevision: "registration-1",
    modelRegistrationFingerprint: `sha256:${"a".repeat(64)}`,
    modelQualificationRevision: "qualification-1",
    modelApiEndpoint: "https://api.openai.com/v1",
    modelEndpointCodec: "openai_responses_v1",
    modelRoutingPolicyFingerprint: `sha256:${"b".repeat(64)}`,
    modelRequiredRole: "agent.loop",
    gatewayCredentialRevision: 1,
  });

  assert.deepEqual(binding, {
    version: "model_credential_route_binding_v2",
    status: "qualified",
    provider: "openai",
    rawModelId: "gpt-test",
    registrationId: "registration:gpt-test",
    registrationRevision: "registration-1",
    registrationFingerprint: `sha256:${"a".repeat(64)}`,
    qualificationRevision: "qualification-1",
    apiEndpoint: "https://api.openai.com/v1",
    endpointCodec: "openai_responses_v1",
    routingPolicyFingerprint: `sha256:${"b".repeat(64)}`,
    requiredRole: "agent.loop",
    credentialRevision: 1,
  });
});
