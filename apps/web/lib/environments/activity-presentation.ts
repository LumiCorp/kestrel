const ACTIVE_OPERATION_STATUSES = new Set(["queued", "running"]);
const ACTIVE_RUN_STATUSES = new Set(["routed", "running"]);

export function getEnvironmentActivityPresentation<
  Operation extends { status: string },
  Run extends { status: string },
>(input: { operations: readonly Operation[]; runs: readonly Run[] }) {
  const visibleOperations: Operation[] = [];
  const completedOperations: Operation[] = [];
  const visibleRuns: Run[] = [];
  const completedRuns: Run[] = [];

  for (const operation of input.operations) {
    if (
      ACTIVE_OPERATION_STATUSES.has(operation.status) ||
      operation.status === "failed"
    ) {
      visibleOperations.push(operation);
    } else {
      completedOperations.push(operation);
    }
  }

  for (const run of input.runs) {
    if (ACTIVE_RUN_STATUSES.has(run.status) || run.status === "failed") {
      visibleRuns.push(run);
    } else {
      completedRuns.push(run);
    }
  }

  const activeCount =
    input.operations.filter((operation) =>
      ACTIVE_OPERATION_STATUSES.has(operation.status),
    ).length +
    input.runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
  const failureCount =
    input.operations.filter((operation) => operation.status === "failed")
      .length +
    input.runs.filter((run) => run.status === "failed").length;

  return {
    visibleOperations,
    completedOperations,
    visibleRuns,
    completedRuns,
    activeCount,
    failureCount,
    status:
      failureCount > 0
        ? ("Needs attention" as const)
        : activeCount > 0
          ? ("Work in progress" as const)
          : ("Quiet" as const),
    tone:
      failureCount > 0
        ? ("warning" as const)
        : activeCount > 0
          ? ("neutral" as const)
          : ("positive" as const),
  };
}
