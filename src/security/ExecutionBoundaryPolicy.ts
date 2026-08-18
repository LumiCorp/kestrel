import { createHash } from "node:crypto";

import {
  BOUNDARY_CONTENT_PROVENANCE_VERSION,
  EXECUTION_BOUNDARIES,
  EXECUTION_BOUNDARY_DECISION_VERSION,
  createExecutionBoundaryPolicyV1,
  digestCanonicalValue,
  parseExecutionBoundaryDecisionV1,
  parseExecutionBoundaryPolicyV1,
  type BoundaryContentProvenanceV1,
  type ExecutionBoundaryDecisionV1,
  type ExecutionBoundaryPolicyV1,
  type ExecutionBoundaryV1,
  type SensitiveValueReferenceV1,
} from "../kestrel/contracts/execution-boundary-policy.js";

const KESTREL_EXECUTION_BOUNDARY_POLICY_V1 = createExecutionBoundaryPolicyV1({
  policyId: "execution-boundary:kestrel",
  owner: "kestrel.runtime-security",
  changeId: "execution-boundary-integrity-v1",
  enforcement: "enforce",
  boundaries: [...EXECUTION_BOUNDARIES],
});

export const KESTREL_EXECUTION_BOUNDARY_POLICY = createExecutionBoundaryPolicyV1({
  policyId: "execution-boundary:kestrel",
  owner: "kestrel.runtime-security",
  changeId: "execution-boundary-integrity-v2",
  supersedesRevision: KESTREL_EXECUTION_BOUNDARY_POLICY_V1.revision,
  enforcement: "enforce",
  boundaries: [...EXECUTION_BOUNDARIES],
});

export type ExecutionBoundaryHandlingV1 = "redact" | "quarantine";
/**
 * durable_decision crossings retain a typed decision before downstream use.
 * live_enforced crossings redact presentation streams in memory and are
 * intentionally not retained as per-chunk execution-boundary evidence.
 */
export type ExecutionBoundaryEvidenceModeV1 = "durable_decision" | "live_enforced";

export interface ExecutionBoundaryAdapterV1 {
  boundary: ExecutionBoundaryV1;
  handling: ExecutionBoundaryHandlingV1;
  evidenceMode: ExecutionBoundaryEvidenceModeV1;
}

export const EXECUTION_BOUNDARY_ADAPTERS = Object.freeze([
  { boundary: "user_input", handling: "redact", evidenceMode: "durable_decision" },
  { boundary: "model_request", handling: "redact", evidenceMode: "durable_decision" },
  { boundary: "model_stream", handling: "redact", evidenceMode: "live_enforced" },
  { boundary: "model_action", handling: "redact", evidenceMode: "durable_decision" },
  { boundary: "assembly_change", handling: "quarantine", evidenceMode: "durable_decision" },
  { boundary: "tool_request", handling: "quarantine", evidenceMode: "durable_decision" },
  { boundary: "tool_stream", handling: "redact", evidenceMode: "live_enforced" },
  { boundary: "tool_result", handling: "redact", evidenceMode: "durable_decision" },
  { boundary: "assistant_output", handling: "redact", evidenceMode: "durable_decision" },
] as const satisfies readonly ExecutionBoundaryAdapterV1[]);

assertCanonicalBoundaryAdapters(EXECUTION_BOUNDARY_ADAPTERS);

const MAX_SENSITIVE_VALUE_BYTES = 8 * 1024;
const REDACTION_PLACEHOLDER = "[REDACTED]";

interface RegisteredSensitiveValue {
  reference: SensitiveValueReferenceV1;
  valueDigest: string;
  representations: string[];
}

export interface ExecutionBoundaryIdentity {
  runId: string;
  sessionId: string;
  callId?: string | undefined;
  stepIndex?: number | undefined;
}

export interface RegisterSensitiveValueInput {
  reference: SensitiveValueReferenceV1;
  value: string;
}

export interface ExecutionBoundaryEvaluation<T = unknown> {
  decision: ExecutionBoundaryDecisionV1;
  value: T;
}

export interface ExecutionBoundaryEvaluateInput<T> {
  boundary: ExecutionBoundaryV1;
  identity: ExecutionBoundaryIdentity;
  source: BoundaryContentProvenanceV1["source"];
  trust?: BoundaryContentProvenanceV1["trust"] | undefined;
  sourceId: string;
  value: T;
}

export type ExecutionBoundaryDecisionSink = (
  decision: ExecutionBoundaryDecisionV1,
) => void | Promise<void>;

export interface LiveExecutionBoundaryStream {
  push(chunk: string): string;
  close(): string;
  discard(): void;
}

export class SensitiveValueRegistry {
  private readonly entries = new Map<string, RegisteredSensitiveValue>();

  register(input: RegisterSensitiveValueInput): () => void {
    const valueBytes = Buffer.byteLength(input.value, "utf8");
    if (input.value.length === 0) {
      throw new Error("Sensitive values must not be empty.");
    }
    if (valueBytes > MAX_SENSITIVE_VALUE_BYTES) {
      throw new Error(
        `Sensitive values must not exceed ${MAX_SENSITIVE_VALUE_BYTES} UTF-8 bytes.`,
      );
    }
    if (this.entries.has(input.reference.referenceId)) {
      throw new Error(
        `Sensitive-value reference '${input.reference.referenceId}' is already registered.`,
      );
    }
    const entry: RegisteredSensitiveValue = {
      reference: structuredClone(input.reference),
      valueDigest: digestCanonicalValue(input.value),
      representations: deriveSensitiveRepresentations(input.value),
    };
    this.entries.set(input.reference.referenceId, entry);
    return () => {
      if (this.entries.get(input.reference.referenceId) === entry) {
        this.entries.delete(input.reference.referenceId);
      }
    };
  }

  redact<T>(value: T): {
    value: T;
    references: SensitiveValueReferenceV1[];
    changed: boolean;
  } {
    const references = new Map<string, SensitiveValueReferenceV1>();
    const seen = new WeakMap<object, unknown>();
    const redacted = redactValue(value, this.sortedEntries(), references, seen) as T;
    return {
      value: redacted,
      references: [...references.values()].sort((left, right) =>
        left.referenceId.localeCompare(right.referenceId)),
      changed: references.size > 0,
    };
  }

  redactString(value: string): {
    value: string;
    references: SensitiveValueReferenceV1[];
    changed: boolean;
  } {
    const references = new Map<string, SensitiveValueReferenceV1>();
    const redacted = redactStringValue(value, this.sortedEntries(), references);
    return {
      value: redacted,
      references: [...references.values()].sort((left, right) =>
        left.referenceId.localeCompare(right.referenceId)),
      changed: references.size > 0,
    };
  }

  maximumRepresentationLength(): number {
    return this.sortedEntries().reduce(
      (maximum, entry) => Math.max(
        maximum,
        ...entry.representations.map((representation) => representation.length),
      ),
      0,
    );
  }

  representations(): string[] {
    return this.sortedEntries().flatMap((entry) => entry.representations);
  }

  registeredValueDigests(): Array<{ referenceId: string; valueDigest: string }> {
    return this.sortedEntries().map((entry) => ({
      referenceId: entry.reference.referenceId,
      valueDigest: entry.valueDigest,
    }));
  }

  private sortedEntries(): RegisteredSensitiveValue[] {
    return [...this.entries.values()].sort((left, right) =>
      left.reference.referenceId.localeCompare(right.reference.referenceId));
  }
}

export class DeterministicStreamingRedactor {
  private buffer = "";

  constructor(private readonly registry: SensitiveValueRegistry) {}

  push(chunk: string): string {
    this.buffer += chunk;
    const maximumLength = this.registry.maximumRepresentationLength();
    if (maximumLength === 0) {
      const output = this.buffer;
      this.buffer = "";
      return output;
    }
    let emitLength = Math.max(0, this.buffer.length - maximumLength + 1);
    if (emitLength === 0) return "";
    for (const entry of getRegistryRepresentations(this.registry)) {
      const index = this.buffer.indexOf(entry, Math.max(0, emitLength - maximumLength));
      if (index >= 0 && index < emitLength && index + entry.length > emitLength) {
        emitLength = index;
      }
    }
    const prefix = this.buffer.slice(0, emitLength);
    this.buffer = this.buffer.slice(emitLength);
    return this.registry.redactString(prefix).value;
  }

  flush(): string {
    const output = this.registry.redactString(this.buffer).value;
    this.buffer = "";
    return output;
  }
}

export class ExecutionBoundaryPolicyRuntime {
  readonly policy: ExecutionBoundaryPolicyV1;
  readonly sensitiveValues: SensitiveValueRegistry;

  constructor(options: {
    policy?: ExecutionBoundaryPolicyV1 | undefined;
    sensitiveValues?: SensitiveValueRegistry | undefined;
  } = {}) {
    this.policy = parseExecutionBoundaryPolicyV1(
      options.policy ?? KESTREL_EXECUTION_BOUNDARY_POLICY,
    );
    this.sensitiveValues = options.sensitiveValues ?? new SensitiveValueRegistry();
  }

  evaluate<T>(input: ExecutionBoundaryEvaluateInput<T>): ExecutionBoundaryEvaluation<T> {
    this.assertDeclaredBoundary(input.boundary);
    const inputDigest = digestCanonicalValue(input.value);
    const redaction = this.sensitiveValues.redact(input.value);
    const matched = redaction.references.length > 0;
    const handling = executionBoundaryHandling(input.boundary);
    const outcome = matched
      ? handling === "quarantine"
        ? "QUARANTINE" as const
        : "REDACT" as const
      : "ALLOW" as const;
    const value = outcome === "REDACT" ? redaction.value : input.value;
    const outputDigest = digestCanonicalValue(value);
    const provenance: BoundaryContentProvenanceV1 = {
      version: BOUNDARY_CONTENT_PROVENANCE_VERSION,
      source: input.source,
      trust: input.trust ?? (input.source === "runtime" ? "control" : "data"),
      sourceId: input.sourceId,
      contentDigest: inputDigest,
    };
    if (provenance.trust === "control" && provenance.source !== "runtime") {
      throw new Error("Only runtime-owned content may be assigned control trust.");
    }
    const decisionSeed = {
      identity: input.identity,
      policyRevision: this.policy.revision,
      boundary: input.boundary,
      provenance,
      inputDigest,
      outputDigest,
      outcome,
      references: redaction.references,
    };
    const decision = parseExecutionBoundaryDecisionV1({
      version: EXECUTION_BOUNDARY_DECISION_VERSION,
      decisionId: `boundary-decision:${shortDigest(decisionSeed)}`,
      ...input.identity,
      policyId: this.policy.policyId,
      policyRevision: this.policy.revision,
      boundary: input.boundary,
      provenance,
      inputDigest,
      outputDigest,
      outcome,
      reasonCode: matched
        ? outcome === "QUARANTINE"
          ? "REGISTERED_SENSITIVE_VALUE_QUARANTINED"
          : outcome === "REDACT"
            ? "REGISTERED_SENSITIVE_VALUE_REDACTED"
            : "REGISTERED_SENSITIVE_VALUE_OBSERVED"
        : "NO_REGISTERED_SENSITIVE_VALUE",
      sensitiveReferences: redaction.references,
      ...(outcome === "REDACT"
        ? { transformId: "redact.registered_values.v1" }
        : {}),
      createdAt: new Date().toISOString(),
    });
    return { decision, value };
  }

  async evaluateAndPersist<T>(input: ExecutionBoundaryEvaluateInput<T> & {
    persist: ExecutionBoundaryDecisionSink;
  }): Promise<ExecutionBoundaryEvaluation<T>> {
    if (executionBoundaryEvidenceMode(input.boundary) === "live_enforced") {
      throw new Error(
        `Execution boundary '${input.boundary}' uses live enforcement and cannot persist durable decisions.`,
      );
    }
    if (typeof input.persist !== "function") {
      throw new Error("Execution-boundary decision persistence is required.");
    }
    const evaluated = this.evaluate<T>(input);
    await input.persist(evaluated.decision);
    return evaluated;
  }

  openLiveStream(
    input: Omit<ExecutionBoundaryEvaluateInput<string>, "value">,
  ): LiveExecutionBoundaryStream {
    this.assertDeclaredBoundary(input.boundary);
    if (executionBoundaryEvidenceMode(input.boundary) !== "live_enforced") {
      throw new Error(
        `Execution boundary '${input.boundary}' requires a durable decision and cannot open a live stream.`,
      );
    }
    const trust = input.trust ?? (input.source === "runtime" ? "control" : "data");
    if (trust === "control" && input.source !== "runtime") {
      throw new Error("Only runtime-owned content may be assigned control trust.");
    }
    if (input.sourceId.length === 0) {
      throw new Error("Execution-boundary live stream sourceId must not be empty.");
    }

    const redactor = new DeterministicStreamingRedactor(this.sensitiveValues);
    let closed = false;
    const assertOpen = (): void => {
      if (closed) {
        throw new Error(
          `Execution-boundary live stream '${input.sourceId}' is already closed.`,
        );
      }
    };
    return {
      push(chunk: string): string {
        assertOpen();
        return redactor.push(chunk);
      },
      close(): string {
        assertOpen();
        closed = true;
        return redactor.flush();
      },
      discard(): void {
        assertOpen();
        closed = true;
        redactor.flush();
      },
    };
  }

  private assertDeclaredBoundary(boundary: ExecutionBoundaryV1): void {
    if (!this.policy.boundaries.includes(boundary)) {
      throw new Error(
        `Execution-boundary policy '${this.policy.policyId}' does not declare '${boundary}'.`,
      );
    }
  }
}

export function executionBoundaryHandling(
  boundary: ExecutionBoundaryV1,
): ExecutionBoundaryHandlingV1 {
  return executionBoundaryAdapter(boundary).handling;
}

export function executionBoundaryEvidenceMode(
  boundary: ExecutionBoundaryV1,
): ExecutionBoundaryEvidenceModeV1 {
  return executionBoundaryAdapter(boundary).evidenceMode;
}

function executionBoundaryAdapter(
  boundary: ExecutionBoundaryV1,
): ExecutionBoundaryAdapterV1 {
  const adapter = EXECUTION_BOUNDARY_ADAPTERS.find(
    (candidate) => candidate.boundary === boundary,
  );
  if (adapter === undefined) {
    throw new Error(`Execution boundary '${boundary}' has no registered adapter.`);
  }
  return adapter;
}

export function deriveSensitiveRepresentations(value: string): string[] {
  const utf8 = Buffer.from(value, "utf8");
  const base64 = utf8.toString("base64");
  const base64Url = utf8.toString("base64url");
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  return [...new Set([
    value,
    base64,
    base64.replace(/=+$/u, ""),
    base64Url,
    base64Url.replace(/=+$/u, ""),
    utf8.toString("hex"),
    utf8.toString("hex").toUpperCase(),
    encodeURIComponent(value),
    jsonEscaped,
  ].filter((representation) => representation.length > 0))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactValue(
  value: unknown,
  entries: RegisteredSensitiveValue[],
  references: Map<string, SensitiveValueReferenceV1>,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") {
    return redactStringValue(value, entries, references);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(redactValue(item, entries, references, seen));
    return output;
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactValue(item, entries, references, seen);
  }
  return output;
}

function redactStringValue(
  value: string,
  entries: RegisteredSensitiveValue[],
  references: Map<string, SensitiveValueReferenceV1>,
): string {
  let output = value;
  for (const entry of entries) {
    for (const representation of entry.representations) {
      if (!output.includes(representation)) continue;
      output = output.split(representation).join(REDACTION_PLACEHOLDER);
      references.set(entry.reference.referenceId, structuredClone(entry.reference));
    }
  }
  return output;
}

function shortDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32);
}

function getRegistryRepresentations(registry: SensitiveValueRegistry): string[] {
  return registry.representations();
}

function assertCanonicalBoundaryAdapters(
  adapters: readonly ExecutionBoundaryAdapterV1[],
): void {
  if (
    adapters.length !== EXECUTION_BOUNDARIES.length ||
    adapters.some((adapter, index) => adapter.boundary !== EXECUTION_BOUNDARIES[index])
  ) {
    throw new Error(
      "Execution-boundary adapters must match the exact canonical boundary order.",
    );
  }
}
