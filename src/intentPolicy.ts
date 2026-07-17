export type IntentOperationKind =
  | "write_file"
  | "scaffold_app"
  | "run_host_command"
  | "run_sandbox_code"
  | "read_file"
  | "inspect_repo";

export type IntentWorkflowKind =
  | "direct_operation"
  | "coding_change"
  | "validation"
  | "research";

export type IntentVerificationMode = "required" | "optional" | "not_applicable";
export type IntentFinalizeContract = "coding" | "direct_write" | "generic";

export interface IntentPolicyInput {
  operationKind?: string | null | undefined;
  workflowKind?: string | null | undefined;
  verificationRequested?: boolean | null | undefined;
  legacyTaskKind?: string | null | undefined;
  legacyMutationIntent?: string | null | undefined;
}

export interface IntentPolicyApplicability {
  operationKind?: IntentOperationKind | undefined;
  workflowKind?: IntentWorkflowKind | undefined;
  codingWorkflow: boolean;
  validationWorkflow: boolean;
  researchWorkflow: boolean;
  directOperationWorkflow: boolean;
  retrievalOperation: boolean;
  researchStallEligible: boolean;
  verificationMode: IntentVerificationMode;
  finalizeContract: IntentFinalizeContract;
}

export function deriveIntentWorkflowKind(input: {
  workflowKind?: string | null | undefined;
  operationKind?: string | null | undefined;
  legacyTaskKind?: string | null | undefined;
  legacyMutationIntent?: string | null | undefined;
}): IntentWorkflowKind | undefined {
  const workflowKind = normalizeWorkflowKind(input.workflowKind);
  if (workflowKind !== undefined) {
    return workflowKind;
  }

  // Legacy compatibility only. Active policy should emit explicit workflow intent.
  if (input.legacyTaskKind === "validate") {
    return "validation";
  }
  if (
    input.legacyTaskKind === "implement" ||
    input.legacyTaskKind === "debug" ||
    input.legacyMutationIntent === "edit_files" ||
    input.legacyMutationIntent === "run_commands"
  ) {
    return "coding_change";
  }

  const operationKind = normalizeOperationKind(input.operationKind);
  if (operationKind !== undefined) {
    return "direct_operation";
  }
  return ;
}

export function deriveIntentPolicyApplicability(
  input: IntentPolicyInput,
): IntentPolicyApplicability {
  const operationKind = normalizeOperationKind(input.operationKind);
  const workflowKind = deriveIntentWorkflowKind({
    workflowKind: input.workflowKind,
    operationKind,
    legacyTaskKind: input.legacyTaskKind,
    legacyMutationIntent: input.legacyMutationIntent,
  });
  const codingWorkflow = workflowKind === "coding_change" || workflowKind === "validation";
  const validationWorkflow = workflowKind === "validation";
  const researchWorkflow = workflowKind === "research";
  const directOperationWorkflow = workflowKind === "direct_operation";
  const retrievalOperation =
    researchWorkflow ||
    operationKind === "read_file" ||
    operationKind === "inspect_repo";
  const researchStallEligible = researchWorkflow;
  const verificationMode =
    codingWorkflow
      ? input.verificationRequested === true
        ? "required"
        : "optional"
      : "not_applicable";
  const finalizeContract =
    directOperationWorkflow && operationKind === "write_file"
      ? "direct_write"
      : codingWorkflow
        ? "coding"
        : "generic";

  return {
    ...(operationKind !== undefined ? { operationKind } : {}),
    ...(workflowKind !== undefined ? { workflowKind } : {}),
    codingWorkflow,
    validationWorkflow,
    researchWorkflow,
    directOperationWorkflow,
    retrievalOperation,
    researchStallEligible,
    verificationMode,
    finalizeContract,
  };
}

export function normalizeOperationKind(value: string | null | undefined): IntentOperationKind | undefined {
  return value === "write_file" ||
      value === "scaffold_app" ||
      value === "run_host_command" ||
      value === "run_sandbox_code" ||
      value === "read_file" ||
      value === "inspect_repo"
    ? value
    : undefined;
}

export function normalizeWorkflowKind(value: string | null | undefined): IntentWorkflowKind | undefined {
  return value === "direct_operation" ||
      value === "coding_change" ||
      value === "validation" ||
      value === "research"
    ? value
    : undefined;
}
