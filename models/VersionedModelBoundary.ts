import type {
  ModelGatewayCallOptions,
  ModelRequest,
  ModelResponse,
} from "../src/kestrel/contracts/model-io.js";
import {
  normalizeModelRequestV1,
  normalizeModelRequestV2,
  normalizeModelResponseV1,
} from "../src/kestrel/contracts/model-registration.js";

export type VersionedProviderInvokerV1 = <TOutput>(
  request: ModelRequest,
  options?: ModelGatewayCallOptions,
) => Promise<ModelResponse<TOutput>>;

/**
 * Provider entry preserves V1 behavior. V2 calls must enter through an exact
 * codec and verifier; the V1 adapters cannot truthfully satisfy V2
 * requirements or produce its terminal proof.
 */
export function createVersionedProviderInvokerV1(
  invoke: VersionedProviderInvokerV1,
): VersionedProviderInvokerV1 {
  return async <TOutput>(
    request: ModelRequest,
    options?: ModelGatewayCallOptions,
  ): Promise<ModelResponse<TOutput>> => {
    if ((request as { version?: string }).version === "model_request_v2") {
      normalizeModelRequestV2(request);
      throw new Error(
        "model_request_v2 requires an exact provider codec and response verifier",
      );
    }
    const response = await invoke<TOutput>(
      normalizeModelRequestV1(request),
      options,
    );
    return normalizeModelResponseV1(response);
  };
}
