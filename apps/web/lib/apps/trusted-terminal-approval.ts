import "server-only";

import { createHash } from "node:crypto";
import {
  parseRunnerExternalApprovalBinding,
  RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION,
  RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V2,
  serializeCanonicalApprovalPayload,
  type RunnerExternalApprovalBinding,
} from "@kestrel-agents/protocol";
import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";

export class TrustedTerminalApprovalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TrustedTerminalApprovalError";
  }
}

export type TrustedTerminalApproval = {
  requestId: string;
  runtimeApprovalId: string;
  runId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  expiresAt: Date;
  externalBinding: RunnerExternalApprovalBinding;
};

export function readTrustedTerminalApprovalToolName(
  event: RunnerRunTerminalEvent,
): string | null {
  if (
    event.type !== "run.completed" ||
    event.payload.result.output.status !== "WAITING"
  ) {
    return null;
  }
  const waitFor = asRecord(event.payload.result.output.waitFor);
  if (waitFor?.kind !== "approval") return null;
  const interaction = asRecord(waitFor.interaction);
  const approval = asRecord(interaction?.approval);
  const metadata = asRecord(waitFor.metadata);
  return readString(metadata?.toolName) ?? readString(approval?.toolName);
}

export function parseTrustedTerminalApproval(input: {
  event: RunnerRunTerminalEvent;
  threadId: string;
}): TrustedTerminalApproval | null {
  const event = input.event;
  if (
    event.type !== "run.completed" ||
    event.payload.result.output.status !== "WAITING"
  ) {
    return null;
  }
  const output = event.payload.result.output;
  const waitFor = asRecord(output.waitFor);
  if (waitFor?.kind !== "approval") return null;
  const interaction = asRecord(waitFor.interaction);
  const approval = asRecord(interaction?.approval);
  const metadata = asRecord(waitFor.metadata);
  const toolInput = asRecord(metadata?.toolInput);
  if (!(interaction && approval && metadata && toolInput)) {
    throw new TrustedTerminalApprovalError("HOSTED_APPROVAL_TERMINAL_METADATA_INVALID");
  }
  const requestId = readString(interaction.requestId);
  const isV2 =
    interaction.version === RUNNER_HOSTED_TOOL_APPROVAL_INTERACTION_V2;
  const preparedInvocationId = readString(approval.preparedInvocationId);
  const runtimeApprovalId = isV2
    ? requestId
    : readString(approval.toolCallId);
  const approvalToolName = readString(approval.toolName);
  const metadataApprovalId = readString(metadata.approvalId);
  const metadataToolName = readString(metadata.toolName);
  let binding: RunnerExternalApprovalBinding;
  try {
    binding = parseRunnerExternalApprovalBinding(metadata.externalApprovalBinding);
  } catch {
    throw new TrustedTerminalApprovalError("HOSTED_APPROVAL_EXTERNAL_BINDING_INVALID");
  }
  const payloadHash = `sha256:${createHash("sha256")
    .update(serializeCanonicalApprovalPayload(toolInput))
    .digest("hex")}`;
  if (
    !requestId ||
    !runtimeApprovalId ||
    !approvalToolName ||
    runtimeApprovalId !== metadataApprovalId ||
    runtimeApprovalId !== binding.approvalId ||
    approvalToolName !== metadataToolName ||
    approvalToolName !== binding.actionKey ||
    (binding.version !== RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION &&
      output.runId !== binding.runId) ||
    (event.runId !== undefined && event.runId !== output.runId) ||
    binding.threadId !== input.threadId ||
    (event.threadId !== undefined && event.threadId !== input.threadId) ||
    payloadHash !== binding.payloadHash
  ) {
    throw new TrustedTerminalApprovalError("HOSTED_APPROVAL_TERMINAL_BINDING_MISMATCH");
  }
  if (binding.version === RUNNER_EXTERNAL_APPROVAL_BINDING_V2_VERSION) {
    const prepared = asRecord(metadata.preparedToolCall);
    const preparedApproval = asRecord(prepared?.approval);
    const preparedAuthority = asRecord(prepared?.stableAuthority);
    if (
      !isV2 ||
      !preparedInvocationId ||
      preparedInvocationId !== binding.preparedInvocationId ||
      readString(prepared?.callId) !== binding.preparedInvocationId ||
      readString(prepared?.runId) !== output.runId ||
      readString(preparedAuthority?.fingerprint) !==
        binding.stableAuthorityFingerprint ||
      serializeCanonicalApprovalPayload(prepared?.effectiveInput) !==
        serializeCanonicalApprovalPayload(toolInput) ||
      serializeCanonicalApprovalPayload(prepared?.stableToolIdentity) !==
        serializeCanonicalApprovalPayload(binding.stableToolIdentity) ||
      serializeCanonicalApprovalPayload(
        preparedApproval?.externalApprovalBinding,
      ) !== serializeCanonicalApprovalPayload(binding) ||
      serializeCanonicalApprovalPayload(approval.stableToolIdentity) !==
        serializeCanonicalApprovalPayload(binding.stableToolIdentity)
    ) {
      throw new TrustedTerminalApprovalError(
        "HOSTED_APPROVAL_TERMINAL_BINDING_MISMATCH",
      );
    }
  } else if (isV2) {
    throw new TrustedTerminalApprovalError(
      "HOSTED_APPROVAL_TERMINAL_BINDING_MISMATCH",
    );
  }
  const expiresAt = new Date(binding.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new TrustedTerminalApprovalError("HOSTED_APPROVAL_TERMINAL_EXPIRED");
  }
  return {
    requestId,
    runtimeApprovalId,
    runId: output.runId,
    toolName: approvalToolName,
    toolInput,
    expiresAt,
    externalBinding: binding,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
