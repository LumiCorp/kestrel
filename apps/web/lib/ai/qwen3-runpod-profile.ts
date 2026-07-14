import { managedRunPodProfileInputSchema } from "./managed-runpod-contracts";

export const QWEN3_8B_RUNPOD_PROFILE_KEY = "qwen3-8b";
export const QWEN3_8B_RUNPOD_IMAGE =
  "runpod/worker-vllm@sha256:2d1b1ea50cfbf291800375956f71791bc69dd074a7531e5992d216355a817cc7";

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
      minCudaVersion: null,
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
