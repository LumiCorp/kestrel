import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteManagedRunPodResources,
  ensureManagedRunPodResource,
  isManagedRunPodDeletionStatus,
} from "./managed-runpod-orchestration";

test("resource creation recovers after a crash before provider ID persistence", async () => {
  const providerResources: Array<{ id: string; name: string }> = [];
  let persistedId: string | null = null;
  let persistenceAttempts = 0;
  const ensure = () =>
    ensureManagedRunPodResource({
      knownResourceId: persistedId,
      findExisting: async () =>
        providerResources.find(
          (resource) => resource.name === "kestrel-resource"
        ),
      create: async () => {
        const resource = {
          id: `resource-${providerResources.length + 1}`,
          name: "kestrel-resource",
        };
        providerResources.push(resource);
        return resource;
      },
      persistResourceId: async (resourceId) => {
        persistenceAttempts += 1;
        if (persistenceAttempts === 1) {
          throw new Error("simulated database outage");
        }
        persistedId = resourceId;
      },
    });

  await assert.rejects(ensure(), /simulated database outage/u);
  assert.equal(providerResources.length, 1);
  assert.equal(await ensure(), "resource-1");
  assert.equal(await ensure(), "resource-1");
  assert.equal(providerResources.length, 1);
});

test("resource cleanup is ordered and safe to retry after a partial failure", async () => {
  const remaining = new Set(["endpoint-1", "template-1"]);
  const events: string[] = [];
  let failTemplateOnce = true;
  const cleanup = () =>
    deleteManagedRunPodResources({
      endpointId: "endpoint-1",
      templateId: "template-1",
      deleteEndpoint: async (id) => {
        events.push(`endpoint:${id}`);
        remaining.delete(id);
      },
      deleteTemplate: async (id) => {
        events.push(`template:${id}`);
        if (failTemplateOnce) {
          failTemplateOnce = false;
          throw new Error("simulated provider outage");
        }
        remaining.delete(id);
      },
    });

  await assert.rejects(cleanup(), /simulated provider outage/u);
  assert.deepEqual([...remaining], ["template-1"]);
  await cleanup();
  assert.deepEqual([...remaining], []);
  assert.deepEqual(events, [
    "endpoint:endpoint-1",
    "template:template-1",
    "endpoint:endpoint-1",
    "template:template-1",
  ]);
});

test("missing endpoints do not turn deletion retries back into provisioning failures", () => {
  assert.equal(isManagedRunPodDeletionStatus("deleting"), true);
  assert.equal(isManagedRunPodDeletionStatus("delete_failed"), true);
  assert.equal(isManagedRunPodDeletionStatus("deleted"), true);
  assert.equal(isManagedRunPodDeletionStatus("ready"), false);
  assert.equal(isManagedRunPodDeletionStatus("failed"), false);
});
