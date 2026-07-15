const DEFAULT_VISUAL_CROSSING_BASE_URL =
  "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/";

export class WeatherConnectionError extends Error {
  readonly code:
    | "APP_CONNECTION_INVALID"
    | "APP_PROVIDER_UNAVAILABLE"
    | "APP_CONNECTION_TEST_FAILED";

  constructor(code: WeatherConnectionError["code"], message: string) {
    super(message);
    this.name = "WeatherConnectionError";
    this.code = code;
  }
}

export async function validateVisualCrossingConnection(input: {
  apiKey: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 10_000
  );
  try {
    const baseUrl = ensureTrailingSlash(
      input.baseUrl ?? DEFAULT_VISUAL_CROSSING_BASE_URL
    );
    const url = new URL("0,0", baseUrl);
    url.searchParams.set("key", input.apiKey);
    url.searchParams.set("unitGroup", "metric");
    url.searchParams.set("include", "current");
    url.searchParams.set("contentType", "json");
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new WeatherConnectionError(
        "APP_CONNECTION_INVALID",
        "Visual Crossing could not verify this connection key."
      );
    }
    if (!response.ok) {
      throw new WeatherConnectionError(
        "APP_PROVIDER_UNAVAILABLE",
        "Visual Crossing could not verify the connection right now."
      );
    }
    return { status: "connected" as const, checkedAt: new Date() };
  } catch (error) {
    if (error instanceof WeatherConnectionError) throw error;
    throw new WeatherConnectionError(
      "APP_CONNECTION_TEST_FAILED",
      error instanceof Error && error.name === "AbortError"
        ? "Visual Crossing connection verification timed out."
        : "Visual Crossing connection verification failed."
    );
  } finally {
    clearTimeout(timeout);
  }
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
