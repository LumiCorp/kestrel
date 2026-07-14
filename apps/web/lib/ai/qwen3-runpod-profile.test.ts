import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQwen3RunPodProfile,
  QWEN3_8B_RUNPOD_IMAGE,
} from "./qwen3-runpod-profile";

test("Qwen3 bootstrap is immutable, scale-to-zero, and cost bounded", () => {
  const profile = buildQwen3RunPodProfile(
    `runpod/worker-v1-vllm@sha256:${"a".repeat(64)}`
  );
  assert.equal(profile.expectedModelId, "Qwen/Qwen3-8B");
  assert.equal(profile.templateSpec.env.ENABLE_AUTO_TOOL_CHOICE, "true");
  assert.equal(profile.templateSpec.env.TOOL_CALL_PARSER, "hermes");
  assert.equal(
    profile.templateSpec.env.OPENAI_SERVED_MODEL_NAME_OVERRIDE,
    "Qwen/Qwen3-8B"
  );
  assert.equal(profile.endpointSpec.workersMin, 0);
  assert.equal(profile.endpointSpec.workersMax, 1);
  assert.deepEqual(profile.endpointSpec.gpuTypeIds, ["NVIDIA L40S"]);
  assert.equal(profile.endpointSpec.minCudaVersion, "13.0");
  assert.equal(profile.costLimitUsdPerHour, 2);
  assert.equal(
    QWEN3_8B_RUNPOD_IMAGE,
    "runpod/worker-v1-vllm@sha256:170002e256ac82cb54740086aa57927f12ef6f1572ee45c1e79d6f3e4b16072e"
  );
});
