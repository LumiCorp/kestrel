import "server-only";

import { createHash } from "node:crypto";
import {
  parseRunnerExternalApprovalBindingV1,
  serializeCanonicalApprovalPayload,
  type RunnerExternalApprovalBindingV1,
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
  externalBinding: RunnerExternalApprovalBindingV1;
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
  const runtimeApprovalId = readString(approval.toolCallId);
  const approvalToolName = readString(approval.toolName);
  const metadataApprovalId = readString(metadata.approvalId);
  const metadataToolName = readString(metadata.toolName);
  let binding: RunnerExternalApprovalBindingV1;
  try {
    binding = parseRunnerExternalApprovalBindingV1(metadata.externalApprovalBinding);
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
    output.runId !== binding.runId ||
    (event.runId !== undefined && event.runId !== output.runId) ||
    binding.threadId !== input.threadId ||
    (event.threadId !== undefined && event.threadId !== input.threadId) ||
    payloadHash !== binding.payloadHash
  ) {
    throw new TrustedTerminalApprovalError("HOSTED_APPROVAL_TERMINAL_BINDING_MISMATCH");
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
