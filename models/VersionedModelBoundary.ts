import type {
  ModelGatewayCallOptions,
  ModelRequest,
  ModelResponse,
} from "../src/kestrel/contracts/model-io.js";
import {
  normalizeModelRequestV1,
  normalizeModelRequestV2,
  normalizeModelResponseV1,
  normalizeModelResponseV2,
} from "../src/kestrel/contracts/model-registration.js";

export type VersionedProviderInvokerV1 = <TOutput>(
  request: ModelRequest,
  options?: ModelGatewayCallOptions,
) => Promise<ModelResponse<TOutput>>;

/**
 * Provider entry preserves V1 behavior and carries V2 contracts intact. V2
 * callers receive a V2 terminal envelope; provider codecs remain responsible
 * for their own transport behavior until their dedicated slices land.
 */
export function createVersionedProviderInvokerV1(
  invoke: VersionedProviderInvokerV1,
): VersionedProviderInvokerV1 {
  return async <TOutput>(
    request: ModelRequest,
    options?: ModelGatewayCallOptions,
  ): Promise<ModelResponse<TOutput>> => {
    if ((request as { version?: string }).version === "model_request_v2") {
      const response = await invoke<TOutput>(
        normalizeModelRequestV2(request),
        options,
      );
      return normalizeModelResponseV2(response);
    }
    const response = await invoke<TOutput>(
      normalizeModelRequestV1(request),
      options,
    );
    return normalizeModelResponseV1(response);
  };
}
