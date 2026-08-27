import {
  parseModelCredentialRouteBindingV2,
  type ModelCredentialRouteBindingV2,
} from "../../../../src/kestrel/contracts/model-route";

type StoredModelGrantRouteBinding = {
  routeBindingStatus: "qualified" | "legacy_unqualified" | null;
  routeProvider: string | null;
  rawModelId: string;
  modelRegistrationId: string | null;
  modelRegistrationRevision: string | null;
  modelRegistrationFingerprint: string | null;
  modelQualificationRevision: string | null;
  modelApiEndpoint: string | null;
  modelEndpointCodec: string | null;
  modelRoutingPolicyFingerprint: string | null;
  modelRequiredRole: string | null;
  gatewayCredentialRevision: number | null;
};

/** Reconstructs the immutable route snapshot persisted with an active grant. */
export function modelGrantRouteBinding(
  grant: StoredModelGrantRouteBinding,
): ModelCredentialRouteBindingV2 | undefined {
  if (grant.routeBindingStatus === null) return;
  if (grant.routeBindingStatus === "legacy_unqualified") {
    return parseModelCredentialRouteBindingV2({
      version: "model_credential_route_binding_v2",
      status: "legacy_unqualified",
      provider: grant.routeProvider,
      rawModelId: grant.rawModelId,
    });
  }
  return parseModelCredentialRouteBindingV2({
    version: "model_credential_route_binding_v2",
    status: "qualified",
    provider: grant.routeProvider,
    rawModelId: grant.rawModelId,
    registrationId: grant.modelRegistrationId,
    registrationRevision: grant.modelRegistrationRevision,
    registrationFingerprint: grant.modelRegistrationFingerprint,
    qualificationRevision: grant.modelQualificationRevision,
    apiEndpoint: grant.modelApiEndpoint,
    endpointCodec: grant.modelEndpointCodec,
    routingPolicyFingerprint: grant.modelRoutingPolicyFingerprint,
    requiredRole: grant.modelRequiredRole,
    credentialRevision: grant.gatewayCredentialRevision,
  });
}
