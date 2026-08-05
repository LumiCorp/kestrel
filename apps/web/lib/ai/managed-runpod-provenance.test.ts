import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagedRunPodProvenanceError,
  parseManagedRunPodRunMetadata,
  requireManagedRunPodCleanupConnectionId,
} from "./managed-runpod-provenance";

test("managed RunPod run metadata carries a validated provider connection", () => {
  assert.deepEqual(
    parseManagedRunPodRunMetadata({ providerConnectionId: "connection-1" }),
    { providerConnectionId: "connection-1" },
  );
  assert.deepEqual(parseManagedRunPodRunMetadata(null), {});
  assert.throws(
    () => parseManagedRunPodRunMetadata({ providerConnectionId: "" }),
    /metadata is invalid/u,
  );
});

test("provider resources are never cleaned up without recorded provenance", () => {
  assert.equal(
    requireManagedRunPodCleanupConnectionId({
      providerConnectionId: "connection-1",
      endpointId: "endpoint-1",
      templateId: null,
    }),
    "connection-1",
  );
  assert.equal(
    requireManagedRunPodCleanupConnectionId({
      providerConnectionId: null,
      endpointId: null,
      templateId: null,
    }),
    null,
  );
  assert.throws(
    () =>
      requireManagedRunPodCleanupConnectionId({
        providerConnectionId: null,
        endpointId: "endpoint-1",
        templateId: null,
      }),
    (error) =>
      error instanceof ManagedRunPodProvenanceError &&
      error.code === "MANAGED_RUNPOD_RESOURCE_PROVENANCE_MISSING",
  );
});
