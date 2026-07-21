import assert from "node:assert/strict";
import {
  RunPodControlPlaneClient,
  RunPodControlPlaneError,
} from "./runpod-control-plane";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "control-plane client creates private serverless resources with bearer auth", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new RunPodControlPlaneClient({
    apiKey: "runpod-secret",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/templates")) {
        return Response.json({
          id: "template-1",
          name: "kestrel-deployment-1",
          imageName: `registry.example/model@sha256:${"a".repeat(64)}`,
          isServerless: true,
        });
      }
      return Response.json({
        id: "endpoint-1",
        name: "kestrel-deployment-1",
        templateId: "template-1",
        workersMin: 0,
        workersMax: 1,
      });
    },
  });

  await client.createTemplate({
    name: "kestrel-deployment-1",
    imageRef: `registry.example/model@sha256:${"a".repeat(64)}`,
    spec: {
      containerDiskInGb: 50,
      containerRegistryAuthId: null,
      dockerEntrypoint: [],
      dockerStartCmd: [],
      env: {},
      secretEnv: { HF_TOKEN: "huggingface_token" },
      ports: [],
      volumeInGb: 0,
      volumeMountPath: "/workspace",
    },
  });
  await client.createEndpoint({
    name: "kestrel-deployment-1",
    templateId: "template-1",
    spec: {
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
  });

  assert.equal(
    new Headers(requests[0]?.init?.headers).get("authorization"),
    "Bearer runpod-secret"
  );
  const templateBody = JSON.parse(String(requests[0]?.init?.body));
  assert.equal(templateBody.isPublic, false);
  assert.equal(templateBody.isServerless, true);
  assert.equal(
    templateBody.env.HF_TOKEN,
    "{{ RUNPOD_SECRET_huggingface_token }}"
  );
  const endpointBody = JSON.parse(String(requests[1]?.init?.body));
  assert.equal(endpointBody.templateId, "template-1");
  assert.deepEqual(endpointBody.gpuTypeIds, ["NVIDIA L40S"]);
});

contractTest("web.hermetic", "control-plane deletion is idempotent when a resource is already absent", async () => {
  const client = new RunPodControlPlaneClient({
    apiKey: "runpod-secret",
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  await assert.doesNotReject(client.deleteEndpoint("missing-endpoint"));
  await assert.doesNotReject(client.deleteTemplate("missing-template"));
});

contractTest("web.hermetic", "control-plane errors expose stable retry policy without response secrets", async () => {
  const client = new RunPodControlPlaneClient({
    apiKey: "runpod-secret",
    fetchImpl: async () =>
      Response.json(
        { error: "provider leaked runpod-secret" },
        { status: 503 }
      ),
  });
  await assert.rejects(client.listEndpoints(), (error: unknown) => {
    assert.ok(error instanceof RunPodControlPlaneError);
    assert.equal(error.code, "RUNPOD_CONTROL_PLANE_HTTP_503");
    assert.equal(error.retryable, true);
    assert.equal(String(error).includes("runpod-secret"), false);
    return true;
  });
});

contractTest("web.hermetic", "control-plane billing requests use hourly endpoint attribution", async () => {
  let requestedUrl = "";
  const client = new RunPodControlPlaneClient({
    apiKey: "runpod-secret",
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json([
        {
          amount: 1.25,
          diskSpaceBilledGb: 50,
          endpointId: "endpoint-1",
          gpuTypeId: "NVIDIA L40S",
          time: "2026-07-12T12:00:00.000Z",
          timeBilledMs: 3_600_000,
        },
      ]);
    },
  });
  const rows = await client.listBilling({
    startTime: new Date("2026-07-12T12:00:00.000Z"),
    endTime: new Date("2026-07-12T13:00:00.000Z"),
  });
  assert.match(requestedUrl, /\/billing\/endpoints\?/u);
  assert.match(requestedUrl, /bucketSize=hour/u);
  assert.equal(rows[0]?.endpointId, "endpoint-1");
});

contractTest("web.hermetic", "control-plane billing normalizes RunPod's timezone-free UTC buckets", async () => {
  const client = new RunPodControlPlaneClient({
    apiKey: "runpod-secret",
    fetchImpl: async () =>
      Response.json([
        {
          amount: 1.25,
          diskSpaceBilledGb: 50,
          endpointId: "endpoint-1",
          gpuTypeId: "NVIDIA L40S",
          time: "2026-07-12 12:00:00",
          timeBilledMs: 3_600_000,
        },
      ]),
  });

  const rows = await client.listBilling({
    startTime: new Date("2026-07-12T12:00:00.000Z"),
    endTime: new Date("2026-07-12T13:00:00.000Z"),
  });

  assert.equal(rows[0]?.time, "2026-07-12T12:00:00.000Z");
});
