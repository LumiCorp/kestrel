export type AuthorizedMcpGrant = {
  id: string;
  runExecutionId: string;
  workspaceId: string;
  organizationId: string;
  environmentId: string;
  projectId: string | null;
  threadId: string;
  policyDigest: string;
  expiresAt: Date;
  capabilities: Array<{
    id: string;
    kind:
      | "tool"
      | "resource"
      | "resource_template"
      | "prompt"
      | "root"
      | "sampling"
      | "elicitation"
      | "completion"
      | "logging"
      | "task";
    capabilityKey: string;
    toolCapabilityKey: string | null;
    approvalMode: "auto" | "ask";
    definition: Record<string, unknown>;
    serverId: string;
  }>;
  servers: AuthorizedMcpServer[];
};

type AuthorizedMcpServerBase = {
  id: string;
  name: string;
  transport: "streamable_http" | "stdio";
  launchArguments: string[];
  egressAllowlist: string[];
  resources: {
    cpuMillicores: number;
    memoryMib: number;
    pidsLimit: number;
  };
  credential:
    | {
        id: string;
        kind: "oauth" | "secret_headers";
        encryptedPayload: string;
      }
    | undefined;
};

export type AuthorizedMcpServer = AuthorizedMcpServerBase &
  (
    | {
        sourceType: "remote";
        transport: "streamable_http";
        remoteUrl: string;
      }
    | {
        sourceType: "oci";
        imageReference: string;
        digest: string;
      }
  );

export interface McpGrantStore {
  activateGrant(input: {
    grantId: string;
    runExecutionId: string;
    organizationId: string;
    environmentId: string;
    threadId: string;
    now: Date;
  }): Promise<AuthorizedMcpGrant | null>;
}
