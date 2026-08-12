type EnvironmentOperationPresentationInput = {
  type: string;
  status: string;
  stage: string;
  errorMessage?: string | null | undefined;
};

const OPERATION_LABELS: Record<string, string> = {
  "environment.provision": "Environment provisioning",
  "environment.update": "Environment update",
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
  "environment.dependency.waiting":
    "Waiting for the parent Environment to become ready…",
  "environment.runtime.connecting": "Creating the private Environment runtime…",
  "environment.workspace.mounting": "Attaching persistent Workspace storage…",
  "environment.health.checking": "Checking runtime health…",
  "environment.activation.reconciling":
    "Saving Environment state after the runtime was created…",
  "environment.provider.retrying":
    "The infrastructure provider is retrying this operation…",
  "environment.machine.starting": "Waking the Workspace Machine…",
  "environment.machine.stopping": "Stopping idle Workspace compute…",
  "environment.machine.stopped":
    "Workspace compute is asleep; its filesystem is retained.",
  "environment.activation.ready": "Environment ready.",
  "environment.update.backing_up":
    "Preserving every Workspace before the update…",
  "environment.update.backups_skipped":
    "Workspace backups were skipped for this maintenance update.",
  "environment.update.gateway": "Updating the Environment gateway…",
  "environment.update.workspaces": "Updating Workspace runtimes…",
  "environment.update.verifying": "Verifying the updated Environment…",
  "environment.update.ready": "Environment update completed.",
  "environment.update.recovery_required":
    "Environment updated; one or more Workspaces require provisioning retry.",
  "environment.deleted": "Environment deleted.",
  "workspace.deleted": "Workspace deleted.",
  "workspace.backup.queued": "Waiting to start the Workspace backup…",
  "workspace.backup.waiting_for_execution":
    "Waiting for active Workspace work to finish before backing it up…",
  "workspace.backup.exporting": "Encrypting and exporting the Workspace…",
  "workspace.backup.retrying":
    "The Workspace backup attempt failed and will be retried…",
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
      detail:
        input.errorMessage?.trim() ||
        (input.stage === "environment.activation.reconciling" ||
        input.stage === "environment.dependency.waiting" ||
        input.stage === "workspace.backup.waiting_for_execution"
          ? STAGE_DETAILS[input.stage]
          : undefined) ||
        "Waiting for Kestrel One to start this operation.",
      tone: "neutral" as const,
    };
  }
  const workspaceOperation = WORKSPACE_OPERATION_TYPES.has(input.type);
  const recoveryRequired =
    input.stage === "environment.update.recovery_required";
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
      input.status === "completed" && !recoveryRequired
        ? ("success" as const)
        : ("neutral" as const),
  };
}
