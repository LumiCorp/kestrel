import type {
  ApprovalCapabilityClass,
  ExecutionPolicyOverride,
  ToolExecutionClass,
} from "../../src/index.js";

const TOOL_CLASSES: ToolExecutionClass[] = [
  "read_only",
  "sandboxed_only",
  "external_side_effect",
];

const CAPABILITY_CLASSES: ApprovalCapabilityClass[] = [
  "workspace.read",
  "workspace.write",
  "shell.exec",
  "project.board.write",
  "network.call",
  "code.execute",
  "mcp.invoke",
  "delegation.control",
  "external.confirm",
];

export interface ApprovalPolicyPack {
  id: "dev" | "ci_bot" | "production";
  label: string;
  defaultDeny: true;
  allowedToolClasses: ToolExecutionClass[];
  allowedCapabilities: ApprovalCapabilityClass[];
  strictApprovalPerCall: boolean;
}

const APPROVAL_POLICY_PACKS: Record<ApprovalPolicyPack["id"], ApprovalPolicyPack> = {
  dev: {
    id: "dev",
    label: "Developer",
    defaultDeny: true,
    allowedToolClasses: ["read_only", "sandboxed_only", "external_side_effect"],
    allowedCapabilities: ["workspace.read", "workspace.write", "shell.exec", "network.call", "mcp.invoke", "external.confirm"],
    strictApprovalPerCall: false,
  },
  ci_bot: {
    id: "ci_bot",
    label: "CI Bot",
    defaultDeny: true,
    allowedToolClasses: ["read_only", "sandboxed_only"],
    allowedCapabilities: ["workspace.read", "workspace.write", "shell.exec", "code.execute"],
    strictApprovalPerCall: true,
  },
  production: {
    id: "production",
    label: "Production",
    defaultDeny: true,
    allowedToolClasses: ["read_only"],
    allowedCapabilities: ["workspace.read"],
    strictApprovalPerCall: true,
  },
};

export function listApprovalPolicyPacks(): ApprovalPolicyPack[] {
  return Object.values(APPROVAL_POLICY_PACKS).map(clonePack);
}

export function getApprovalPolicyPack(
  id: ApprovalPolicyPack["id"] | undefined,
): ApprovalPolicyPack {
  return clonePack(APPROVAL_POLICY_PACKS[id ?? "dev"]);
}

export function buildExecutionPolicyFromPack(
  id: ApprovalPolicyPack["id"] | undefined,
): ExecutionPolicyOverride {
  const pack = getApprovalPolicyPack(id);
  const toolClassPolicy = Object.fromEntries(
    TOOL_CLASSES.map((toolClass) => [toolClass, pack.allowedToolClasses.includes(toolClass)]),
  ) as NonNullable<ExecutionPolicyOverride["toolClassPolicy"]>;
  const capabilityPolicy = Object.fromEntries(
    CAPABILITY_CLASSES.map((capability) => [capability, pack.allowedCapabilities.includes(capability)]),
  ) as NonNullable<ExecutionPolicyOverride["capabilityPolicy"]>;
  return {
    toolClassPolicy,
    capabilityPolicy,
    approvalPolicy: {
      strictApprovalPerCall: pack.strictApprovalPerCall,
    },
  };
}

export function mergeExecutionPolicies(
  base: ExecutionPolicyOverride,
  override: ExecutionPolicyOverride | undefined,
): ExecutionPolicyOverride {
  if (override === undefined) {
    return base;
  }
  return {
    ...base,
    ...(override.toolClassPolicy !== undefined
      ? {
          toolClassPolicy: {
            ...(base.toolClassPolicy ?? {}),
            ...override.toolClassPolicy,
          },
        }
      : {}),
    ...(override.capabilityPolicy !== undefined
      ? {
          capabilityPolicy: {
            ...(base.capabilityPolicy ?? {}),
            ...override.capabilityPolicy,
          },
        }
      : {}),
    ...(override.approvalPolicy !== undefined
      ? {
          approvalPolicy: {
            ...(base.approvalPolicy ?? {}),
            ...override.approvalPolicy,
          },
        }
      : {}),
  };
}

export function extractAllowedCapabilities(
  policy: ExecutionPolicyOverride | undefined,
): string[] {
  const capabilityPolicy = policy?.capabilityPolicy;
  if (capabilityPolicy === undefined) {
    return [];
  }
  return Object.entries(capabilityPolicy)
    .filter(([, allowed]) => allowed === true)
    .map(([capability]) => capability);
}

function clonePack(pack: ApprovalPolicyPack): ApprovalPolicyPack {
  return {
    ...pack,
    allowedToolClasses: [...pack.allowedToolClasses],
    allowedCapabilities: [...pack.allowedCapabilities],
  };
}
