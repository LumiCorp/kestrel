import "server-only";

import {
  isKestrelRuntimeModelSelectionAvailableInTransaction,
  type RuntimeModelSelectionTransaction,
  resolveKestrelRuntimeModelIdentityInTransaction,
} from "@/lib/ai/runtime-model-selection";
import { resolveEffectiveProjectAppsAccess } from "@/lib/apps/project-service";
import { knowledgeDb } from "@/lib/knowledge/db";
import type { WorkflowDefinition } from "./contracts";
import { assertWorkflowToolsAvailable } from "./execution-policy";
import { isWorkflowModelSupported } from "./model-policy";

export async function getAllowedProjectWorkflowToolNames(input: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  const access = await resolveEffectiveProjectAppsAccess(input);
  return new Set(
    access.flatMap((app) =>
      app ? app.capabilities.map((capability) => capability.runtimeName) : [],
    ),
  );
}

export async function validateProjectWorkflowTools(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  definition: WorkflowDefinition;
}) {
  return assertWorkflowToolsAvailable(
    input.definition,
    await getAllowedProjectWorkflowToolNames(input),
  );
}

export async function assertWorkflowModelSupportedInTransaction(
  transaction: RuntimeModelSelectionTransaction,
  input: { organizationId: string; environmentId: string; modelId: string },
) {
  const identity = await resolveKestrelRuntimeModelIdentityInTransaction(
    transaction,
    input,
  );
  if (!identity) {
    throw Object.assign(
      new Error("The selected model is not available in this Project Environment."),
      { code: "WORKFLOW_MODEL_UNAVAILABLE" },
    );
  }
  if (!isWorkflowModelSupported(identity)) {
    throw Object.assign(
      new Error("GLM-5.2 is not supported for Kestrel workflows. Choose another model."),
      { code: "WORKFLOW_MODEL_UNSUPPORTED" },
    );
  }
  const available =
    await isKestrelRuntimeModelSelectionAvailableInTransaction(transaction, {
      ...input,
      requiredRole: "agent.loop",
    });
  if (!available) {
    throw Object.assign(
      new Error("The selected model is not available in this Project Environment."),
      { code: "WORKFLOW_MODEL_UNAVAILABLE" },
    );
  }
  return identity;
}

export async function assertWorkflowModelSupported(input: {
  organizationId: string;
  environmentId: string;
  modelId: string;
}) {
  return knowledgeDb.transaction((transaction) =>
    assertWorkflowModelSupportedInTransaction(transaction, input),
  );
}
