import "server-only";

import { resolveKestrelOneToolCapability } from "@/lib/agent/kestrel-tool-profile";
import type { RuntimeApprovalPolicyView } from "@/lib/turns/client-contract";
import { listProjectAppConfigurations } from "./project-service";

type ApprovalInteraction = {
  requestId: string;
  turnId?: string | null | undefined;
  source: string;
  kind: string;
  status: string;
  requestEnvelope: Record<string, unknown>;
};

export async function resolveRuntimeApprovalPolicies(input: {
  threadId: string;
  organizationId: string;
  projectId: string;
  userId: string;
  canEditProject: boolean;
  interactions: ApprovalInteraction[];
}) {
  const bindings = input.interactions.flatMap((interaction) => {
    if (
      interaction.source !== "runtime" ||
      interaction.kind !== "approval" ||
      interaction.status !== "pending"
    ) {
      return [];
    }
    const approval = readRecord(interaction.requestEnvelope.approval);
    const toolName = approval?.toolName;
    if (typeof toolName !== "string") return [];
    const binding = resolveKestrelOneToolCapability(toolName);
    const presentation = readRecord(approval?.presentation);
    const policy = readRecord(presentation?.policy);
    const reasonCode = readApprovalReasonCode(policy?.reasonCode);
    return binding === null || reasonCode === undefined
      ? []
      : [{ requestId: interaction.requestId, reasonCode, ...binding }];
  });
  if (bindings.length === 0) {
    return new Map<string, RuntimeApprovalPolicyView>();
  }

  const configurations = await listProjectAppConfigurations({
    organizationId: input.organizationId,
    projectId: input.projectId,
    userId: input.userId,
  });
  const configurationsByApp = new Map(
    configurations.map((configuration) => [
      configuration.app.key,
      configuration,
    ]),
  );
  const policies = new Map<string, RuntimeApprovalPolicyView>();
  for (const binding of bindings) {
    const configuration = configurationsByApp.get(binding.appKey);
    const capability = configuration?.capabilities.find(
      (candidate) => candidate.key === binding.capabilityKey,
    );
    if (!(configuration && capability)) continue;

    policies.set(binding.requestId, {
      projectId: input.projectId,
      environmentId: configuration.environmentId,
      appKey: binding.appKey,
      capabilityKey: binding.capabilityKey,
      capabilityDisplayName: capability.displayName,
      environmentApprovalMode: capability.environmentApprovalMode,
      projectApprovalMode: capability.approvalMode,
      minimumApprovalMode: capability.minimumApprovalMode,
      reasonCode: binding.reasonCode,
      canEditProject: input.canEditProject,
      approvalRequirementExplanation: approvalRequirementExplanation(
        capability,
        binding.reasonCode,
      ),
    });
  }
  return policies;
}

function approvalRequirementExplanation(
  capability: {
    minimumApprovalMode: "auto" | "ask";
    environmentApprovalMode: "auto" | "ask" | "deny";
    approvalMode: "auto" | "ask" | "deny";
  },
  reasonCode: RuntimeApprovalPolicyView["reasonCode"],
) {
  if (reasonCode === "runtime_strict") {
    return "The current runtime mode requires approval for every tool call.";
  }
  if (reasonCode === "subject_restriction") {
    return "A user or agent restriction requires approval for this invocation.";
  }
  if (
    reasonCode === "tool_minimum" ||
    capability.minimumApprovalMode === "ask"
  ) {
    return "This capability requires approval for every invocation.";
  }
  if (capability.environmentApprovalMode === "ask") {
    return "Environment Apps is configured to ask before this capability runs.";
  }
  if (capability.approvalMode === "ask") {
    return "This Project narrows the Environment policy to Ask first.";
  }
  return;
}

function readApprovalReasonCode(
  value: unknown,
): RuntimeApprovalPolicyView["reasonCode"] | undefined {
  return value === "tool_minimum" ||
    value === "environment_policy" ||
    value === "project_restriction" ||
    value === "subject_restriction" ||
    value === "runtime_strict"
    ? value
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
