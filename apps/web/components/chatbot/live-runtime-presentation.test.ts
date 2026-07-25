import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import {
  applyLiveProgress,
  applyProviderRetry,
  applyProviderReasoning,
  displayLiveReasoning,
  finishLiveRuntimePresentation,
  LIVE_REASONING_TRUNCATION_NOTICE,
  MAX_LIVE_REASONING_BYTES,
} from "./live-runtime-presentation";

const reasoningUpdate = (
  input: Partial<Parameters<typeof applyProviderReasoning>[1]> = {},
): Parameters<typeof applyProviderReasoning>[1] => ({
  id: "reasoning-1",
  assistantMessageId: "assistant-1",
  runId: "run-1",
  sequence: 1,
  timestamp: "2026-07-24T12:00:00.000Z",
  attempt: 1,
  format: "summary",
  label: "Provider reasoning summary",
  event: "delta",
  contentState: "live",
  delta: "Inspecting the workspace.",
  ...input,
});

contractTest("web.hermetic", "live reasoning stays separate from live progress", () => {
  const withProgress = applyLiveProgress(null, {
    id: "progress-1",
    assistantMessageId: "assistant-1",
    runId: "run-1",
    sequence: 1,
    timestamp: "2026-07-24T12:00:00.000Z",
    source: "runtime",
    phase: "chat",
    code: "MODEL_ATTEMPT_STARTED",
    text: "Provider attempt 1/3 started.",
    severity: "info",
    persist: false,
  });
  const state = applyProviderReasoning(withProgress, reasoningUpdate());

  assert.equal(state?.activityStatus?.text, "Provider attempt 1/3 started.");
  assert.equal(state?.reasoning?.text, "Inspecting the workspace.");
});

contractTest("web.hermetic", "reasoning availability status survives later heartbeat replacement", () => {
  const unavailable = applyProviderReasoning(
    null,
    reasoningUpdate({
      event: "unavailable",
      delta: undefined,
    }),
  );
  const waiting = applyLiveProgress(unavailable, {
    id: "progress-2",
    assistantMessageId: "assistant-1",
    timestamp: "2026-07-24T12:00:02.000Z",
    source: "runtime",
    phase: "chat",
    code: "RUN_STILL_ACTIVE",
    text: "Still working on model response...",
    severity: "info",
    persist: false,
  });

  assert.equal(
    waiting?.reasoningStatus?.text,
    "Provider reasoning is unavailable for this model.",
  );
  assert.equal(
    waiting?.activityStatus?.text,
    "Still working on model response...",
  );
});

contractTest("web.hermetic", "a newer provider attempt replaces failed-attempt reasoning", () => {
  const first = applyProviderReasoning(null, reasoningUpdate());
  const retrying = applyProviderRetry(first, {
    id: "progress-retry",
    assistantMessageId: "assistant-1",
    runId: "run-1",
    sequence: 2,
    timestamp: "2026-07-24T12:00:01.000Z",
    source: "runtime",
    phase: "chat",
    code: "MODEL_ATTEMPT_RETRYING",
    text: "Provider attempt 1/2 failed; retrying in 250 ms.",
    severity: "info",
    persist: true,
  });
  assert.equal(retrying?.reasoning, null);

  const second = applyProviderReasoning(
    retrying,
    reasoningUpdate({
      id: "reasoning-2",
      attempt: 2,
      event: "started",
      delta: undefined,
    }),
  );
  const secondDelta = applyProviderReasoning(
    second,
    reasoningUpdate({
      id: "reasoning-3",
      attempt: 2,
      delta: "Trying the provider again.",
    }),
  );

  assert.equal(secondDelta?.reasoning?.attempt, 2);
  assert.equal(secondDelta?.reasoning?.text, "Trying the provider again.");
});

contractTest("web.hermetic", "live reasoning keeps a deterministic 64 KiB rendered tail", () => {
  const state = applyProviderReasoning(
    null,
    reasoningUpdate({ delta: "a".repeat(MAX_LIVE_REASONING_BYTES * 2) }),
  );
  assert.ok(state?.reasoning);
  const displayed = displayLiveReasoning(state.reasoning);
  const noticeBytes = new TextEncoder().encode(
    LIVE_REASONING_TRUNCATION_NOTICE,
  ).byteLength;

  assert.equal(displayed.startsWith(LIVE_REASONING_TRUNCATION_NOTICE), true);
  assert.equal(
    new TextEncoder().encode(state.reasoning.text).byteLength,
    MAX_LIVE_REASONING_BYTES,
  );
  assert.equal(
    new TextEncoder().encode(displayed).byteLength,
    MAX_LIVE_REASONING_BYTES + noticeBytes,
  );
});

contractTest("web.hermetic", "a new assistant response discards the previous response presentation", () => {
  const previous = applyProviderReasoning(null, reasoningUpdate());
  const next = applyLiveProgress(previous, {
    id: "progress-next",
    assistantMessageId: "assistant-2",
    runId: "run-2",
    sequence: 1,
    timestamp: "2026-07-24T12:01:00.000Z",
    source: "runtime",
    phase: "chat",
    code: "MODEL_ATTEMPT_STARTED",
    text: "Provider attempt 1/3 started.",
    severity: "info",
    persist: false,
  });

  assert.equal(next?.assistantMessageId, "assistant-2");
  assert.equal(next?.reasoning, null);
});

contractTest("web.hermetic", "finishing clears waiting status but keeps completed reasoning", () => {
  const withProgress = applyLiveProgress(null, {
    id: "progress-1",
    assistantMessageId: "assistant-1",
    timestamp: "2026-07-24T12:00:00.000Z",
    source: "runtime",
    phase: "chat",
    code: "RUN_STILL_ACTIVE",
    text: "Still working on model response...",
    severity: "info",
    persist: false,
  });
  const withReasoning = applyProviderReasoning(withProgress, reasoningUpdate());
  const finished = finishLiveRuntimePresentation(withReasoning);

  assert.equal(finished?.activityStatus, null);
  assert.equal(finished?.reasoning?.isStreaming, false);
  assert.equal(finished?.reasoning?.text, "Inspecting the workspace.");
});
