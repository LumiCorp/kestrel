import {
  createModeSwitchRetryGuard,
  type ConversationCommandAdapter,
  type ConversationMode,
} from "@kestrel-agents/conversation";

export interface KestrelOneTurnSubmission {
  intent: "start" | "queue";
  execute(): Promise<void>;
}

export interface KestrelOneInteractionAnswer {
  requestId: string;
  source: "runtime" | "mcp";
  execute(): Promise<void>;
}

export async function executeKestrelOneQueueSubmission<Receipt>(input: {
  submit(): Promise<Receipt>;
  install(receipt: Receipt): void | Promise<void>;
  refresh(): Promise<void>;
  onRefreshFailure(error: unknown): void;
}): Promise<Receipt> {
  const receipt = await input.submit();
  await input.install(receipt);
  try {
    await input.refresh();
  } catch (error) {
    try {
      input.onRefreshFailure(error);
    } catch {
      // A presentation callback cannot revoke an acknowledged queue submission.
    }
  }
  return receipt;
}

export function createKestrelOneConversationCommandAdapter(input: {
  interrupt(target: { threadId: string; turnId: string }): Promise<void>;
  switchMode(mode: ConversationMode): void | Promise<void>;
}): ConversationCommandAdapter<KestrelOneTurnSubmission, KestrelOneInteractionAnswer, void> {
  const modeSwitchGuard = createModeSwitchRetryGuard();
  const answerInteraction = async (answer: KestrelOneInteractionAnswer) => answer.execute();
  return {
    async startTurn(submission) {
      if (submission.intent !== "start") throw new Error("Kestrel One start command received a queue submission.");
      await submission.execute();
    },
    async queueTurn(submission) {
      if (submission.intent !== "queue") throw new Error("Kestrel One queue command received a start submission.");
      await submission.execute();
    },
    answerInteraction,
    interruptTurn: input.interrupt,
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
