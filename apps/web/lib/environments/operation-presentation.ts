type EnvironmentOperationPresentationInput = {
  type: string;
  status: string;
  stage: string;
  errorMessage?: string | null | undefined;
};

const OPERATION_LABELS: Record<string, string> = {
  "environment.provision": "Environment provisioning",
  "environment.delete": "Environment deletion",
  "workspace.provision": "Workspace provisioning",
  "workspace.start": "Workspace wake",
  "workspace.stop": "Workspace sleep",
  "workspace.rebuild": "Workspace runtime update",
  "workspace.delete": "Workspace deletion",
  "workspace.backup": "Workspace backup",
  "workspace.restore": "Workspace restore",
  "workspace.reconcile": "Workspace reconciliation",
};

const WORKSPACE_OPERATION_TYPES = new Set([
  "workspace.provision",
  "workspace.start",
  "workspace.stop",
  "workspace.rebuild",
  "workspace.delete",
  "workspace.backup",
  "workspace.restore",
  "workspace.reconcile",
]);

const STAGE_DETAILS: Record<string, string> = {
  requested: "Waiting for Kestrel One to start this operation.",
  "environment.activation.requested": "Preparing the Environment…",
  "environment.runtime.connecting": "Creating the private Environment runtime…",
  "environment.workspace.mounting": "Attaching persistent Workspace storage…",
  "environment.health.checking": "Checking runtime health…",
  "environment.provider.retrying":
    "The infrastructure provider is retrying this operation…",
  "environment.machine.starting": "Waking the Workspace Machine…",
  "environment.machine.stopping": "Stopping idle Workspace compute…",
  "environment.machine.stopped":
    "Workspace compute is asleep; its filesystem is retained.",
  "environment.activation.ready": "Environment ready.",
  "environment.deleted": "Environment deleted.",
  "workspace.deleted": "Workspace deleted.",
  "workspace.backup.exporting": "Encrypting and exporting the Workspace…",
  "workspace.backup.available": "Encrypted Workspace backup available.",
  "workspace.restore.importing": "Importing the encrypted Workspace backup…",
  "workspace.restore.provisioning_replacement":
    "Provisioning replacement Workspace storage…",
  "workspace.restore.rebound": "Workspace restored and rebound.",
  "workspace.restore.rebound_cleanup_pending":
    "Workspace restored; replacement cleanup is pending.",
};

export function describeEnvironmentOperation(
  input: EnvironmentOperationPresentationInput
) {
  const label = OPERATION_LABELS[input.type] ?? "Environment operation";
  if (input.status === "failed") {
    return {
      label,
      detail: input.errorMessage?.trim() || `${label} failed.`,
      tone: "error" as const,
    };
  }
  if (input.status === "cancelled") {
    return {
      label,
      detail: `${label} was cancelled.`,
      tone: "neutral" as const,
    };
  }
  if (input.status === "queued") {
    return {
      label,
      detail: "Waiting for Kestrel One to start this operation.",
      tone: "neutral" as const,
    };
  }
  const workspaceOperation = WORKSPACE_OPERATION_TYPES.has(input.type);
  const stageDetail =
    input.stage === "environment.activation.requested" && workspaceOperation
      ? "Preparing the Workspace…"
      : input.stage === "environment.activation.ready" && workspaceOperation
        ? "Workspace ready."
        : STAGE_DETAILS[input.stage];
  return {
    label,
    detail:
      stageDetail ??
      (input.status === "completed"
        ? `${label} completed.`
        : `${label} is in progress…`),
    tone:
      input.status === "completed"
        ? ("success" as const)
        : ("neutral" as const),
  };
}
