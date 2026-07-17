import type { ToolExecutionClass } from "../mode/contracts.js";

export type ContinuationRequiredMode = "plan" | "build";
export type ContinuationRequiredToolClass = Exclude<ToolExecutionClass, "planning_write">;

export interface ContinuationOfferV1 {
  version: "continuation_offer_v1";
  kind: "implementation";
  objective: string;
  requiredToolClass: ContinuationRequiredToolClass;
  requiredCapabilities: string[];
  requiredMode: ContinuationRequiredMode;
  sourceRunId: string;
  resumeMessage?: string | undefined;
}

export function normalizeContinuationOffer(
  value: unknown,
  fallbackSourceRunId: string,
): ContinuationOfferV1 | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }

  const version = readString(record.version);
  const kind = readString(record.kind);
  const objective = readNonEmptyString(record.objective);
  const requiredToolClass = readToolExecutionClass(record.requiredToolClass);
  const requiredMode = readRequiredMode(record.requiredMode);
  const sourceRunId = readNonEmptyString(record.sourceRunId) ?? fallbackSourceRunId;
  const requiredCapabilities = readStringArray(record.requiredCapabilities);
  const resumeMessage = readNonEmptyString(record.resumeMessage);
  if (
    version !== "continuation_offer_v1" ||
    kind !== "implementation" ||
    objective === undefined ||
    requiredToolClass === undefined ||
    requiredMode === undefined
  ) {
    return ;
  }

  return {
    version: "continuation_offer_v1",
    kind: "implementation",
    objective,
    requiredToolClass,
    requiredCapabilities,
    requiredMode,
    sourceRunId,
    ...(resumeMessage !== undefined ? { resumeMessage } : {}),
  };
}

function readToolExecutionClass(value: unknown): ContinuationRequiredToolClass | undefined {
  if (
    value === "read_only" ||
    value === "sandboxed_only" ||
    value === "external_side_effect"
  ) {
    return value;
  }
  return ;
}

function readRequiredMode(value: unknown): ContinuationRequiredMode | undefined {
  if (value === "plan" || value === "build") {
    return value;
  }
  if (
    value === "build.guarded" ||
    value === "build.auto" ||
    value === "act.safe" ||
    value === "act.full_auto"
  ) {
    return "build";
  }
  return ;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((item) => readNonEmptyString(item))
    .filter((item): item is string => item !== undefined);
}

function readNonEmptyString(value: unknown): string | undefined {
  const text = readString(value)?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}
