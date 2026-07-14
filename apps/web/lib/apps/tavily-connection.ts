const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";

export class TavilyConnectionError extends Error {
  readonly code:
    | "APP_CONNECTION_INVALID"
    | "APP_PROVIDER_UNAVAILABLE"
    | "APP_CONNECTION_TEST_FAILED";

  constructor(code: TavilyConnectionError["code"], message: string) {
    super(message);
    this.name = "TavilyConnectionError";
    this.code = code;
  }
}

export async function validateTavilyConnection(input: {
  apiKey: string;
  projectId?: string | undefined;
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
    const response = await fetchImpl(
      `${(input.baseUrl ?? DEFAULT_TAVILY_BASE_URL).replace(/\/+$/u, "")}/usage`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          ...(input.projectId ? { "X-Project-ID": input.projectId } : {}),
        },
        signal: controller.signal,
      }
    );
    if (response.status === 401 || response.status === 403) {
      throw new TavilyConnectionError(
        "APP_CONNECTION_INVALID",
        "Tavily could not verify this connection key."
      );
    }
    if (!response.ok) {
      throw new TavilyConnectionError(
        "APP_PROVIDER_UNAVAILABLE",
        "Tavily could not verify the connection right now."
      );
    }
    return { status: "connected" as const, checkedAt: new Date() };
  } catch (error) {
    if (error instanceof TavilyConnectionError) throw error;
    throw new TavilyConnectionError(
      "APP_CONNECTION_TEST_FAILED",
      error instanceof Error && error.name === "AbortError"
        ? "Tavily connection verification timed out."
        : "Tavily connection verification failed."
    );
  } finally {
    clearTimeout(timeout);
  }
}
