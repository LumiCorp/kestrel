export const HOSTED_MCP_PROTOCOL_VERSION = "2025-11-25" as const;

export interface HostedMcpContext {
  gatewayUrl: string;
  grantId: string;
  protocolVersion: typeof HOSTED_MCP_PROTOCOL_VERSION;
  organizationId: string;
  environmentId: string;
  projectId?: string | undefined;
  threadId: string;
}

export interface HostedMcpRuntimeConnection {
  context: HostedMcpContext;
  executionTicket: string;
}

export interface HostedMcpAuthorization {
  executionTicket: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseHostedMcpContext(
  value: unknown,
  fieldName = "mcpContext"
): HostedMcpContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const context = value as Record<string, unknown>;
  const gatewayUrl = requireNonEmptyString(
    context.gatewayUrl,
    `${fieldName}.gatewayUrl`
  );
  let parsedGatewayUrl: URL;
  try {
    parsedGatewayUrl = new URL(gatewayUrl);
  } catch {
    throw new Error(`${fieldName}.gatewayUrl must be an absolute URL`);
  }
  if (
    parsedGatewayUrl.protocol !== "https:" &&
    parsedGatewayUrl.protocol !== "http:"
  ) {
    throw new Error(`${fieldName}.gatewayUrl must use http or https`);
  }
  if (parsedGatewayUrl.username || parsedGatewayUrl.password) {
    throw new Error(`${fieldName}.gatewayUrl must not contain credentials`);
  }

  const grantId = requireNonEmptyString(
    context.grantId,
    `${fieldName}.grantId`
  );
  if (!UUID_PATTERN.test(grantId)) {
    throw new Error(`${fieldName}.grantId must be a UUID`);
  }

  const organizationId = requireNonEmptyString(
    context.organizationId,
    `${fieldName}.organizationId`
  );
  const environmentId = requireNonEmptyString(
    context.environmentId,
    `${fieldName}.environmentId`
  );
  const threadId = requireNonEmptyString(
    context.threadId,
    `${fieldName}.threadId`
  );
  const projectId = optionalNonEmptyString(
    context.projectId,
    `${fieldName}.projectId`
  );

  if (context.protocolVersion !== HOSTED_MCP_PROTOCOL_VERSION) {
    throw new Error(
      `${fieldName}.protocolVersion must be '${HOSTED_MCP_PROTOCOL_VERSION}'`
    );
  }

  return {
    gatewayUrl,
    grantId,
    protocolVersion: HOSTED_MCP_PROTOCOL_VERSION,
    organizationId,
    environmentId,
    ...(projectId !== undefined ? { projectId } : {}),
    threadId,
  };
}

export function parseHostedMcpRuntimeConnection(input: {
  mcpContext: unknown;
  mcpAuthorization: unknown;
}): HostedMcpRuntimeConnection {
  const context = parseHostedMcpContext(input.mcpContext);
  const authorization = asRecord(input.mcpAuthorization);
  const executionTicket = requireNonEmptyString(
    authorization?.executionTicket,
    "mcpAuthorization.executionTicket"
  );
  return { context, executionTicket };
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(
  value: unknown,
  fieldName: string
): string | undefined {
  if (value === undefined) {
    return;
  }
  return requireNonEmptyString(value, fieldName);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}
