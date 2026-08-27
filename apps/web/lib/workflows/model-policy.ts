export type WorkflowModelIdentity = {
  provider: string;
  rawModelId: string;
};

const UNSUPPORTED_WORKFLOW_MODEL_IDS = new Set([
  "glm-5.2",
  "glm-5.2:free",
  "z-ai/glm-5.2",
  "z-ai/glm-5.2:free",
  "z-ai/glm-5.2-20260616",
]);

export function isWorkflowModelSupported(identity: WorkflowModelIdentity) {
  return !UNSUPPORTED_WORKFLOW_MODEL_IDS.has(
    identity.rawModelId.trim().toLowerCase(),
  );
}
