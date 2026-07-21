import { createTavilyClient } from "../../../tools/internet/client.js";
import { verifyVisualCrossingCredential } from "../../../tools/free/visualCrossingWeather.js";
import type { DesktopCapabilityId, DesktopSettings } from "./contracts.js";

export class DesktopToolProviderVerificationError extends Error {
  readonly code = "DESKTOP_TOOL_PROVIDER_VERIFICATION_FAILED";

  constructor(capabilityId: DesktopCapabilityId, detail: string) {
    super(`${capabilityId} verification failed. ${detail}`);
    this.name = "DesktopToolProviderVerificationError";
  }
}

export async function verifyDesktopToolProvider(input: {
  capabilityId: "tools.internet.tavily" | "tools.weather";
  credential: string;
  settings: DesktopSettings;
  tavilyClientFactory?: typeof createTavilyClient | undefined;
  visualCrossingVerifier?: typeof verifyVisualCrossingCredential | undefined;
}): Promise<void> {
  try {
    if (input.capabilityId === "tools.weather") {
      await (input.visualCrossingVerifier ?? verifyVisualCrossingCredential)({
        apiKey: input.credential,
      });
      return;
    }
    const client = (input.tavilyClientFactory ?? createTavilyClient)({
      apiKey: input.credential,
      baseUrl: input.settings.tavilyBaseUrl,
      projectId: input.settings.tavilyProject,
      httpProxy: input.settings.tavilyHttpProxy,
      httpsProxy: input.settings.tavilyHttpsProxy,
      env: Object.create(null) as NodeJS.ProcessEnv,
    });
    await client.search("Kestrel capability verification", {
      maxResults: 1,
      searchDepth: "basic",
      timeout: 5,
    });
  } catch {
    throw new DesktopToolProviderVerificationError(
      input.capabilityId,
      "Check the credential, endpoint, proxy settings, and network connection, then try again.",
    );
  }
}
