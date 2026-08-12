import {
  parseRunnerStructuredReviewInteractionV1,
  type RunnerStructuredReviewClassificationV1,
} from "@kestrel-agents/protocol";
import type { ThreadInteractionView } from "./client-contract";

export function readThreadStructuredReview(
  interaction: ThreadInteractionView,
): RunnerStructuredReviewClassificationV1 {
  if (interaction.source !== "runtime" || interaction.kind !== "user_input") {
    return { kind: "ordinary" };
  }
  return parseRunnerStructuredReviewInteractionV1(
    interaction.requestEnvelope,
  );
}
