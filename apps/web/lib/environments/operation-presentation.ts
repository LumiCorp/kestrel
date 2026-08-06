type EnvironmentOperationPresentationInput = {
  type: string;
  status: string;
  stage: string;
  errorMessage?: string | null | undefined;
};

const OPERATION_LABELS: Record<string, string> = {
  "environment.provision": "Environment provisioning",
  "environment.update": "Environment update",
  "environment.gateway.update": "Environment gateway update",
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
  "platform.gateway.queued": "Waiting to update the Environment gateway…",
  "platform.gateway.draining":
    "Waiting for active work in this Environment to finish…",
  "platform.gateway.applying": "Updating the Environment gateway image…",
  "platform.gateway.verifying": "Verifying Environment gateway health…",
  "platform.gateway.ready": "Environment gateway image verified.",
  "platform.gateway.safety_rollback": "Restoring the prior gateway image…",
  "platform.gateway.safety_rollback_verifying":
    "Verifying the restored gateway image…",
  "platform.workspace.queued": "Waiting to update this Workspace…",
  "platform.workspace.backing_up":
    "Protecting this Workspace before its declared data migration…",
  "platform.workspace.applying": "Updating this Workspace runtime image…",
  "platform.workspace.verifying": "Verifying this Workspace runtime…",
  "platform.workspace.ready": "Workspace runtime image verified.",
  "platform.workspace.safety_rollback":
    "Restoring the prior Workspace image…",
  "platform.workspace.safety_rollback_verifying":
    "Verifying the restored Workspace image…",
  "platform.resource.superseded":
    "A newer platform generation superseded this operation.",
  "platform.resource.manual_retry": "Retrying this resource…",
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
