import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQwen3RunPodProfile,
  QWEN3_8B_RUNPOD_IMAGE,
} from "./qwen3-runpod-profile";

test("Qwen3 bootstrap is immutable, scale-to-zero, and cost bounded", () => {
  const profile = buildQwen3RunPodProfile(
    `runpod/worker-vllm@sha256:${"a".repeat(64)}`
  );
  assert.equal(profile.expectedModelId, "Qwen/Qwen3-8B");
  assert.equal(profile.templateSpec.env.ENABLE_AUTO_TOOL_CHOICE, "true");
  assert.equal(profile.templateSpec.env.TOOL_CALL_PARSER, "hermes");
  assert.equal(profile.endpointSpec.workersMin, 0);
  assert.equal(profile.endpointSpec.workersMax, 1);
  assert.deepEqual(profile.endpointSpec.gpuTypeIds, ["NVIDIA L40S"]);
  assert.equal(profile.costLimitUsdPerHour, 2);
  assert.equal(
    QWEN3_8B_RUNPOD_IMAGE,
    "runpod/worker-vllm@sha256:2d1b1ea50cfbf291800375956f71791bc69dd074a7531e5992d216355a817cc7"
  );
});
