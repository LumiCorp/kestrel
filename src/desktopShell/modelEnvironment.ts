import type { ResolvedModelPolicy } from "../profile/modelPolicy.js";
import type { DesktopSettings } from "./contracts.js";

export function buildDesktopModelEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  settings: Partial<DesktopSettings>,
  modelPolicy: ResolvedModelPolicy,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
  };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_MODEL;
  delete env.OPENROUTER_BASE_URL;
  delete env.OPENROUTER_SITE_URL;
  delete env.OPENROUTER_APP_NAME;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_MODEL;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_ORG_ID;
  delete env.OPENAI_PROJECT_ID;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_MODEL;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_VERSION;
  delete env.OLLAMA_MODEL;
  delete env.OLLAMA_BASE_URL;
  delete env.LMSTUDIO_MODEL;
  delete env.LMSTUDIO_BASE_URL;
  delete env.TAVILY_API_KEY;
  delete env.TAVILY_BASE_URL;
  delete env.TAVILY_PROJECT;
  delete env.TAVILY_HTTP_PROXY;
  delete env.TAVILY_HTTPS_PROXY;

  if (modelPolicy.provider === "openrouter") {
    if (settings.openrouterApiKey !== undefined) {
      env.OPENROUTER_API_KEY = settings.openrouterApiKey;
    }
    env.OPENROUTER_MODEL = modelPolicy.model;
    if (settings.openrouterBaseUrl !== undefined) {
      env.OPENROUTER_BASE_URL = settings.openrouterBaseUrl;
    }
    if (settings.openrouterSiteUrl !== undefined) {
      env.OPENROUTER_SITE_URL = settings.openrouterSiteUrl;
    }
    if (settings.openrouterAppName !== undefined) {
      env.OPENROUTER_APP_NAME = settings.openrouterAppName;
    }
  } else if (modelPolicy.provider === "openai") {
    if (settings.openaiApiKey !== undefined) {
      env.OPENAI_API_KEY = settings.openaiApiKey;
    }
    env.OPENAI_MODEL = modelPolicy.model;
    if (settings.openaiBaseUrl !== undefined) {
      env.OPENAI_BASE_URL = settings.openaiBaseUrl;
    }
    if (settings.openaiOrgId !== undefined) {
      env.OPENAI_ORG_ID = settings.openaiOrgId;
    }
    if (settings.openaiProjectId !== undefined) {
      env.OPENAI_PROJECT_ID = settings.openaiProjectId;
    }
  } else if (modelPolicy.provider === "anthropic") {
    if (settings.anthropicApiKey !== undefined) {
      env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
    }
    env.ANTHROPIC_MODEL = modelPolicy.model;
    if (settings.anthropicBaseUrl !== undefined) {
      env.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;
    }
    if (settings.anthropicVersion !== undefined) {
      env.ANTHROPIC_VERSION = settings.anthropicVersion;
    }
  } else if (modelPolicy.provider === "ollama") {
    env.OLLAMA_MODEL = modelPolicy.model;
    if (settings.ollamaBaseUrl !== undefined) {
      env.OLLAMA_BASE_URL = settings.ollamaBaseUrl;
    }
  } else if (modelPolicy.provider === "lmstudio") {
    env.LMSTUDIO_MODEL = modelPolicy.model;
    if (settings.lmstudioBaseUrl !== undefined) {
      env.LMSTUDIO_BASE_URL = settings.lmstudioBaseUrl;
    }
  }
  if (settings.tavilyApiKey !== undefined) {
    env.TAVILY_API_KEY = settings.tavilyApiKey;
  }
  if (settings.tavilyBaseUrl !== undefined) {
    env.TAVILY_BASE_URL = settings.tavilyBaseUrl;
  }
  if (settings.tavilyProject !== undefined) {
    env.TAVILY_PROJECT = settings.tavilyProject;
  }
  if (settings.tavilyHttpProxy !== undefined) {
    env.TAVILY_HTTP_PROXY = settings.tavilyHttpProxy;
  }
  if (settings.tavilyHttpsProxy !== undefined) {
    env.TAVILY_HTTPS_PROXY = settings.tavilyHttpsProxy;
  }

  return env;
}
