import type { StepContext, StepIO, Transition, WaitForMatcher } from "../../../../../src/kestrel/contracts/execution.js";

import type { AutonomyPolicy } from "../../../../../src/governance/contracts.js";
import type {
  ManagedTaskWorktreeProposal,
  ManagedTaskWorktreeRequest,
} from "../../../../../src/workspace/ManagedTaskWorktreeService.js";
import type { ReactAction, ReadOnlyResultDuplicateLedgerEntry } from "../../types.js";
import { asArray, asRecord } from "../../../../shared/valueAccess.js";

export type ToolExecutionClass = "read_only" | "planning_write" | "sandboxed_only" | "external_side_effect";
export type CanonicalInteractionMode = "chat" | "plan" | "build";
export type ActSubmode = "strict" | "safe" | "full_auto" | undefined;

export interface ActerStepConfig {
  acterStepId: string;
  deliberationStepId: string;
  loopStepId: string;
  effectResultLookupTool: string;
  finalizeToolName: string;
  managedWorktreeProposalProvider?: ((request: ManagedTaskWorktreeRequest) => Promise<ManagedTaskWorktreeProposal>) | undefined;
  capabilityManifestProvider: (ctx: StepContext) => Array<{
    name: string;
    freshnessClass?: "live" | "volatile" | "static" | "runtime" | "snapshot" | undefined;
    capabilityClasses: string[];
    approvalCapabilities?: string[] | undefined;
    executionClass?: ToolExecutionClass | undefined;
    allowedInteractionModes?: CanonicalInteractionMode[] | undefined;
  }>;
}

export interface ExecutionPolicy {
  toolClassPolicy?: Partial<Record<ToolExecutionClass, boolean>> | undefined;
  capabilityPolicy?: Record<string, boolean> | undefined;
  approvalPolicy?: {
    strictApprovalPerCall?: boolean | undefined;
  } | undefined;
}

export interface ExecutionActionContext {
  capabilityManifest: ReturnType<ActerStepConfig["capabilityManifestProvider"]>;
  toolCapabilityClassesByName: Record<string, string[]>;
  toolApprovalCapabilitiesByName: Record<string, string[]>;
  toolExecutionClassByName: Record<string, ToolExecutionClass>;
  toolAllowedInteractionModesByName: Record<string, CanonicalInteractionMode[] | undefined>;
  reactState: Record<string, unknown>;
  activeRegion: string | undefined;
  checkpointSize: number;
  executionPolicy: ExecutionPolicy | undefined;
  autonomyPolicy: AutonomyPolicy | undefined;
  interactionMode: CanonicalInteractionMode;
  actSubmode: ActSubmode;
  modeSystemV2Enabled: boolean;
}

export interface PendingToolBatchItem {
  name: string;
  input: Record<string, unknown>;
  toolCallId?: string | undefined;
}

export interface PendingToolBatchState {
  items: PendingToolBatchItem[];
  nextIndex: number;
  completedItems: Array<PendingToolBatchItem & {
    output: unknown;
    reused?: boolean | undefined;
    cachedStepIndex?: number | undefined;
  }>;
  checkpointSize: number;
  executionMode?: "inline" | "durable" | undefined;
  pendingItem?:
    | PendingToolBatchItem & {
        idempotencyKey: string;
      }
    | undefined;
}

export type DuplicateLedger = ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;

export type AskUserAction = Extract<ReactAction, { kind: "ask_user" }>;
export type CannotSatisfyAction = Extract<ReactAction, { kind: "cannot_satisfy" }>;
export type FinalizeAction = Extract<ReactAction, { kind: "finalize" }>;
export type HandoffToBuildAction = Extract<ReactAction, { kind: "handoff_to_build" }>;
export type ToolBatchAction = Extract<ReactAction, { kind: "tool_batch" }>;

export function appendAgentObservation(
  reactState: Record<string, unknown>,
  observation: Record<string, unknown>,
): unknown[] {
  return [
    ...asArray(reactState.observations),
    observation,
  ].slice(-30);
}

export function withPromptMetadata(
  waitFor: AskUserAction["waitFor"],
  prompt: string,
): AskUserAction["waitFor"] {
  const existingMetadata = asRecord(waitFor.metadata);
  if (typeof existingMetadata?.prompt === "string" && existingMetadata.prompt.trim().length > 0) {
    return waitFor;
  }

  return {
    ...waitFor,
    metadata: {
      ...(existingMetadata ?? {}),
      prompt,
    },
  };
}

export type TransitionFactory = (...args: never[]) => Transition;
export type WaitForMatcherFactory = () => WaitForMatcher;
export type StepIo = StepIO;
