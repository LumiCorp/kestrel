import type { RunEventType } from "../kestrel/contracts/base.js";
import type { RuntimeEvent } from "../kestrel/contracts/events.js";
import type { Transition } from "../kestrel/contracts/execution.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";

import {
  buildCanonicalWaitingFor,
  buildWaitResumeToken,
  readActiveWaitState,
  type RuntimeWaitMatcher,
} from "../runtime/waitState.js";

type RunEventLevel = "INFO" | "WARN" | "ERROR";

export interface WaitResumeCoordinatorDependencies {
  appendRunEvent: (
    runId: string,
    sessionId: string,
    type: RunEventType,
    level: RunEventLevel,
    metadata: Record<string, unknown>,
    stepIndex?: number | undefined,
  ) => Promise<void>;
}

export class WaitResumeCoordinator {
  private readonly appendRunEvent: WaitResumeCoordinatorDependencies["appendRunEvent"];

  constructor(deps: WaitResumeCoordinatorDependencies) {
    this.appendRunEvent = deps.appendRunEvent;
  }

  async appendResumeEvents(input: {
    runId: string;
    session: SessionRecord;
    event: RuntimeEvent;
    orchestrationMetadata: Record<string, unknown>;
  }): Promise<void> {
    const activeWait = readActiveWaitState(asRecord(input.session.state.agent));
    const metadata = {
      eventType: input.event.type,
      ...input.orchestrationMetadata,
      ...(activeWait !== undefined ? { wait: activeWait } : {}),
    };
    await this.appendRunEvent(input.runId, input.session.sessionId, "wait.resumed", "INFO", metadata);
    await this.appendRunEvent(input.runId, input.session.sessionId, "run.resumed", "INFO", metadata);
  }

  buildWaitingFor(input: {
    waitFor: RuntimeWaitMatcher;
    resumeStepAgent: string;
    reason: string;
    resumeInstruction?: string | undefined;
    blockedAction?: Record<string, unknown> | undefined;
  }) {
    return buildCanonicalWaitingFor({
      waitFor: input.waitFor,
      resumeStepAgent: input.resumeStepAgent,
      resumeToken: buildWaitResumeToken({
        waitFor: input.waitFor,
        resumeStepAgent: input.resumeStepAgent,
      }),
      reason: input.reason,
      resumeInstruction: input.resumeInstruction ?? `Resume when ${input.waitFor.eventType} is received.`,
      ...(input.blockedAction !== undefined ? { blockedAction: input.blockedAction } : {}),
    });
  }

  buildWaitingForFromTransition(input: {
    waitFor: Transition["waitFor"];
    resumeStepAgent: string | undefined;
    blockedAction?: Record<string, unknown> | undefined;
  }) {
    const runtimeWaitFor = toRuntimeWaitMatcher(input.waitFor);
    if (runtimeWaitFor === undefined || input.resumeStepAgent === undefined) {
      return ;
    }
    return this.buildWaitingFor({
      waitFor: runtimeWaitFor,
      resumeStepAgent: input.resumeStepAgent,
      reason: readWaitReason(input.waitFor),
      resumeInstruction: `Resume when ${input.waitFor?.eventType} is received.`,
      ...(input.blockedAction !== undefined ? { blockedAction: input.blockedAction } : {}),
    });
  }

  buildWaitResumeToken(waitFor: Transition["waitFor"], resumeStepAgent: string | undefined): string {
    return buildWaitResumeToken({
      waitFor: toRuntimeWaitMatcher(waitFor),
      resumeStepAgent,
    });
  }

  buildRegionMergeWait(input: {
    session: SessionRecord;
    step: string;
    waitFor: RuntimeWaitMatcher;
  }): {
    transition: Transition;
    state: Record<string, unknown>;
  } {
    const agent = asRecord(input.session.state.agent) ?? {};
    const waitingFor = this.buildWaitingFor({
      waitFor: input.waitFor,
      resumeStepAgent: input.step,
      reason: "region_merge",
    });
    const state = {
      ...input.session.state,
      agent: {
        ...agent,
        waitingFor,
      },
    };
    return {
      state,
      transition: {
        status: "WAITING",
        nextStepAgent: input.step,
        waitFor: input.waitFor,
        statePatch: {
          agent: {
            ...agent,
            waitingFor,
          },
        },
      },
    };
  }

  async appendWaitingEvents(input: {
    runId: string;
    sessionId: string;
    finalStep: string;
    transition: Transition;
    orchestrationMetadata: Record<string, unknown>;
    stepIndex?: number | undefined;
  }): Promise<void> {
    await this.appendRunEvent(input.runId, input.sessionId, "wait.entered", "INFO", {
      finalStep: input.finalStep,
      ...input.orchestrationMetadata,
      ...(input.transition.waitFor !== undefined
        ? {
            wait: {
              kind: input.transition.waitFor.kind,
              eventType: input.transition.waitFor.eventType,
              resumeStepAgent: input.transition.nextStepAgent,
            },
          }
        : {}),
    }, input.stepIndex);
    await this.appendRunEvent(input.runId, input.sessionId, "run.waiting", "INFO", {
      finalStep: input.finalStep,
      ...input.orchestrationMetadata,
      ...(input.transition.waitFor !== undefined
        ? {
            waitFor: {
              eventType: input.transition.waitFor.eventType,
              ...(input.transition.waitFor.metadata !== undefined
                ? { metadata: input.transition.waitFor.metadata }
                : {}),
            },
          }
        : {}),
    }, input.stepIndex);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function readWaitReason(waitFor: Transition["waitFor"]): string {
  const metadata = asRecord(waitFor?.metadata);
  return readNonEmptyString(metadata?.reason) ??
    readNonEmptyString(metadata?.prompt) ??
    readNonEmptyString(waitFor?.eventType) ??
    "runtime wait";
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toRuntimeWaitMatcher(waitFor: Transition["waitFor"]): RuntimeWaitMatcher | undefined {
  if (waitFor === undefined || waitFor.kind === undefined) {
    return ;
  }
  return {
    kind: waitFor.kind,
    eventType: waitFor.eventType,
    ...(waitFor.timeoutMs !== undefined ? { timeoutMs: waitFor.timeoutMs } : {}),
    ...(waitFor.metadata !== undefined ? { metadata: waitFor.metadata } : {}),
  };
}
