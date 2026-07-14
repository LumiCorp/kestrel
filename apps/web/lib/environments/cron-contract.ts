import { timingSafeEqual } from "node:crypto";

export class EnvironmentReconcileCronError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "EnvironmentReconcileCronError";
    this.code = code;
    this.status = status;
  }
}

export function authorizeEnvironmentReconcileCron(input: {
  authorization: string | null;
  expectedSecret: string | undefined;
}) {
  const expectedSecret = input.expectedSecret?.trim();
  if (!expectedSecret) {
    throw new EnvironmentReconcileCronError(
      "ENVIRONMENT_RECONCILE_CRON_NOT_CONFIGURED",
      "Environment reconciliation authentication is not configured.",
      503
    );
  }
  const prefix = "Bearer ";
  if (!input.authorization?.startsWith(prefix)) {
    throw new EnvironmentReconcileCronError(
      "ENVIRONMENT_RECONCILE_CRON_UNAUTHORIZED",
      "Environment reconciliation authorization is required.",
      401
    );
  }
  const supplied = Buffer.from(
    input.authorization.slice(prefix.length),
    "utf8"
  );
  const expected = Buffer.from(expectedSecret, "utf8");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new EnvironmentReconcileCronError(
      "ENVIRONMENT_RECONCILE_CRON_UNAUTHORIZED",
      "Environment reconciliation authorization is invalid.",
      401
    );
  }
}
