import {
  createToolProviderConfigurationResolver,
  createToolProviderRuntimeConfiguration,
  type ToolProviderConfigurationResolver,
} from "./runtimeConfiguration.js";

/**
 * Translate the compatibility environment boundary once, before shared tool
 * handlers are created. Provider adapters receive only their exact scoped
 * configuration from this resolver.
 */
export function createToolProviderConfigurationResolverFromEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
): ToolProviderConfigurationResolver {
  return createToolProviderConfigurationResolver([
    createToolProviderRuntimeConfiguration({
      providerKey: "tavily",
      credential: env.TAVILY_API_KEY,
      baseUrl: env.TAVILY_BASE_URL,
      settings: {
        projectId: env.TAVILY_PROJECT,
        httpProxy: env.TAVILY_HTTP_PROXY,
        httpsProxy: env.TAVILY_HTTPS_PROXY,
      },
    }),
    createToolProviderRuntimeConfiguration({
      providerKey: "visual-crossing",
      credential: env.VISUAL_CROSSING_API_KEY,
      baseUrl: env.VISUAL_CROSSING_BASE_URL,
    }),
  ]);
}
