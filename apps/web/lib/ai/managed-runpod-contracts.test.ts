import assert from "node:assert/strict";
import {
  getManagedRunPodResourceName,
  hashManagedRunPodProfile,
  managedRunPodProfileInputSchema,
  parseManagedRunPodSpecSnapshot,
  sanitizeManagedRunPodSpecSnapshot,
} from "./managed-runpod-contracts";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const digest = `registry.example/kestrel/model@sha256:${"a".repeat(64)}`;

function profileInput() {
  return {
    profileKey: "qwen-32b",
    displayName: "Qwen 32B",
    description: null,
    imageRef: digest,
    expectedModelId: "Qwen/Qwen3-32B",
    templateSpec: {
      env: { MODEL_NAME: "Qwen/Qwen3-32B" },
      secretEnv: { HF_TOKEN: "huggingface_token" },
    },
    endpointSpec: {
      gpuTypeIds: ["NVIDIA L40S"],
      estimatedMaxCostUsdPerHour: 1.5,
    },
    costLimitUsdPerHour: 2,
  };
}

contractTest("web.hermetic", "managed profiles require immutable image digests and apply bounded defaults", () => {
  const parsed = managedRunPodProfileInputSchema.parse(profileInput());
  assert.equal(parsed.imageRef, digest);
  assert.equal(parsed.templateSpec.containerDiskInGb, 50);
  assert.equal(parsed.templateSpec.secretEnv.HF_TOKEN, "huggingface_token");
  assert.equal(parsed.endpointSpec.workersMin, 0);
  assert.equal(parsed.endpointSpec.workersMax, 1);

  assert.throws(() =>
    managedRunPodProfileInputSchema.parse({
      ...profileInput(),
      imageRef: "registry.example/kestrel/model:latest",
    })
  );
});

contractTest("web.hermetic", "managed profile secrets are provider-owned references, not secret values", () => {
  assert.throws(() =>
    managedRunPodProfileInputSchema.parse({
      ...profileInput(),
      templateSpec: {
        env: { HF_TOKEN: "plaintext-secret" },
        secretEnv: { HF_TOKEN: "huggingface_token" },
      },
    })
  );
  assert.throws(() =>
    managedRunPodProfileInputSchema.parse({
      ...profileInput(),
      templateSpec: {
        secretEnv: { HF_TOKEN: "{{ secret value }}" },
      },
    })
  );
});

contractTest("web.hermetic", "managed profiles reject resource and cost settings outside platform bounds", () => {
  assert.throws(() =>
    managedRunPodProfileInputSchema.parse({
      ...profileInput(),
      endpointSpec: {
        ...profileInput().endpointSpec,
        workersMax: 11,
      },
    })
  );
  assert.throws(() =>
    managedRunPodProfileInputSchema.parse({
      ...profileInput(),
      endpointSpec: {
        ...profileInput().endpointSpec,
        estimatedMaxCostUsdPerHour: 3,
      },
    })
  );
});

contractTest("web.hermetic", "profile hashing is canonical and deployment snapshots are immutable copies", () => {
  const parsed = managedRunPodProfileInputSchema.parse(profileInput());
  const reordered = {
    ...parsed,
    templateSpec: {
      ...parsed.templateSpec,
      env: { MODEL_NAME: "Qwen/Qwen3-32B" },
    },
  };
  const specHash = hashManagedRunPodProfile(parsed);
  assert.equal(hashManagedRunPodProfile(reordered), specHash);

  const snapshot = parseManagedRunPodSpecSnapshot({
    ...parsed,
    profileId: "profile-1",
    profileVersion: 3,
    specHash,
  });
  assert.equal(snapshot.profileVersion, 3);
  assert.equal(snapshot.specHash, specHash);
  assert.equal(snapshot.endpointSpec.gpuTypeIds[0], "NVIDIA L40S");
});

contractTest("web.hermetic", "tenant deployment snapshots redact configuration and provider references", () => {
  const parsed = managedRunPodProfileInputSchema.parse({
    ...profileInput(),
    templateSpec: {
      ...profileInput().templateSpec,
      containerRegistryAuthId: "registry-auth-123",
    },
    endpointSpec: {
      ...profileInput().endpointSpec,
      networkVolumeIds: ["volume-123"],
    },
  });
  const sanitized = sanitizeManagedRunPodSpecSnapshot({
    ...parsed,
    profileId: "profile-1",
    profileVersion: 1,
    specHash: hashManagedRunPodProfile(parsed),
  });

  assert.deepEqual(sanitized.templateSpec.env, { MODEL_NAME: "configured" });
  assert.deepEqual(sanitized.templateSpec.secretEnv, {
    HF_TOKEN: "configured",
  });
  assert.equal(sanitized.templateSpec.containerRegistryAuthId, "configured");
  assert.deepEqual(sanitized.endpointSpec.networkVolumeIds, ["configured"]);
  assert.doesNotMatch(
    JSON.stringify(sanitized),
    /huggingface_token|volume-123/u
  );
});

contractTest("web.hermetic", "provider resource names are deterministic and bounded", () => {
  const first = getManagedRunPodResourceName({
    kind: "deployment",
    id: "Deployment_ABC/123",
  });
  const second = getManagedRunPodResourceName({
    kind: "deployment",
    id: "Deployment_ABC/123",
  });
  assert.equal(first, second);
  assert.equal(first, "kestrel-deployment-deployment-abc-123");
  assert.ok(first.length <= 191);
});
