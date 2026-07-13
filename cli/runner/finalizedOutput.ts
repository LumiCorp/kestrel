import type { RunTurnResult } from "../runtime/KestrelChatRuntime.js";

export function summarizeRunTurnResult(result: RunTurnResult): {
  text: string;
  raw: unknown;
} {
  return {
    text: result.assistantText ?? "",
    raw: result.finalizedPayload !== undefined ? result.finalizedPayload : result.output,
  };
}
