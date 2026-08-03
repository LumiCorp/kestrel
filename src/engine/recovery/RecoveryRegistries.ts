import { createHash } from "node:crypto";

import type {
  AgentToolResult,
  ModelGateway,
} from "../../kestrel/contracts/model-io.js";
import type {
  RecoveryModelCandidateV1,
} from "../../kestrel/contracts/recovery.js";

export interface RecoveryModelRegistration {
  candidate: RecoveryModelCandidateV1;
  policyRevision: string;
  gateway: ModelGateway;
}

export class RecoveryModelRegistry {
  private readonly registrations = new Map<string, RecoveryModelRegistration>();

  register(registration: RecoveryModelRegistration): void {
    const candidateId = registration.candidate.candidateId;
    if (this.registrations.has(candidateId)) {
      throw new Error(`Recovery model candidate '${candidateId}' is already registered.`);
    }
    this.registrations.set(candidateId, structuredCloneRegistration(registration));
  }

  resolve(input: {
    candidate: RecoveryModelCandidateV1;
    policyRevision: string;
  }): RecoveryModelRegistration | undefined {
    const registered = this.registrations.get(input.candidate.candidateId);
    if (
      registered === undefined ||
      registered.policyRevision !== input.policyRevision ||
      candidateIdentity(registered.candidate) !== candidateIdentity(input.candidate)
    ) {
      return;
    }
    return registered;
  }

  list(): RecoveryModelRegistration[] {
    return [...this.registrations.values()].map(structuredCloneRegistration);
  }
}

export interface RecoveryToolAdapterContext {
  runId: string;
  sessionId: string;
  sourceToolId: string;
  targetToolId: string;
  sourceCallId?: string | undefined;
}

export interface RecoveryToolAdapter {
  adapterId: string;
  sourceToolId: string;
  targetToolId: string;
  targetAuthority: {
    toolClass: "read_only" | "sandboxed_only" | "external_side_effect";
    capabilities: string[];
    revision: string;
  };
  validateSource(input: unknown, context: RecoveryToolAdapterContext): void;
  transformInput(input: unknown, context: RecoveryToolAdapterContext): unknown;
  normalizeResult(result: AgentToolResult, context: RecoveryToolAdapterContext): AgentToolResult;
}

export class RecoveryToolAdapterRegistry {
  private readonly adapters = new Map<string, RecoveryToolAdapter>();

  register(adapter: RecoveryToolAdapter): void {
    if (this.adapters.has(adapter.adapterId)) {
      throw new Error(`Recovery tool adapter '${adapter.adapterId}' is already registered.`);
    }
    this.adapters.set(adapter.adapterId, adapter);
  }

  resolve(input: {
    adapterId: string;
    sourceToolId: string;
    targetToolId: string;
  }): RecoveryToolAdapter | undefined {
    const adapter = this.adapters.get(input.adapterId);
    if (
      adapter === undefined ||
      adapter.sourceToolId !== input.sourceToolId ||
      adapter.targetToolId !== input.targetToolId
    ) {
      return;
    }
    return adapter;
  }

  list(): RecoveryToolAdapter[] {
    return [...this.adapters.values()];
  }
}

export interface NormalizedRecoveryToolResult {
  status: "success" | "failure";
  failureCode?: string | undefined;
}

export type RecoveryToolResultNormalizer = (
  result: AgentToolResult,
) => NormalizedRecoveryToolResult;

export class RecoveryToolResultNormalizerRegistry {
  private readonly normalizers = new Map<string, RecoveryToolResultNormalizer>();

  register(toolId: string, normalizer: RecoveryToolResultNormalizer): void {
    if (this.normalizers.has(toolId)) {
      throw new Error(`Recovery result normalizer for '${toolId}' is already registered.`);
    }
    this.normalizers.set(toolId, normalizer);
  }

  normalize(toolId: string, result: AgentToolResult): NormalizedRecoveryToolResult {
    const normalizer = this.normalizers.get(toolId);
    if (normalizer === undefined) {
      if (result.status === "OK") return { status: "success" };
      return { status: "failure", failureCode: "TOOL_EXECUTION_FAILED" };
    }
    return normalizer(result);
  }

  listToolIds(): string[] {
    return [...this.normalizers.keys()];
  }
}

export interface RecoveryWorkflowContext {
  runId: string;
  sessionId: string;
  failureCode: string;
  stepIndex?: number | undefined;
  execute?: (() => Promise<unknown>) | undefined;
}

export function registerDefaultRecoveryWorkflowHandlers(
  registry: RecoveryWorkflowHandlerRegistry,
): void {
  for (const handlerId of [
    "context.compaction",
    "run.continuation",
    "run.loop_recovery",
  ]) {
    if (registry.resolve(handlerId) !== undefined) continue;
    registry.register(handlerId, async (context) => {
      if (context.execute === undefined) {
        throw new Error(`Recovery workflow '${handlerId}' requires an execution callback.`);
      }
      return context.execute();
    });
  }
}

export type RecoveryWorkflowHandler<T = unknown> = (
  context: RecoveryWorkflowContext,
) => Promise<T>;

export class RecoveryWorkflowHandlerRegistry {
  private readonly handlers = new Map<string, RecoveryWorkflowHandler>();

  register(handlerId: string, handler: RecoveryWorkflowHandler): void {
    if (this.handlers.has(handlerId)) {
      throw new Error(`Recovery workflow handler '${handlerId}' is already registered.`);
    }
    this.handlers.set(handlerId, handler);
  }

  resolve(handlerId: string): RecoveryWorkflowHandler | undefined {
    return this.handlers.get(handlerId);
  }

  listHandlerIds(): string[] {
    return [...this.handlers.keys()];
  }
}

export function createDefaultRecoveryToolResultNormalizers(): RecoveryToolResultNormalizerRegistry {
  const registry = new RecoveryToolResultNormalizerRegistry();
  registry.register("code.execute", normalizeCodeExecuteResult);
  return registry;
}

function normalizeCodeExecuteResult(result: AgentToolResult): NormalizedRecoveryToolResult {
  if (result.status === "FAILED") {
    const errorCode = asString(asRecord(result.auditRecord.error)?.code);
    if (errorCode === "SANDBOX_UNAVAILABLE") {
      return { status: "failure", failureCode: "SANDBOX_UNAVAILABLE" };
    }
    if (errorCode === "SANDBOX_TIMEOUT") {
      return { status: "failure", failureCode: "SANDBOX_TIMEOUT" };
    }
    return { status: "failure", failureCode: "TOOL_EXECUTION_FAILED" };
  }
  const output = asRecord(result.auditRecord.output);
  switch (output?.status) {
    case "runtime_unavailable":
      return { status: "failure", failureCode: "SANDBOX_UNAVAILABLE" };
    case "timeout":
      return { status: "failure", failureCode: "SANDBOX_TIMEOUT" };
    case "ok":
      return { status: "success" };
    case "blocked":
      return { status: "failure", failureCode: "POLICY_DENIED" };
    case "error":
      return { status: "failure", failureCode: "TOOL_EXECUTION_FAILED" };
    default:
      return { status: "failure", failureCode: "TOOL_RESULT_CONTRACT_INVALID" };
  }
}

function candidateIdentity(candidate: RecoveryModelCandidateV1): string {
  return createHash("sha256")
    .update(stableJson(candidate))
    .digest("hex");
}

function structuredCloneRegistration(
  registration: RecoveryModelRegistration,
): RecoveryModelRegistration {
  return {
    candidate: structuredClone(registration.candidate),
    policyRevision: registration.policyRevision,
    gateway: registration.gateway,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
