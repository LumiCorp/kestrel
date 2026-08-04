import type {
  ModelGatewayCallOptions,
  ModelRequest,
  ModelResponse,
} from "../src/kestrel/contracts/model-io.js";
import {
  normalizeModelRequestV1,
  normalizeModelResponseV1,
} from "../src/kestrel/contracts/model-registration.js";

export type VersionedProviderInvokerV1 = <TOutput>(
  request: ModelRequest,
  options?: ModelGatewayCallOptions,
) => Promise<ModelResponse<TOutput>>;

/**
 * Provider entry is the temporary V0 migration seam. Legacy callers are
 * upgraded once here, then provider responses are returned in the V1 envelope.
 */
export function createVersionedProviderInvokerV1(
  invoke: VersionedProviderInvokerV1,
): VersionedProviderInvokerV1 {
  return async <TOutput>(
    request: ModelRequest,
    options?: ModelGatewayCallOptions,
  ): Promise<ModelResponse<TOutput>> => {
    const response = await invoke<TOutput>(normalizeModelRequestV1(request), options);
    return normalizeModelResponseV1(response);
  };
}
