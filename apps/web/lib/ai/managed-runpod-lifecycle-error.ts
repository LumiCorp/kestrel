export class ManagedRunPodActiveModelGrantsError extends Error {
  readonly code = "MANAGED_RUNPOD_ACTIVE_MODEL_GRANTS";
  readonly retryable = false;

  constructor() {
    super(
      "The managed RunPod deployment has an active model execution. Finish or stop it before retrying deletion.",
    );
    this.name = "ManagedRunPodActiveModelGrantsError";
  }
}
