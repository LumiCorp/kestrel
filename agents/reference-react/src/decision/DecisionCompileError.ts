export type DecisionIngestCategory =
  | "schema"
  | "parse"
  | "canonicalize"
  | "policy"
  | "capability"
  | "evidence"
  | "provider_schema";

export type DecisionErrorCode =
  | "DECISION_SCHEMA_FAILED"
  | "DECISION_PARSE_FAILED"
  | "DECISION_POLICY_FAILED"
  | "DECISION_CAPABILITY_UNAVAILABLE"
  | "DECISION_CAPABILITY_EVIDENCE_REQUIRED";

export class DecisionCompileError extends Error {
  code: DecisionErrorCode;
  category: DecisionIngestCategory;
  diagnostics?: Record<string, unknown> | undefined;

  constructor(
    code: DecisionErrorCode,
    message: string,
    category: DecisionIngestCategory,
    diagnostics?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.code = code;
    this.category = category;
    this.diagnostics = diagnostics;
  }
}
