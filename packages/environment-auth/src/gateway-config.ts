export const ENVIRONMENT_GATEWAY_CONFIG_VERSION = 1 as const;

export type EnvironmentGatewayPreviewRoute = {
  id: string;
  workspaceId: string;
  machineId: string;
  hostname: string;
  port: number;
  expiresAt: string;
  relayTicket: string;
};

export type EnvironmentGatewayModelGrant = {
  runId: string;
  workspaceId: string;
  gatewayId: string;
  rawModelId: string;
  provider:
    | "openai"
    | "openrouter"
    | "anthropic"
    | "ollama"
    | "lumi"
    | "runpod";
  protocol: "openai" | "anthropic";
  baseUrl: string | null;
  apiKey: string | null;
  credentialExpiresAt: string;
};

export type EnvironmentGatewayConfig = {
  version: typeof ENVIRONMENT_GATEWAY_CONFIG_VERSION;
  environmentId: string;
  revision: string;
  ngrok: {
    connectionId: string;
    authtoken: string;
    wildcardDomain: string;
  } | null;
  workspaces: Array<{
    id: string;
    machineId: string;
    serviceTokenHash: string;
  }>;
  previews: EnvironmentGatewayPreviewRoute[];
  modelGrants: EnvironmentGatewayModelGrant[];
};
