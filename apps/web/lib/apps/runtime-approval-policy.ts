import "server-only";

import { resolveKestrelOneToolCapability } from "@/lib/agent/kestrel-tool-profile";
import { projectRoleAllows } from "@/lib/projects/access";
import { getThreadAccessForUser } from "@/lib/threads/store";
import { listThreadInteractionsForUser } from "@/lib/turns/store";
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

export type RuntimeApprovalReturnContext = {
  capability: string;
  threadId: string;
  turnId: string;
  requestId: string;
  projectId: string;
  app: string;
  reasonCode: RuntimeApprovalPolicyView["reasonCode"];
  projectApprovalMode: "auto" | "ask" | "deny";
  canEditProject: boolean;
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

    const alwaysApprovalAction = resolveAlwaysApprovalAction({
      environmentEnabled: capability.environmentEnabled,
      environmentApprovalMode: capability.environmentApprovalMode,
      projectEnabled: configuration.enabled,
      minimumApprovalMode: capability.minimumApprovalMode,
      reasonCode: binding.reasonCode,
    });
    const interaction = input.interactions.find(
      (candidate) => candidate.requestId === binding.requestId,
    );
    const turnId = interaction?.turnId ?? undefined;
    const query = new URLSearchParams({
      capability: binding.capabilityKey,
      threadId: input.threadId,
      requestId: binding.requestId,
      projectId: input.projectId,
      app: binding.appKey,
      ...(turnId === undefined ? {} : { turnId }),
    });
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
      alwaysApprovalAction,
      environmentAppsHref: `/organization/environments/${encodeURIComponent(configuration.environmentId)}/apps/${encodeURIComponent(binding.appKey)}?${query.toString()}#capability-${encodeURIComponent(binding.capabilityKey)}`,
    });
  }
  return policies;
}

export async function validateRuntimeApprovalReturnContext(input: {
  organizationId: string;
  environmentId: string;
  userId: string;
  capability: string;
  threadId: string;
  turnId: string;
  requestId: string;
  projectId: string;
  app: string;
}): Promise<RuntimeApprovalReturnContext | undefined> {
  const access = await getThreadAccessForUser(
    input.threadId,
    input.userId,
    input.organizationId,
  );
  if (access?.thread.projectId !== input.projectId) return;

  const interactions = await listThreadInteractionsForUser({
    threadId: input.threadId,
    organizationId: input.organizationId,
    userId: input.userId,
  });
  const interaction = interactions.find(
    (candidate) =>
      candidate.requestId === input.requestId &&
      candidate.turnId === input.turnId &&
      candidate.source === "runtime" &&
      candidate.kind === "approval" &&
      candidate.status === "pending",
  );
  const approval = readRecord(interaction?.requestEnvelope.approval);
  const toolName = approval?.toolName;
  const binding =
    typeof toolName === "string"
      ? resolveKestrelOneToolCapability(toolName)
      : null;
  if (
    binding?.appKey !== input.app ||
    binding.capabilityKey !== input.capability
  ) {
    return;
  }
  const presentation = readRecord(approval?.presentation);
  const presentationPolicy = readRecord(presentation?.policy);
  const reasonCode = readApprovalReasonCode(presentationPolicy?.reasonCode);
  if (reasonCode === undefined) return;

  const configurations = await listProjectAppConfigurations({
    organizationId: input.organizationId,
    projectId: input.projectId,
    userId: input.userId,
  });
  const configuration = configurations.find(
    (candidate) =>
      candidate.environmentId === input.environmentId &&
      candidate.app.key === input.app,
  );
  const capability = configuration?.capabilities.find(
    (candidate) => candidate.key === input.capability,
  );
  if (!(configuration && capability)) return;

  return {
    capability: input.capability,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    projectId: input.projectId,
    app: input.app,
    reasonCode,
    projectApprovalMode: capability.approvalMode,
    canEditProject:
      access.projectRole !== null &&
      projectRoleAllows(access.projectRole, "editor"),
  };
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

export function resolveAlwaysApprovalAction(input: {
  environmentEnabled: boolean;
  environmentApprovalMode: "auto" | "ask" | "deny";
  projectEnabled: boolean;
  minimumApprovalMode: "auto" | "ask";
  reasonCode: RuntimeApprovalPolicyView["reasonCode"];
}): RuntimeApprovalPolicyView["alwaysApprovalAction"] {
  if (
    input.reasonCode === "tool_minimum" ||
    input.minimumApprovalMode === "ask"
  ) {
    return "minimum_ask";
  }
  if (
    input.reasonCode === "runtime_strict" ||
    input.reasonCode === "subject_restriction"
  ) {
    return "unavailable";
  }
  return "open_environment_apps";
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
