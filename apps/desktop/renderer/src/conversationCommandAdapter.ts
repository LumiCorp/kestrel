import {
  createModeSwitchRetryGuard,
  type ConversationCommandAdapter,
  type ConversationMode,
} from "@kestrel-agents/conversation";

import type {
  DesktopConversationMessageRequest,
  DesktopConversationMessageResult,
  DesktopOperatorControlRequest,
  DesktopOperatorControlResult,
  DesktopRunCancelRequest,
  DesktopRunCancellationResult,
  DesktopRuntimeThreadInspection,
} from "../../src/contracts";

export interface DesktopConversationTurnSubmission {
  request: DesktopConversationMessageRequest;
  install(result: DesktopConversationMessageResult): void | Promise<void>;
}

export type DesktopConversationInteractionAnswer =
  | {
      requestId: string;
      transport: "conversation";
      request: DesktopConversationMessageRequest;
      install(result: DesktopConversationMessageResult): void | Promise<void>;
    }
  | {
      requestId: string;
      transport: "operator";
      request: DesktopOperatorControlRequest;
      install(result: DesktopOperatorControlResult): void | Promise<void>;
    }
  | {
      requestId: string;
      transport: "host";
      execute(): void | Promise<void>;
    };

export function resolveDesktopInterruptAuthority(
  view: DesktopRuntimeThreadInspection | undefined,
  expectedRunId?: string | undefined,
): { threadId: string; turnId: string } | undefined {
  if (view === undefined) return undefined;
  const activeRunId = view.activeRun?.runId;
  if (activeRunId === undefined || (expectedRunId !== undefined && activeRunId !== expectedRunId)) {
    return undefined;
  }
  const activeTurn = view.conversationTurns?.find((turn) => turn.activeRunId === activeRunId);
  return activeTurn === undefined
    ? undefined
    : { threadId: view.thread.threadId, turnId: activeTurn.turnId };
}

export type DesktopRefreshedInterruptAuthority =
  | { status: "target"; target: { threadId: string; turnId: string } }
  | { status: "run_changed"; activeRunId: string }
  | { status: "already_stopped" }
  | { status: "invalid" };

export function resolveDesktopRefreshedInterruptAuthority(
  view: DesktopRuntimeThreadInspection,
  expectedRunId?: string | undefined,
): DesktopRefreshedInterruptAuthority {
  const activeRunId = view.activeRun?.runId;
  if (activeRunId === undefined) return { status: "already_stopped" };
  if (expectedRunId !== undefined && activeRunId !== expectedRunId) {
    return { status: "run_changed", activeRunId };
  }
  const target = resolveDesktopInterruptAuthority(view, expectedRunId);
  return target === undefined
    ? { status: "invalid" }
    : { status: "target", target };
}

export function createDesktopConversationCommandAdapter(input: {
  submitConversationMessage(request: DesktopConversationMessageRequest): Promise<DesktopConversationMessageResult>;
  submitOperatorControl(request: DesktopOperatorControlRequest): Promise<DesktopOperatorControlResult>;
  cancelRun(request: DesktopRunCancelRequest): Promise<DesktopRunCancellationResult>;
  resolveInterrupt(input: { threadId: string; turnId: string }): DesktopRunCancelRequest | undefined;
  installInterrupt(result: DesktopRunCancellationResult): void | Promise<void>;
  switchMode(mode: ConversationMode): void | Promise<void>;
  modeSwitchGuard?: ReturnType<typeof createModeSwitchRetryGuard> | undefined;
}): ConversationCommandAdapter<
  DesktopConversationTurnSubmission,
  DesktopConversationInteractionAnswer,
  void
> {
  const modeSwitchGuard = input.modeSwitchGuard ?? createModeSwitchRetryGuard();
  const submitTurn = async (submission: DesktopConversationTurnSubmission): Promise<void> => {
    await submission.install(await input.submitConversationMessage(submission.request));
  };
  const answerInteraction = async (answer: DesktopConversationInteractionAnswer): Promise<void> => {
    if (answer.transport === "host") {
      await answer.execute();
      return;
    }
    if (answer.transport === "operator" && answer.requestId !== answer.request.requestId) {
      throw new Error("Desktop interaction request identity does not match its command.");
    }
    if (answer.transport === "conversation") {
      await answer.install(await input.submitConversationMessage(answer.request));
      return;
    }
    await answer.install(await input.submitOperatorControl(answer.request));
  };
  return {
    startTurn: submitTurn,
    queueTurn: submitTurn,
    answerInteraction,
    async interruptTurn(target) {
      const request = input.resolveInterrupt(target);
      if (request === undefined) {
        throw new Error(`Desktop turn '${target.turnId}' has no authoritative active run.`);
      }
      await input.installInterrupt(await input.cancelRun(request));
    },
    async switchModeAndRetry(command) {
      await modeSwitchGuard.run({
        recommendationId: command.recommendationId,
        mode: command.mode,
        switchMode: input.switchMode,
        retry: () => answerInteraction(command.answer),
      });
    },
  };
}
