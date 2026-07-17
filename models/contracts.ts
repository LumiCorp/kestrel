import type { ModelGatewayCallOptions, ModelRequest, ModelResponse, ModelToolIntent } from "../src/kestrel/contracts/model-io.js";


export type OpenRouterEndpoint = "chat" | "responses";

export interface OpenRouterEnvConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  siteUrl?: string | undefined;
  appName?: string | undefined;
}

export interface OpenAiEnvConfig {
  apiKey?: string | undefined;
  model: string;
  baseUrl: string;
  providerName: "openai" | "ollama" | "lmstudio" | "lumi" | "runpod";
  providerLabel: string;
  organization?: string | undefined;
  project?: string | undefined;
}

export interface AnthropicEnvConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  version: string;
}

export interface OpenRouterHttpRequest {
  endpoint: OpenRouterEndpoint;
  model: string;
  path: string;
  body: Record<string, unknown>;
  structuredOutput?:
    | {
        mode: "constrained" | "json_object";
        schemaName?: string | undefined;
        compilerDiagnostics?: Record<string, unknown> | undefined;
      }
    | undefined;
}

export interface OpenRouterMappedResponse<TOutput> extends ModelResponse<TOutput> {}

export interface OpenRouterResponseContext {
  endpoint: OpenRouterEndpoint;
  requestedModel: string;
  requestId?: string | undefined;
  structuredOutput?: OpenRouterHttpRequest["structuredOutput"] | undefined;
}

export type OpenRouterInvoker = <TOutput>(
  request: ModelRequest,
  options?: ModelGatewayCallOptions
) => Promise<ModelResponse<TOutput>>;

export type OpenAiInvoker = <TOutput>(
  request: ModelRequest,
  options?: ModelGatewayCallOptions
) => Promise<ModelResponse<TOutput>>;

export type AnthropicInvoker = <TOutput>(
  request: ModelRequest,
  options?: ModelGatewayCallOptions
) => Promise<ModelResponse<TOutput>>;

export interface ParsedToolIntent {
  intents: ModelToolIntent[];
}
