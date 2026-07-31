import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLiveProgress,
  applyProviderReasoning,
  isKestrelActivityDetailPart,
  selectLiveRuntimePresentationForAssistant,
} from "./live-runtime-presentation";

test(
  "provider reasoning selects the reasoning card and is excluded from Activity details",
  () => {
    const withProgress = applyLiveProgress(null, {
      id: "progress-1",
      assistantMessageId: "assistant-1",
      runId: "run-1",
      sequence: 1,
      timestamp: "2026-07-24T12:00:00.000Z",
      source: "runtime",
      phase: "chat",
      code: "MODEL_ATTEMPT_STARTED",
      text: "Provider attempt 1/2 started.",
      severity: "info",
      persist: false,
    });
    const state = applyProviderReasoning(withProgress, {
      id: "reasoning-1",
      assistantMessageId: "assistant-1",
      runId: "run-1",
      sequence: 2,
      timestamp: "2026-07-24T12:00:00.001Z",
      attempt: 1,
      format: "summary",
      label: "Provider reasoning summary",
      event: "delta",
      contentState: "live",
      delta: "Inspecting the workspace.",
    });
    const selected = selectLiveRuntimePresentationForAssistant(
      state,
      "assistant-1",
    );

    assert.equal(selected.reasoning?.text, "Inspecting the workspace.");
    assert.deepEqual(
      selected.activityStatuses.map((status) => status.text),
      ["Provider attempt 1/2 started."],
    );
    assert.equal(
      isKestrelActivityDetailPart({
        type: "data-kestrel-provider-reasoning",
      }),
      false,
    );
    assert.equal(
      isKestrelActivityDetailPart({ type: "data-kestrel-progress" }),
      true,
    );
    assert.deepEqual(
      selectLiveRuntimePresentationForAssistant(state, "assistant-2"),
      {
        activityStatuses: [],
        reasoning: null,
      },
    );
  },
);
