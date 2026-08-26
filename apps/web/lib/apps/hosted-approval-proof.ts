import "server-only";

import {
  parseRunnerExternalApprovalBinding,
  parseRunnerHostedToolApprovalInteractionV2,
  parseRunnerHostedToolApprovalInteractionV3,
} from "@kestrel-agents/protocol";
import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

type ProofDatabase = typeof knowledgeDb;

export async function readHostedApprovalProof(
  input: {
    interactionId: string;
    threadId: string;
  },
  database: ProofDatabase = knowledgeDb,
) {
  const interaction = await database.query.threadInteractions.findFirst({
    where: and(
      eq(schema.threadInteractions.id, input.interactionId),
      eq(schema.threadInteractions.threadId, input.threadId),
    ),
  });
  if (!interaction) throw new Error("HOSTED_APPROVAL_INTERACTION_NOT_FOUND");
  const requestVersion = readString(interaction.requestEnvelope.version);
  const request =
    requestVersion === "runner_hosted_tool_approval_interaction_v3"
      ? parseRunnerHostedToolApprovalInteractionV3(
          interaction.requestEnvelope,
          interaction.eventType,
        )
      : parseRunnerHostedToolApprovalInteractionV2(
          interaction.requestEnvelope,
          interaction.eventType,
        );
  const [thread, providerApproval, remembered, settledEvent] =
    await Promise.all([
      database.query.threads.findFirst({
        where: eq(schema.threads.id, interaction.threadId),
        columns: { id: true, organizationId: true, projectId: true },
      }),
      database.query.appOperationApprovals.findFirst({
        where: and(
          eq(
            schema.appOperationApprovals.organizationId,
            interaction.organizationId,
          ),
          eq(schema.appOperationApprovals.interactionId, interaction.id),
        ),
      }),
      database.query.rememberedToolApprovals.findFirst({
        where: eq(
          schema.rememberedToolApprovals.sourceInteractionId,
          interaction.id,
        ),
      }),
      interaction.turnId
        ? database.query.threadTurnEvents.findFirst({
            where: and(
              eq(schema.threadTurnEvents.turnId, interaction.turnId),
              eq(schema.threadTurnEvents.type, "interaction.execution_settled"),
            ),
            orderBy: (table, { desc }) => [desc(table.sequence)],
          })
        : Promise.resolve(undefined),
    ]);
  if (!thread) throw new Error("HOSTED_APPROVAL_THREAD_NOT_FOUND");
  let binding;
  try {
    binding = providerApproval?.externalApprovalBinding
      ? parseRunnerExternalApprovalBinding(
          providerApproval.externalApprovalBinding,
        )
      : undefined;
  } catch {
    binding = undefined;
  }
  const [requestedExecution, consumingExecution] = await Promise.all([
    providerApproval
      ? database.query.environmentRunExecutions.findFirst({
          where: eq(
            schema.environmentRunExecutions.id,
            providerApproval.requestedExecutionId,
          ),
          columns: {
            id: true,
            organizationId: true,
            environmentId: true,
            threadId: true,
            projectId: true,
            actorId: true,
            runtimeRunId: true,
            status: true,
          },
        })
      : Promise.resolve(undefined),
    providerApproval?.consumedExecutionId
      ? database.query.environmentRunExecutions.findFirst({
          where: eq(
            schema.environmentRunExecutions.id,
            providerApproval.consumedExecutionId,
          ),
          columns: {
            id: true,
            organizationId: true,
            environmentId: true,
            threadId: true,
            projectId: true,
            actorId: true,
            runtimeRunId: true,
            status: true,
          },
        })
      : Promise.resolve(undefined),
  ]);
  return compareHostedApprovalProof({
    interaction: {
      id: interaction.id,
      requestId: interaction.requestId,
      organizationId: interaction.organizationId,
      threadId: interaction.threadId,
      turnId: interaction.turnId,
      status: interaction.status,
      resolvedByUserId: interaction.resolvedByUserId,
      version: request.version,
      decision:
        readString(interaction.responseEnvelope?.decision) ??
        (interaction.responseEnvelope?.approved === true
          ? "approve_once"
          : interaction.responseEnvelope?.approved === false
            ? "decline"
            : null),
      effectState: interaction.effectStatus,
      failureCode: interaction.responseFailureCode,
      preparedInvocationId: request.approval.preparedInvocationId,
      toolId: request.approval.stableToolIdentity.toolId,
      descriptorRevision:
        request.approval.stableToolIdentity.descriptorContractRevision,
      authorityRevision:
        request.approval.stableToolIdentity.approvalAuthorityRevision,
      requestingActorId: request.approval.requestingActor.actorId,
      requestingTenantId: request.approval.requestingActor.tenantId,
      policy: readPolicy(request.approval.presentation),
    },
    thread,
    providerApproval: providerApproval
      ? {
          id: providerApproval.id,
          lifecycleVersion: providerApproval.lifecycleVersion,
          interactionId: providerApproval.interactionId,
          runtimeApprovalId: providerApproval.runtimeApprovalId,
          organizationId: providerApproval.organizationId,
          environmentId: providerApproval.environmentId,
          threadId: providerApproval.threadId,
          actorUserId: providerApproval.actorUserId,
          operationKey: providerApproval.operationKey,
          payloadHash: providerApproval.payloadHash,
          authorityRevision: providerApproval.authorityRevision,
          availabilityStatus: providerApproval.availabilityStatus,
          requestedExecutionId: providerApproval.requestedExecutionId,
          consumedExecutionId: providerApproval.consumedExecutionId,
        }
      : null,
    binding: binding
      ? {
          version: binding.version,
          approvalId: binding.approvalId,
          preparedInvocationId:
            "preparedInvocationId" in binding
              ? binding.preparedInvocationId
              : null,
          threadId: binding.threadId,
          actionKey: binding.actionKey,
          payloadHash: binding.payloadHash,
          actorId:
            "requestingActor" in binding
              ? binding.requestingActor.actorId
              : null,
          tenantId:
            "requestingActor" in binding
              ? binding.requestingActor.tenantId
              : undefined,
          authorityRevision: binding.authorityRevision,
          toolId:
            "stableToolIdentity" in binding
              ? binding.stableToolIdentity.toolId
              : null,
          descriptorRevision:
            "stableToolIdentity" in binding
              ? binding.stableToolIdentity.descriptorContractRevision
              : null,
          stableAuthorityRevision:
            "stableToolIdentity" in binding
              ? binding.stableToolIdentity.approvalAuthorityRevision
              : null,
        }
      : null,
    requestedExecution: requestedExecution ?? null,
    consumingExecution: consumingExecution ?? null,
    remembered: remembered
      ? {
          id: remembered.id,
          actorUserId: remembered.actorUserId,
          threadId: remembered.threadId,
          toolId: remembered.toolId,
          descriptorRevision: remembered.descriptorContractRevision,
          authorityRevision: remembered.approvalAuthorityRevision,
        }
      : null,
    settled: settledEvent
      ? (() => {
          const data = asRecord(settledEvent.data);
          return {
            preparedInvocationId: readString(data?.preparedInvocationId),
            outcomeKind: readString(data?.outcomeKind),
            effectState: readString(data?.effectState),
          };
        })()
      : null,
  });
}

export function compareHostedApprovalProof(input: {
  interaction: {
    id: string;
    requestId: string;
    organizationId: string;
    threadId: string;
    turnId: string | null;
    status: string;
    resolvedByUserId: string | null;
    version: string;
    decision: string | null;
    effectState: string | null;
    failureCode: string | null;
    preparedInvocationId: string;
    toolId: string;
    descriptorRevision: string;
    authorityRevision: string;
    requestingActorId: string;
    requestingTenantId?: string | undefined;
    policy: {
      mode: string | null;
      reasonCode: string | null;
      authorityRevision: string | null;
    };
  };
  thread: { id: string; organizationId: string; projectId: string | null };
  providerApproval: {
    id: string;
    lifecycleVersion: string;
    interactionId: string | null;
    runtimeApprovalId: string;
    organizationId: string;
    environmentId: string;
    threadId: string;
    actorUserId: string;
    operationKey: string;
    payloadHash: string;
    authorityRevision: string | null;
    availabilityStatus: string | null;
    requestedExecutionId: string;
    consumedExecutionId: string | null;
  } | null;
  binding: {
    version: string;
    approvalId: string;
    preparedInvocationId: string | null;
    threadId: string;
    actionKey: string;
    payloadHash: string;
    actorId: string | null;
    tenantId?: string | undefined;
    authorityRevision: string;
    toolId: string | null;
    descriptorRevision: string | null;
    stableAuthorityRevision: string | null;
  } | null;
  requestedExecution: {
    id: string;
    organizationId: string;
    environmentId: string;
    threadId: string;
    projectId: string | null;
    actorId: string;
    runtimeRunId: string | null;
    status: string;
  } | null;
  consumingExecution: {
    id: string;
    organizationId: string;
    environmentId: string;
    threadId: string;
    projectId: string | null;
    actorId: string;
    runtimeRunId: string | null;
    status: string;
  } | null;
  remembered: {
    id: string;
    actorUserId: string;
    threadId: string;
    toolId: string;
    descriptorRevision: string;
    authorityRevision: string;
  } | null;
  settled: {
    preparedInvocationId: string | undefined;
    outcomeKind: string | undefined;
    effectState: string | undefined;
  } | null;
}) {
  const mismatches: string[] = [];
  const { interaction, thread, providerApproval, binding } = input;
  check(mismatches, "policy.mode", interaction.policy.mode, "ask");
  check(
    mismatches,
    "policy.authority_revision",
    interaction.policy.authorityRevision,
    interaction.authorityRevision,
  );
  check(
    mismatches,
    "thread.organization",
    thread.organizationId,
    interaction.organizationId,
  );
  check(mismatches, "thread.id", thread.id, interaction.threadId);
  if (!providerApproval) {
    mismatches.push("provider_approval.missing");
  } else {
    check(
      mismatches,
      "provider.interaction",
      providerApproval.interactionId,
      interaction.id,
    );
    check(
      mismatches,
      "provider.organization",
      providerApproval.organizationId,
      interaction.organizationId,
    );
    check(
      mismatches,
      "provider.thread",
      providerApproval.threadId,
      interaction.threadId,
    );
    check(
      mismatches,
      "provider.actor",
      providerApproval.actorUserId,
      interaction.requestingActorId,
    );
    check(
      mismatches,
      "provider.authority",
      providerApproval.authorityRevision,
      interaction.authorityRevision,
    );
  }
  if (!binding) {
    mismatches.push("external_binding.missing_or_invalid");
  } else {
    check(
      mismatches,
      "binding.approval",
      binding.approvalId,
      providerApproval?.runtimeApprovalId ?? null,
    );
    check(
      mismatches,
      "binding.prepared_invocation",
      binding.preparedInvocationId,
      interaction.preparedInvocationId,
    );
    check(mismatches, "binding.thread", binding.threadId, interaction.threadId);
    check(mismatches, "binding.action", binding.actionKey, interaction.toolId);
    check(
      mismatches,
      "binding.payload_hash",
      binding.payloadHash,
      providerApproval
        ? normalizePayloadHash(providerApproval.payloadHash)
        : null,
    );
    check(
      mismatches,
      "binding.actor",
      binding.actorId,
      interaction.requestingActorId,
    );
    check(
      mismatches,
      "binding.tenant",
      binding.tenantId ?? null,
      interaction.requestingTenantId ?? null,
    );
    check(
      mismatches,
      "binding.authority",
      binding.authorityRevision,
      interaction.authorityRevision,
    );
    check(mismatches, "binding.tool", binding.toolId, interaction.toolId);
    check(
      mismatches,
      "binding.descriptor_revision",
      binding.descriptorRevision,
      interaction.descriptorRevision,
    );
    check(
      mismatches,
      "binding.stable_authority_revision",
      binding.stableAuthorityRevision,
      interaction.authorityRevision,
    );
  }
  if (input.requestedExecution) {
    check(
      mismatches,
      "requested_execution.organization",
      input.requestedExecution.organizationId,
      interaction.organizationId,
    );
    check(
      mismatches,
      "requested_execution.thread",
      input.requestedExecution.threadId,
      interaction.threadId,
    );
    check(
      mismatches,
      "requested_execution.project",
      input.requestedExecution.projectId,
      thread.projectId,
    );
    check(
      mismatches,
      "requested_execution.actor",
      input.requestedExecution.actorId,
      interaction.requestingActorId,
    );
  } else if (providerApproval) {
    mismatches.push("requested_execution.missing");
  }
  if (providerApproval?.consumedExecutionId) {
    if (!input.consumingExecution) {
      mismatches.push("consuming_execution.missing");
    } else {
      check(
        mismatches,
        "consuming_execution.id",
        input.consumingExecution.id,
        providerApproval.consumedExecutionId,
      );
      check(
        mismatches,
        "consuming_execution.organization",
        input.consumingExecution.organizationId,
        interaction.organizationId,
      );
      check(
        mismatches,
        "consuming_execution.environment",
        input.consumingExecution.environmentId,
        providerApproval.environmentId,
      );
      check(
        mismatches,
        "consuming_execution.thread",
        input.consumingExecution.threadId,
        interaction.threadId,
      );
      check(
        mismatches,
        "consuming_execution.project",
        input.consumingExecution.projectId,
        thread.projectId,
      );
      check(
        mismatches,
        "consuming_execution.actor",
        input.consumingExecution.actorId,
        interaction.requestingActorId,
      );
    }
  }
  if (input.remembered) {
    check(
      mismatches,
      "remembered.actor",
      input.remembered.actorUserId,
      interaction.requestingActorId,
    );
    check(
      mismatches,
      "remembered.thread",
      input.remembered.threadId,
      interaction.threadId,
    );
    check(
      mismatches,
      "remembered.tool",
      input.remembered.toolId,
      interaction.toolId,
    );
    check(
      mismatches,
      "remembered.descriptor_revision",
      input.remembered.descriptorRevision,
      interaction.descriptorRevision,
    );
    check(
      mismatches,
      "remembered.authority_revision",
      input.remembered.authorityRevision,
      interaction.authorityRevision,
    );
  }
  if (input.settled) {
    check(
      mismatches,
      "settled.prepared_invocation",
      input.settled.preparedInvocationId ?? null,
      interaction.preparedInvocationId,
    );
    check(
      mismatches,
      "settled.effect",
      input.settled.effectState ?? null,
      interaction.effectState,
    );
  }
  return {
    ok: mismatches.length === 0,
    mismatches,
    protocolVersion: interaction.version,
    decision: interaction.decision,
    identity: {
      requestId: interaction.requestId,
      interactionId: interaction.id,
      preparedInvocationId: interaction.preparedInvocationId,
      toolId: interaction.toolId,
      descriptorRevision: interaction.descriptorRevision,
      authorityRevision: interaction.authorityRevision,
      organizationId: interaction.organizationId,
      projectId: thread.projectId,
      environmentId: providerApproval?.environmentId ?? null,
      threadId: interaction.threadId,
      actorUserId: interaction.requestingActorId,
      payloadHash: providerApproval
        ? normalizePayloadHash(providerApproval.payloadHash)
        : null,
    },
    policy: interaction.policy,
    rememberedEvidence:
      input.remembered === null ? "not_recorded" : "recorded_exact",
    credentialRefresh:
      providerApproval?.consumedExecutionId === null
        ? "not_consumed"
        : providerApproval?.requestedExecutionId ===
            providerApproval?.consumedExecutionId
          ? "same_execution"
          : "rotated_execution",
    providerConsumption: providerApproval
      ? {
          lifecycleVersion: providerApproval.lifecycleVersion,
          availabilityStatus: providerApproval.availabilityStatus,
          requestedExecutionId: providerApproval.requestedExecutionId,
          consumedExecutionId: providerApproval.consumedExecutionId,
        }
      : null,
    executionOutcome: {
      interactionStatus: interaction.status,
      outcomeKind: input.settled?.outcomeKind ?? null,
      effectState: interaction.effectState,
      failureCode: interaction.failureCode,
    },
    compatibilityPath:
      interaction.version === "runner_hosted_tool_approval_interaction_v3" &&
      providerApproval?.lifecycleVersion === "interaction_v2"
        ? null
        : `${interaction.version}:${providerApproval?.lifecycleVersion ?? "missing"}`,
  };
}

function readPolicy(value: unknown) {
  const presentation = asRecord(value);
  const policy = asRecord(presentation?.policy);
  return {
    mode: readString(policy?.mode) ?? null,
    reasonCode: readString(policy?.reasonCode) ?? null,
    authorityRevision: readString(policy?.authorityRevision) ?? null,
  };
}

function check(
  mismatches: string[],
  label: string,
  actual: unknown,
  expected: unknown,
) {
  if (actual !== expected) mismatches.push(label);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizePayloadHash(value: string) {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}
