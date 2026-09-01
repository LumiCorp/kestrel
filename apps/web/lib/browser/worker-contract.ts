import type { PreparedToolCallV1 } from "../../../../src/kestrel/contracts/tool-invocation.js";
import type { BrowserEffectiveDomainAuthorityV1 } from "../../../../src/browser/domainAuthority.js";
import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";

export interface HostedBrowserWorkerIdentityV1 {
  sessionId: string;
  generation: number;
  engineRevision: string;
  chromeRevision: string;
  imageDigest: string;
}

export interface HostedBrowserRelayInstructionV1 {
  version: "hosted_browser_relay_instruction_v1";
  phase: "accept" | "invoke";
  operationId: string;
  operation: string;
  sessionId: string;
  generation: number;
  capability: string;
  machine: { appName: string; machineId: string };
  authority?: BrowserEffectiveDomainAuthorityV1 | undefined;
  session?: BrowserSessionV1 | undefined;
  prepared?: PreparedToolCallV1 | undefined;
}

export interface HostedBrowserRelayAcceptanceV1 {
  version: "hosted_browser_relay_acceptance_v1";
  receiptId: string;
  instruction: HostedBrowserRelayInstructionV1;
  worker: HostedBrowserAcceptedOperationV1 & {
    identity: HostedBrowserWorkerIdentityV1;
  };
}

export interface HostedBrowserPreDispatchCompletionV1 {
  version: "hosted_browser_pre_dispatch_completion_v1";
  receiptId: string;
  instruction: HostedBrowserRelayInstructionV1;
  worker: {
    completedBeforeDispatch: true;
    sessionId: string;
    generation: number;
    operationId: string;
    identity: HostedBrowserWorkerIdentityV1;
  };
}

export type HostedBrowserCompletionReceiptV1 =
  | HostedBrowserRelayAcceptanceV1
  | HostedBrowserPreDispatchCompletionV1;

export interface HostedBrowserRevisionInstructionV1 {
  version: "hosted_browser_revision_instruction_v1";
  sessionId: string;
  generation: number;
  revision: string;
  cause: "personal_grant" | "personal_revocation";
  authority: BrowserEffectiveDomainAuthorityV1;
  capability: string;
  machine: { appName: string; machineId: string };
}

export interface HostedBrowserAcceptedOperationV1 {
  accepted: true;
  sessionId: string;
  generation: number;
  operationId: string;
}

export function assertAcceptedHostedBrowserOperation(input: {
  receipt: HostedBrowserAcceptedOperationV1;
  sessionId: string;
  generation: number;
  operationId: string;
}): void {
  if (
    input.receipt.accepted !== true ||
    input.receipt.sessionId !== input.sessionId ||
    input.receipt.generation !== input.generation ||
    input.receipt.operationId !== input.operationId
  ) {
    throw new Error("BROWSER_ENGINE_FAILURE");
  }
}
