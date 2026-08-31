import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { NextResponse } from "next/server";
import {
  parseBrowserAllowlistAdoptionRequestV1,
  BROWSER_ARTIFACT_AUTHORIZATION_VERSION,
  BROWSER_POLICY_RESOLUTION_VERSION,
  isBrowserToolName,
  type BrowserArtifactAuthorizationRequestV1,
} from "../../../../src/browser/contracts.js";
import { parsePreparedToolCallV1 } from "../../../../src/kestrel/contracts/tool-invocation.js";
import type { HostedBrowserService } from "./service";

export const HOSTED_BROWSER_CONTROL_MAX_REQUEST_BYTES = 20 * 1024 * 1024;

type ServiceResolver = (input: {
  ticket: EnvironmentExecutionTicket;
  projectId: string;
}) => Promise<HostedBrowserService>;

let serviceResolver: ServiceResolver | undefined;

/** Application bootstrap installs the control-plane composition, never a worker or client. */
export function configureHostedBrowserServiceResolver(
  resolver: ServiceResolver,
): () => void {
  if (serviceResolver) {
    throw new Error("Hosted Browser service resolver is already configured.");
  }
  serviceResolver = resolver;
  return () => {
    if (serviceResolver === resolver) serviceResolver = undefined;
  };
}

export async function handleHostedBrowserControl(input: {
  request: Request;
  action: string;
  ticket: EnvironmentExecutionTicket;
  projectId: string;
}) {
  try {
    const body = await readBoundedControlJson(input.request);
    const resolver =
      serviceResolver ??
      (await import("./composition")).resolveHostedBrowserService;
    const service = await resolver({
      ticket: input.ticket,
      projectId: input.projectId,
    });
    switch (input.action) {
      case "policy":
        return NextResponse.json(await service.resolvePolicy(parsePolicyRequest(body)));
      case "prepare-upload":
        return NextResponse.json(
          await service.prepareUpload(parseUploadPreparationRequest(body)),
        );
      case "prepare-download":
        return NextResponse.json(
          await service.prepareDownload(parseDownloadPreparationRequest(body)),
        );
      case "accept": {
        const record = requireRecord(body);
        const prepared = parsePreparedToolCallV1(record.prepared);
        return NextResponse.json(
          await service.acceptOperation(
            prepared,
            parseHostAuthority(record.authority),
          ),
        );
      }
      case "invoke": {
        const record = requireRecord(body);
        const prepared = parsePreparedToolCallV1(record.prepared);
        return NextResponse.json(
          await service.dispatchAcceptedOperation(
            prepared,
            parseHostAuthority(record.authority),
            parseDispatchReceipt(record.receipt, prepared.callId),
            input.request.signal,
          ),
        );
      }
      case "complete": {
        const record = requireRecord(body);
        const prepared = parsePreparedToolCallV1(record.prepared);
        return NextResponse.json(
          await service.completeAcceptedOperation(
            prepared,
            parseHostAuthority(record.authority),
            parseCompletionReceipt(record.receipt, prepared.callId),
            record.output,
          ),
        );
      }
      case "unknown": {
        const record = requireRecord(body);
        const prepared = parsePreparedToolCallV1(record.prepared);
        await service.markAcceptedOperationUnknown(
          prepared,
          parseHostAuthority(record.authority),
          parseDispatchReceipt(record.receipt, prepared.callId),
        );
        return NextResponse.json({ lost: true });
      }
      case "artifact":
        return NextResponse.json(
          (await service.authorizeArtifact(
            parseArtifactAuthorization(body),
          )) ?? null,
        );
      case "adopt":
        return NextResponse.json(
          await service.prepareAllowlistAdoption(
            parseBrowserAllowlistAdoptionRequestV1(body),
          ),
        );
      case "adopt-complete": {
        const record = requireRecord(body);
        const adopted = requireRecord(record.adopted);
        if (
          typeof adopted.revision !== "string" ||
          !Number.isInteger(adopted.closedUnauthorizedConnections) ||
          Number(adopted.closedUnauthorizedConnections) < 0
        ) throw new Error("BROWSER_ENGINE_FAILURE");
        return NextResponse.json(
          await service.completeAllowlistAdoption(
            parseBrowserAllowlistAdoptionRequestV1(record.request),
            {
              revision: adopted.revision,
              closedUnauthorizedConnections:
                adopted.closedUnauthorizedConnections as number,
            },
          ),
        );
      }
      default:
        return NextResponse.json(
          { error: { code: "BROWSER_CONTROL_TARGET_DENIED" } },
          { status: 404 },
        );
    }
  } catch (error) {
    const code = readBrowserCode(error);
    const details = readBrowserDetails(error);
    return NextResponse.json(
      { error: { code, ...(details ? { details } : {}) } },
      { status: readBrowserStatus(error, code) },
    );
  }
}

function parseUploadPreparationRequest(value: unknown) {
  const record = requireRecord(value);
  if (
    record.version !== "browser_upload_preparation_v1" ||
    typeof record.runId !== "string" ||
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    !record.effectiveInput ||
    typeof record.effectiveInput !== "object" ||
    Array.isArray(record.effectiveInput) ||
    !record.attachment ||
    typeof record.attachment !== "object" ||
    Array.isArray(record.attachment)
  ) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  return record as unknown as Parameters<HostedBrowserService["prepareUpload"]>[0];
}

function parseDownloadPreparationRequest(value: unknown) {
  const record = requireRecord(value);
  if (
    record.version !== "browser_download_preparation_v1" ||
    typeof record.runId !== "string" ||
    typeof record.threadId !== "string" ||
    !record.effectiveInput ||
    typeof record.effectiveInput !== "object" ||
    Array.isArray(record.effectiveInput) ||
    !record.authority ||
    typeof record.authority !== "object" ||
    Array.isArray(record.authority)
  ) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  return record as unknown as Parameters<HostedBrowserService["prepareDownload"]>[0];
}

function readBrowserDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object" || !("details" in error)) return;
  const details = error.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
}

async function readBoundedControlJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > HOSTED_BROWSER_CONTROL_MAX_REQUEST_BYTES
  ) {
    throw browserControlError("BROWSER_CONTROL_BODY_TOO_LARGE", 413);
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > HOSTED_BROWSER_CONTROL_MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => {});
      throw browserControlError("BROWSER_CONTROL_BODY_TOO_LARGE", 413);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw browserControlError("BROWSER_SERVICE_UNAVAILABLE", 400);
  }
}

function parseHostAuthority(value: unknown) {
  const record = requireRecord(value);
  if (
    typeof record.threadId !== "string" ||
    typeof record.projectId !== "string"
  ) {
    throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  }
  return { threadId: record.threadId, projectId: record.projectId };
}

function parsePolicyRequest(value: unknown) {
  const record = requireRecord(value);
  if (
    record.version !== BROWSER_POLICY_RESOLUTION_VERSION ||
    typeof record.runId !== "string" ||
    typeof record.threadId !== "string" ||
    !isBrowserToolName(String(record.operation)) ||
    !record.effectiveInput ||
    typeof record.effectiveInput !== "object" ||
    Array.isArray(record.effectiveInput)
  ) {
    throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  }
  return {
    version: BROWSER_POLICY_RESOLUTION_VERSION,
    runId: record.runId,
    threadId: record.threadId,
    operation: record.operation as Parameters<HostedBrowserService["resolvePolicy"]>[0]["operation"],
    effectiveInput: record.effectiveInput as Record<string, unknown>,
    authority: parseHostAuthority(record.authority),
  };
}

function parseArtifactAuthorization(
  value: unknown,
): BrowserArtifactAuthorizationRequestV1 {
  const record = requireRecord(value);
  const toolName =
    record.toolName === "browser.capture" || record.toolName === "browser.download"
      ? record.toolName
      : undefined;
  const artifactKind =
    record.artifactKind === "browser-screenshot" ||
    record.artifactKind === "browser-download"
      ? record.artifactKind
      : undefined;
  if (
    record.version !== BROWSER_ARTIFACT_AUTHORIZATION_VERSION ||
    toolName === undefined ||
    artifactKind === undefined
  ) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  const result: BrowserArtifactAuthorizationRequestV1 = {
    version: BROWSER_ARTIFACT_AUTHORIZATION_VERSION,
    runId: requiredString(record.runId),
    threadId: requiredString(record.threadId),
    callId: requiredString(record.callId),
    toolName,
    sessionId: requiredString(record.sessionId),
    artifactId: requiredString(record.artifactId),
    artifactKind,
    ...(typeof record.artifactUrl === "string"
      ? { artifactUrl: record.artifactUrl }
      : {}),
  };
  return result;
}

function parseDispatchReceipt(value: unknown, operationId: string) {
  const record = requireRecord(value);
  const instruction = requireRecord(record.instruction);
  const worker = requireRecord(record.worker);
  const identity = requireRecord(worker.identity);
  const machine = requireRecord(instruction.machine);
  if (
    record.version !== "hosted_browser_relay_acceptance_v1" ||
    typeof record.receiptId !== "string" ||
    instruction.version !== "hosted_browser_relay_instruction_v1" ||
    instruction.phase !== "accept" ||
    instruction.operationId !== operationId ||
    typeof instruction.operation !== "string" ||
    typeof instruction.sessionId !== "string" ||
    !Number.isInteger(instruction.generation) ||
    typeof instruction.capability !== "string" ||
    typeof machine.appName !== "string" ||
    typeof machine.machineId !== "string" ||
    worker.accepted !== true ||
    worker.operationId !== operationId ||
    worker.sessionId !== instruction.sessionId ||
    worker.generation !== instruction.generation ||
    identity.sessionId !== instruction.sessionId ||
    identity.generation !== instruction.generation ||
    typeof identity.engineRevision !== "string" ||
    typeof identity.chromeRevision !== "string" ||
    typeof identity.imageDigest !== "string"
  ) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  return {
    version: "hosted_browser_relay_acceptance_v1" as const,
    receiptId: record.receiptId,
    instruction: {
      version: "hosted_browser_relay_instruction_v1" as const,
      phase: "accept" as const,
      operationId,
      operation: instruction.operation,
      sessionId: instruction.sessionId,
      generation: instruction.generation as number,
      capability: instruction.capability,
      machine: { appName: machine.appName, machineId: machine.machineId },
    },
    worker: {
      accepted: true as const,
      operationId,
      sessionId: worker.sessionId as string,
      generation: worker.generation as number,
      identity: {
        sessionId: identity.sessionId as string,
        generation: identity.generation as number,
        engineRevision: identity.engineRevision as string,
        chromeRevision: identity.chromeRevision as string,
        imageDigest: identity.imageDigest as string,
      },
    },
  };
}

function parseCompletionReceipt(value: unknown, operationId: string) {
  const record = requireRecord(value);
  if (record.version === "hosted_browser_relay_acceptance_v1") {
    return parseDispatchReceipt(value, operationId);
  }
  const instruction = requireRecord(record.instruction);
  const worker = requireRecord(record.worker);
  const identity = requireRecord(worker.identity);
  const machine = requireRecord(instruction.machine);
  if (
    record.version !== "hosted_browser_pre_dispatch_completion_v1" ||
    typeof record.receiptId !== "string" ||
    instruction.version !== "hosted_browser_relay_instruction_v1" ||
    instruction.phase !== "accept" ||
    instruction.operationId !== operationId ||
    typeof instruction.operation !== "string" ||
    typeof instruction.sessionId !== "string" ||
    !Number.isInteger(instruction.generation) ||
    typeof instruction.capability !== "string" ||
    typeof machine.appName !== "string" ||
    typeof machine.machineId !== "string" ||
    worker.completedBeforeDispatch !== true ||
    worker.operationId !== operationId ||
    worker.sessionId !== instruction.sessionId ||
    worker.generation !== instruction.generation ||
    identity.sessionId !== instruction.sessionId ||
    identity.generation !== instruction.generation ||
    typeof identity.engineRevision !== "string" ||
    typeof identity.chromeRevision !== "string" ||
    typeof identity.imageDigest !== "string"
  ) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  return {
    version: "hosted_browser_pre_dispatch_completion_v1" as const,
    receiptId: record.receiptId,
    instruction: {
      version: "hosted_browser_relay_instruction_v1" as const,
      phase: "accept" as const,
      operationId,
      operation: instruction.operation,
      sessionId: instruction.sessionId,
      generation: instruction.generation as number,
      capability: instruction.capability,
      machine: { appName: machine.appName, machineId: machine.machineId },
    },
    worker: {
      completedBeforeDispatch: true as const,
      operationId,
      sessionId: worker.sessionId as string,
      generation: worker.generation as number,
      identity: {
        sessionId: identity.sessionId as string,
        generation: identity.generation as number,
        engineRevision: identity.engineRevision as string,
        chromeRevision: identity.chromeRevision as string,
        imageDigest: identity.imageDigest as string,
      },
    },
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
  return value;
}

function readBrowserCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error &&
    typeof error.code === "string" && error.code.startsWith("BROWSER_")
    ? error.code
    : error instanceof Error && error.message.startsWith("BROWSER_")
      ? error.message
      : "BROWSER_ENGINE_FAILURE";
}

function readBrowserStatus(error: unknown, code: string): number {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return code === "BROWSER_SERVICE_UNAVAILABLE" ? 503 : 409;
}

function browserControlError(code: string, status: number): Error {
  return Object.assign(new Error(code), { code, status });
}
