import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeProviderEstateStates,
  summarizeProviderEnvironment,
  unavailableProviderState,
} from "./systems-map-provider-state";

const environment = {
  id: "env-1",
  appName: "kestrel-env-1",
  gatewayMachineId: "gateway-1",
  workspaces: [
    {
      id: "workspace-1",
      name: "Core",
      kind: "project" as const,
      status: "ready",
      projectId: "project-1",
      machineId: "machine-1",
      volumeId: "volume-1",
      lastHealthAt: null,
      failureMessage: null,
    },
  ],
};

test(
  "Systems map provider state exposes only Kestrel-linked resources and flags inventory drift",
  () => {
    const state = summarizeProviderEnvironment({
      environment,
      checkedAt: "2026-07-25T12:00:00.000Z",
      inventory: {
        machines: [
          { id: "gateway-1", state: "started", region: "iad", workspaceId: null, replacementId: null },
          { id: "machine-1", state: "stopped", region: "iad", workspaceId: "workspace-1", replacementId: null },
          { id: "unknown-machine", state: "started", region: "iad", workspaceId: null, replacementId: null },
        ],
        volumes: [
          { id: "volume-1", name: "Core volume", region: "iad", sizeGb: 20, attachedMachineId: "machine-1" },
          { id: "unknown-volume", name: "Unknown", region: "iad", sizeGb: 20, attachedMachineId: null },
        ],
      },
    });

    assert.equal(state.status, "live");
    assert.equal(state.lastKnownAt, "2026-07-25T12:00:00.000Z");
    assert.deepEqual(state.gateway, { id: "gateway-1", state: "started", region: "iad" });
    assert.deepEqual(state.machines, [{ id: "machine-1", state: "stopped", region: "iad" }]);
    assert.deepEqual(state.volumes.map((volume) => volume.id), ["volume-1"]);
    assert.equal(state.missingMachineCount, 0);
    assert.equal(state.missingVolumeCount, 0);
    assert.equal(state.unlinkedMachineCount, 1);
    assert.equal(state.unlinkedVolumeCount, 1);
  },
);

test(
  "Systems map keeps the last provider-confirmed state when a later refresh fails",
  () => {
    const confirmed = summarizeProviderEnvironment({
      environment,
      checkedAt: "2026-07-25T12:00:00.000Z",
      inventory: {
        machines: [
          { id: "gateway-1", state: "started", region: "iad", workspaceId: null, replacementId: null },
        ],
        volumes: [],
      },
    });
    const unavailable = unavailableProviderState({
      environment,
      checkedAt: "2026-07-25T12:05:00.000Z",
      status: "unavailable",
      message: "The provider could not be reached.",
    });

    const [state] = mergeProviderEstateStates([confirmed], [unavailable]);
    assert.equal(state.status, "unavailable");
    assert.equal(state.checkedAt, "2026-07-25T12:05:00.000Z");
    assert.equal(state.lastKnownAt, "2026-07-25T12:00:00.000Z");
    assert.deepEqual(state.gateway, { id: "gateway-1", state: "started", region: "iad" });
  },
);

test(
  "Systems map ignores an older provider response after a newer refresh completes",
  () => {
    const newer = unavailableProviderState({
      environment,
      checkedAt: "2026-07-25T12:05:00.000Z",
      status: "unavailable",
      message: "The provider could not be reached.",
    });
    const older = unavailableProviderState({
      environment,
      checkedAt: "2026-07-25T12:00:00.000Z",
      status: "not_configured",
      message: "No provider connection.",
    });

    const [state] = mergeProviderEstateStates([newer], [older]);
    assert.equal(state.status, "unavailable");
    assert.equal(state.checkedAt, "2026-07-25T12:05:00.000Z");
  },
);
