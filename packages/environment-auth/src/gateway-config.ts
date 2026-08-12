export const ENVIRONMENT_GATEWAY_CONFIG_VERSION = 3 as const;

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

export type EnvironmentGatewayAppGrant = {
  executionId: string;
  runId: string | null;
  workspaceId: string;
  executionTicket: string;
  credentialExpiresAt: string;
};

type EnvironmentGatewayConfigBase = {
  environmentId: string;
  revision: string;
  workspaces: Array<{
    id: string;
    machineId: string;
    serviceTokenHash: string;
  }>;
  previews: EnvironmentGatewayPreviewRoute[];
  modelGrants: EnvironmentGatewayModelGrant[];
};

export type EnvironmentGatewayConfigV2 = EnvironmentGatewayConfigBase & {
  version: 2;
  appGrants?: never;
};

export type EnvironmentGatewayConfigV3 = EnvironmentGatewayConfigBase & {
  version: typeof ENVIRONMENT_GATEWAY_CONFIG_VERSION;
  appGrants: EnvironmentGatewayAppGrant[];
};

export type EnvironmentGatewayConfig =
  | EnvironmentGatewayConfigV2
  | EnvironmentGatewayConfigV3;
