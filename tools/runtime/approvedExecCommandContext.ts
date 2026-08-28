import type { PreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import type { SharedToolContext } from "../contracts.js";

export function withPreparedExecCommandApprovalContext(
  context: SharedToolContext,
  prepared: PreparedToolCallV1,
): SharedToolContext {
  const binding = prepared.approval?.externalApprovalBinding;
  const command = prepared.effectiveInput.command;
  const cwd = prepared.effectiveInput.cwd;
  const workspaceRoot = context.fileSystem?.workspaceRoot;
  const hostedApprovalAuthorized =
    prepared.stableAuthority !== undefined &&
    prepared.stableToolIdentity !== undefined &&
    binding?.version === "runner_external_approval_binding_v2" &&
    binding.preparedInvocationId === prepared.callId;
  const policyAuthorized = prepared.policy.decision === "allow";
  if (
    prepared.activation.descriptor.toolId !== "exec_command" ||
    (hostedApprovalAuthorized === false && policyAuthorized === false) ||
    context.devShell?.sourceWriteGuard?.managedWorktree === true ||
    typeof command !== "string" ||
    command.length === 0 ||
    typeof cwd !== "string" ||
    cwd.length === 0 ||
    typeof workspaceRoot !== "string" ||
    workspaceRoot.length === 0
  ) {
    return context;
  }

  const approvalGrants = context.devShell?.sourceWriteGuard?.approvalGrants ?? [];
  return {
    ...context,
    devShell: {
      ...(context.devShell ?? { enabled: false }),
      sourceWriteAuthority: "source_write",
      sourceWriteGuard: {
        ...(context.devShell?.sourceWriteGuard ?? {}),
        approvalGrants: [
          ...approvalGrants.filter((grant) => grant.grantId !== prepared.callId),
          {
            grantId: prepared.callId,
            command,
            cwd,
            writablePaths: [workspaceRoot],
            ...(binding?.version === "runner_external_approval_binding_v2"
              ? { expiresAt: binding.expiresAt }
              : {}),
          },
        ],
      },
    },
  };
}
