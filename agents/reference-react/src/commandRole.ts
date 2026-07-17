import { asArray, asRecord, asString } from "../../shared/valueAccess.js";
import type {
  CommandExecutionRole,
  CommandExecutionRoleHint,
} from "./types.js";

export const COMMAND_EXECUTION_ROLES: CommandExecutionRole[] = [
  "source_inspection",
  "source_authoring",
  "helper_execution",
  "helper_repair_check",
  "environment_probe",
  "general_evidence",
];

export interface EffectiveCommandRole {
  role: CommandExecutionRole;
  source: "derived" | "hinted" | "hint_refined";
  target?: string | undefined;
  sourcePath?: string | undefined;
  artifactTarget?: string | undefined;
  evidenceIds?: string[] | undefined;
  rationale?: string | undefined;
}

export interface CommandRoleMismatch {
  reason: "command_role_mismatch";
  derivedRole: CommandExecutionRole;
  hintedRole: CommandExecutionRole;
  allowedRoles: CommandExecutionRole[];
  correction: string;
}

export function parseCommandExecutionRoleHint(value: unknown): CommandExecutionRoleHint | undefined {
  const root = asRecord(value);
  const role = parseCommandExecutionRole(root?.role);
  if (root === undefined || role === undefined) {
    return ;
  }
  const evidenceIds = asArray(root.evidenceIds)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0);
  return {
    role,
    ...(asString(root.target) !== undefined ? { target: asString(root.target) } : {}),
    ...(asString(root.sourcePath) !== undefined ? { sourcePath: asString(root.sourcePath) } : {}),
    ...(asString(root.artifactTarget) !== undefined ? { artifactTarget: asString(root.artifactTarget) } : {}),
    ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
    ...(asString(root.rationale) !== undefined ? { rationale: asString(root.rationale) } : {}),
  };
}

export function parseCommandExecutionRole(value: unknown): CommandExecutionRole | undefined {
  const role = asString(value);
  const staleDerivationRole = ["artifact", "derivation"].join("_");
  const staleVerificationRole = ["artifact", "verification"].join("_");
  if (role === staleDerivationRole || role === staleVerificationRole) {
    return "general_evidence";
  }
  return COMMAND_EXECUTION_ROLES.includes(role as CommandExecutionRole)
    ? role as CommandExecutionRole
    : undefined;
}

export function deriveCommandExecutionRole(input: {
  toolName: string;
  toolInput?: Record<string, unknown> | undefined;
  hint?: CommandExecutionRoleHint | undefined;
}): { effective: EffectiveCommandRole; mismatch?: CommandRoleMismatch | undefined } | undefined {
  if (input.toolName !== "dev.shell.run" && input.toolName !== "exec_command") {
    return ;
  }
  const derivedRole: CommandExecutionRole = "general_evidence";
  const hint = input.hint ?? parseCommandExecutionRoleHint(input.toolInput?.executionRole);
  if (hint !== undefined) {
    return {
      effective: {
        role: hint.role,
        source: "hinted",
        ...(hint.target !== undefined ? { target: hint.target } : {}),
        ...(hint.sourcePath !== undefined ? { sourcePath: hint.sourcePath } : {}),
        ...(hint.artifactTarget !== undefined ? { artifactTarget: hint.artifactTarget } : {}),
        ...(hint.evidenceIds !== undefined ? { evidenceIds: hint.evidenceIds } : {}),
        ...(hint.rationale !== undefined ? { rationale: hint.rationale } : {}),
      },
    };
  }
  return {
    effective: {
      role: derivedRole,
      source: "derived",
    },
  };
}

export function isHelperFailureCommandRole(role: CommandExecutionRole | undefined): boolean {
  return role === "helper_execution" || role === "helper_repair_check";
}
