export type McpServerTransport = "stdio" | "http" | "sse";

export interface McpToolPresentationMetadata {
  displayName: string;
  aliases: string[];
  keywords: string[];
  provider: string;
  toolFamily: string;
  capabilityClasses: string[];
  approvalMode?: "auto" | "ask" | undefined;
}

export interface McpServerCommonConfig {
  id: string;
  enabled?: boolean | undefined;
  toolMetadata?: Record<string, McpToolPresentationMetadata> | undefined;
}

export interface McpStdioServerConfig extends McpServerCommonConfig {
  transport: "stdio";
  command: string;
  args?: string[] | undefined;
}

export interface McpRemoteServerConfig extends McpServerCommonConfig {
  transport: "http" | "sse";
  url: string;
  authTokenEnv?: string | undefined;
  headerEnvs?: Record<string, string> | undefined;
}

export type McpHttpServerConfig = McpRemoteServerConfig & {
  transport: "http";
};

export type McpSseServerConfig = McpRemoteServerConfig & {
  transport: "sse";
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface McpDiscoveredTool {
  serverId: string;
  toolName: string;
  namespacedToolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  presentation?: McpToolPresentationMetadata | undefined;
  allowlisted?: boolean | undefined;
  protocolKind?: "tool" | "resource" | "resource_template" | "prompt" | undefined;
  protocolTarget?: string | undefined;
}

export interface McpServerStatus {
  serverId: string;
  transport: McpServerTransport;
  healthy: boolean;
  connected: boolean;
  enabled: boolean;
  toolCount: number;
  checkedAt: string;
  error?: string | undefined;
}

export interface McpStatusSnapshot {
  healthy: boolean;
  checkedAt: string;
  servers: McpServerStatus[];
  tools: McpDiscoveredTool[];
}
