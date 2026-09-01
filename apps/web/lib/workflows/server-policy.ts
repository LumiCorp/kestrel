import "server-only";

import {
  isKestrelRuntimeModelSelectionAvailableInTransaction,
  type RuntimeModelSelectionTransaction,
  resolveKestrelRuntimeModelIdentityInTransaction,
} from "@/lib/ai/runtime-model-selection";
import { resolveEffectiveProjectAppsAccess } from "@/lib/apps/project-service";
import { knowledgeDb } from "@/lib/knowledge/db";
import type { WorkflowDefinition } from "./contracts";
import { classifyWorkflowCapability } from "./capabilities";
import { assertWorkflowToolsAvailable } from "./execution-policy";
import { isWorkflowModelSupported } from "./model-policy";

export async function getAllowedProjectWorkflowToolNames(input: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  return new Set(
    (await getProjectWorkflowCapabilities(input))
      .filter((capability) => capability.workflowUse === "action")
      .map((capability) => capability.runtimeName),
  );
}

export async function getProjectWorkflowCapabilities(input: {
  organizationId: string; projectId: string; userId: string;
}) {
  const access = await resolveEffectiveProjectAppsAccess(input);
  return access.flatMap((app) => app
    ? app.capabilities
        .filter((capability) => capability.runtimeName)
        .map((capability) => ({
          ...capability,
          workflowUse: classifyWorkflowCapability(capability),
        }))
    : []);
}

export async function validateProjectWorkflowTools(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  definition: WorkflowDefinition;
}) {
  const capabilities = await getProjectWorkflowCapabilities(input);
  const actions = new Map(
    capabilities
      .filter((capability) => capability.workflowUse === "action")
      .map((capability) => [capability.runtimeName, capability] as const),
  );
  const definition = assertWorkflowToolsAvailable(input.definition, new Set(actions.keys()));
  for (const node of definition.nodes) {
    if (node.kind !== "tool") continue;
    const capability = actions.get(node.config.toolName);
    if (!capability) continue;
    for (const pointer of Object.keys(node.config.inputBindings)) {
      let schema: unknown = capability.inputSchema;
      for (const segment of pointer.slice(1).split("/").map((value) => value.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) break;
        const properties = (schema as Record<string, unknown>).properties;
        schema = properties && typeof properties === "object" && !Array.isArray(properties)
          ? (properties as Record<string, unknown>)[segment]
          : undefined;
      }
      if (!schema || typeof schema !== "object" || Array.isArray(schema) || (schema as Record<string, unknown>).type !== "string") {
        throw Object.assign(new Error(`Action "${node.label}" can only bind Kestrel response text to a text field.`), { code: "WORKFLOW_DEFINITION_INVALID" });
      }
    }
  }
  return definition;
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
