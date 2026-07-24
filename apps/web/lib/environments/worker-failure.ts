const OPERATION_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,119}$/u;
const MAX_OPERATION_ERROR_MESSAGE_LENGTH = 500;

export type EnvironmentWorkerAttempt = {
  attempt: number;
  canRetry: boolean;
  retryCount: number;
  retryLimit: number;
};

export function parseEnvironmentWorkerAttempt(input: {
  retryCount: unknown;
  retryLimit: unknown;
}): EnvironmentWorkerAttempt {
  const retryCount = readNonnegativeInteger(input.retryCount, "retryCount");
  const retryLimit = readNonnegativeInteger(input.retryLimit, "retryLimit");
  return {
    attempt: retryCount + 1,
    canRetry: retryCount < retryLimit,
    retryCount,
    retryLimit,
  };
}

export function describeEnvironmentWorkerFailure(input: {
  error: unknown;
  fallbackCode: string;
  fallbackMessage: string;
}) {
  const record = asRecord(input.error);
  const candidateCode =
    input.error instanceof Error
      ? asRecord(input.error)?.code
      : record?.code;
  const code =
    typeof candidateCode === "string" &&
    OPERATION_ERROR_CODE_PATTERN.test(candidateCode)
      ? candidateCode
      : input.fallbackCode;
  const candidateMessage =
    input.error instanceof Error ? input.error.message : record?.message;
  const message =
    typeof candidateMessage === "string" && candidateMessage.trim()
      ? candidateMessage.trim()
      : input.fallbackMessage;
  return {
    code,
    message: message.slice(0, MAX_OPERATION_ERROR_MESSAGE_LENGTH),
  };
}

function readNonnegativeInteger(value: unknown, field: string) {
  if (!(typeof value === "number" && Number.isInteger(value) && value >= 0)) {
    throw new Error(`Environment worker ${field} must be a nonnegative integer.`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
