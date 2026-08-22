import { GatewayModelProviderResolutionError } from "./gateway-lifecycle-error";
import { validateOpenRouterModelDetails } from "./model-economics-profile";

export async function fetchOpenRouterModelDetailsWithCredentials(input: {
  baseUrl: string;
  apiKey: string;
  rawModelId: string;
  timeoutMs?: number;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<Record<string, unknown>> {
  const { baseUrl, apiKey, rawModelId } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const parts = rawModelId.split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) {
    throw new GatewayModelProviderResolutionError({
      message: `OpenRouter model ID '${rawModelId}' must use the exact author/slug form.`,
    });
  }
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await fetchImpl(
      `${baseUrl}/model/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: timeoutSignal },
    );
  } catch (error) {
    throw new GatewayModelProviderResolutionError({
      message:
        timeoutSignal.aborted || (error instanceof DOMException && error.name === "TimeoutError")
          ? `OpenRouter model resolution timed out for ${rawModelId}. Try again.`
          : `OpenRouter model resolution failed for ${rawModelId}. Try again.`,
      status: 503,
      retryable: true,
    });
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    if (timeoutSignal.aborted) {
      throw new GatewayModelProviderResolutionError({
        message: `OpenRouter model resolution timed out for ${rawModelId}. Try again.`,
        status: 503,
        retryable: true,
      });
    }
    json = null;
  }
  if (!response.ok) {
    const isAuthFailure = response.status === 401 || response.status === 403;
    const retryableStatus = [408, 425, 429].includes(response.status) || response.status >= 500;
    throw new GatewayModelProviderResolutionError({
      message:
        response.status === 404
          ? `OpenRouter model '${rawModelId}' was not found.`
          : isAuthFailure
            ? `OpenRouter rejected the gateway credential while resolving ${rawModelId}. Update the credential and try again.`
            : `OpenRouter model resolution failed for ${rawModelId}.`,
      status: response.status === 404 ? 422 : isAuthFailure ? response.status : 503,
      retryable: retryableStatus,
    });
  }
  return validateOpenRouterModelDetails({ requestedModelId: rawModelId, response: json });
}
