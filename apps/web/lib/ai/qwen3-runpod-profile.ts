import { managedRunPodProfileInputSchema } from "./managed-runpod-contracts";

export const QWEN3_8B_RUNPOD_PROFILE_KEY = "qwen3-8b";
export const QWEN3_8B_RUNPOD_IMAGE =
  "runpod/worker-v1-vllm@sha256:170002e256ac82cb54740086aa57927f12ef6f1572ee45c1e79d6f3e4b16072e";

export function buildQwen3RunPodProfile(imageRef: string) {
  return managedRunPodProfileInputSchema.parse({
    profileKey: QWEN3_8B_RUNPOD_PROFILE_KEY,
    displayName: "Qwen3 8B",
    description:
      "Kestrel-qualified Qwen3 8B private inference with scale-to-zero capacity.",
    imageRef,
    expectedModelId: "Qwen/Qwen3-8B",
    templateSpec: {
      containerDiskInGb: 50,
      containerRegistryAuthId: null,
      dockerEntrypoint: [],
      dockerStartCmd: [],
      env: {
        MODEL_NAME: "Qwen/Qwen3-8B",
        ENABLE_AUTO_TOOL_CHOICE: "true",
        TOOL_CALL_PARSER: "hermes",
        OPENAI_SERVED_MODEL_NAME_OVERRIDE: "Qwen/Qwen3-8B",
        MAX_MODEL_LEN: "8192",
        GPU_MEMORY_UTILIZATION: "0.9",
      },
      secretEnv: {},
      ports: [],
      volumeInGb: 0,
      volumeMountPath: "/workspace",
    },
    endpointSpec: {
      allowedCudaVersions: [],
      dataCenterIds: [],
      executionTimeoutMs: 600_000,
      flashboot: true,
      gpuCount: 1,
      gpuTypeIds: ["NVIDIA L40S"],
      idleTimeout: 5,
      minCudaVersion: "13.0",
      networkVolumeIds: [],
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
      workersMax: 1,
      workersMin: 0,
      estimatedMaxCostUsdPerHour: 2,
    },
    costLimitUsdPerHour: 2,
  });
}
