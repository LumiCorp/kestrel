import type { McpServerConfig } from "../../../src/mcp/contracts.js";
import { createHash } from "node:crypto";
import type {
  LocalCoreMcpVerificationInput,
  LocalCoreMcpVerificationResult,
} from "../../../src/localCore/mcpVerification.js";
import type {
  DesktopMcpCredentialBinding,
  DesktopMcpServerConfig,
  DesktopMcpServerMutationInput,
} from "./contracts.js";
import {
  hasDesktopStandardAppRequiredTools,
  selectDesktopStandardAppTools,
} from "../../../src/desktopShell/standardAppConnections.js";

export function prepareDesktopMcpVerification(
  input: DesktopMcpServerMutationInput,
): {
  request: LocalCoreMcpVerificationInput;
  bindings: DesktopMcpCredentialBinding[];
} {
  const bindings = (input.credentials ?? []).map((binding) => {
    const suffix = createHash("sha256")
      .update(`${binding.kind}:${binding.name ?? "bearer"}`)
      .digest("hex")
      .slice(0, 16);
    const credentialId =
      binding.credentialId ??
      (`mcp.${input.id}.${binding.kind}.${suffix}` as const);
    const envKey =
      binding.envKey ??
      (binding.kind === "environment"
        ? binding.name!
        : `KESTREL_MCP_${createHash("sha256").update(input.id).digest("hex").slice(0, 12).toUpperCase()}_${suffix.toUpperCase()}`);
    return {
      persisted: {
        kind: binding.kind,
        ...(binding.name !== undefined ? { name: binding.name } : {}),
        credentialId,
        envKey,
        configured: true,
      } satisfies DesktopMcpCredentialBinding,
      request: {
        credentialId,
        envKey,
        ...(binding.secret !== undefined ? { secret: binding.secret } : {}),
      },
    };
  });
  return {
    request: {
      server: toRuntimeServer(
        input,
        bindings.map((binding) => binding.persisted),
      ),
      credentials: bindings.map((binding) => binding.request),
    },
    bindings: bindings.map((binding) => binding.persisted),
  };
}

export function completeDesktopMcpVerification(
  input: DesktopMcpServerMutationInput,
  bindings: DesktopMcpCredentialBinding[],
  result: LocalCoreMcpVerificationResult,
): DesktopMcpServerConfig {
  const tools = selectPublishedAppTools(input, result.tools);
  return {
    id: input.id,
    ...(input.appId !== undefined ? { appId: input.appId } : {}),
    name: input.name,
    transport: input.transport,
    ...(input.transport === "stdio"
      ? { command: input.command!, args: input.args }
      : { url: input.url! }),
    enabled: true,
    source: "Kestrel Desktop",
    sourceKind: "desktop-managed",
    credentials: bindings,
    ...(input.oauthCredentialPrefix !== undefined
      ? { oauthCredentialPrefix: input.oauthCredentialPrefix }
      : {}),
    ...(input.capabilityPacks !== undefined
      ? { capabilityPacks: [...input.capabilityPacks] }
      : {}),
    tools: tools.map((tool) => ({
      ...tool,
      approvalMode: input.toolPolicies?.[tool.name]?.approvalMode ?? "ask",
      allowedInteractionModes: input.toolPolicies?.[tool.name]
        ?.allowedInteractionModes ?? ["build"],
    })),
    toolCount: tools.length,
    verifiedAt: result.verifiedAt,
  };
}

function selectPublishedAppTools(
  input: DesktopMcpServerMutationInput,
  tools: LocalCoreMcpVerificationResult["tools"],
): LocalCoreMcpVerificationResult["tools"] {
  if (input.appId === undefined) return tools;
  const capabilityPacks = input.capabilityPacks ?? [];
  if (
    hasDesktopStandardAppRequiredTools(
      input.appId,
      capabilityPacks,
      tools.map((tool) => tool.name),
    ) === false
  ) {
    throw new Error(
      `${input.name} did not expose the capabilities selected for this App connection.`,
    );
  }
  return selectDesktopStandardAppTools(input.appId, capabilityPacks, tools);
}

function toRuntimeServer(
  input: DesktopMcpServerMutationInput,
  bindings: DesktopMcpCredentialBinding[] = [],
): McpServerConfig {
  const toolMetadata = toToolMetadata(input);
  if (input.transport === "stdio") {
    return {
      id: input.id,
      transport: "stdio",
      command: input.command!,
      ...(input.args !== undefined ? { args: input.args } : {}),
      enabled: true,
      ...(toolMetadata !== undefined ? { toolMetadata } : {}),
    };
  }
  const bearer = bindings.find((binding) => binding.kind === "bearer");
  const headers = bindings.filter((binding) => binding.kind === "header");
  return {
    id: input.id,
    transport: input.transport,
    url: input.url!,
    enabled: true,
    ...(input.oauthCredentialPrefix !== undefined
      ? { oauthCredentialPrefix: input.oauthCredentialPrefix }
      : {}),
    ...(bearer !== undefined ? { authTokenEnv: bearer.envKey } : {}),
    ...(headers.length > 0
      ? {
          headerEnvs: Object.fromEntries(
            headers.map((binding) => [binding.name!, binding.envKey]),
          ),
        }
      : {}),
    ...(toolMetadata !== undefined ? { toolMetadata } : {}),
  };
}

function toToolMetadata(
  input: DesktopMcpServerMutationInput,
): McpServerConfig["toolMetadata"] {
  if (input.toolPolicies === undefined) return;
  return Object.fromEntries(
    Object.entries(input.toolPolicies).map(([toolName, policy]) => [
      toolName,
      {
        displayName: toolName,
        aliases: [],
        keywords: [],
        provider: input.name,
        toolFamily: "mcp",
        capabilityClasses: ["mcp.invoke"],
        approvalMode: policy.approvalMode,
        allowedInteractionModes: policy.allowedInteractionModes,
      },
    ]),
  );
}
