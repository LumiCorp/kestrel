import assert from "node:assert/strict";
import test from "node:test";
import type {
  EnvironmentProviderInventory,
  EnvironmentProviderMachine,
} from "./providers/contracts";
import {
  assessWorkspaceVolumeBinding,
  mountedVolumeIdsFromInventory,
  selectOrphanVolumeIds,
} from "./reconcile-contract";

const workspaceId = "87408a50-5dc3-448a-b099-aada6811996a";
const expectedVolumeName = "ws_87408a505dc3448ab099";

function machine(
  overrides: Partial<EnvironmentProviderMachine> = {}
): EnvironmentProviderMachine {
  return {
    id: "machine-1",
    state: "started",
    region: "iad",
    workspaceId,
    mounts: [
      {
        volumeId: "volume-new",
        name: expectedVolumeName,
        path: "/workspace",
      },
    ],
    ...overrides,
  };
}

function inventory(
  overrides: Partial<EnvironmentProviderInventory> = {}
): EnvironmentProviderInventory {
  return {
    machines: [
      {
        id: "machine-1",
        workspaceId,
        replacementId: null,
        mountedVolumeIds: ["volume-new"],
      },
    ],
    volumes: [
      {
        id: "volume-new",
        name: expectedVolumeName,
        region: "iad",
        attachedMachineId: "machine-1",
      },
    ],
    ...overrides,
  };
}

test("Workspace reconciliation accepts an unchanged exact Volume binding", () => {
  assert.deepEqual(
    assessWorkspaceVolumeBinding({
      workspaceId,
      environmentRegion: "iad",
      expectedVolumeName,
      recordedVolumeId: "volume-new",
      machine: machine(),
      inventory: inventory(),
    }),
    { status: "matched", volumeId: "volume-new" }
  );
});

test("Workspace reconciliation adopts an exact replacement Volume", () => {
  assert.deepEqual(
    assessWorkspaceVolumeBinding({
      workspaceId,
      environmentRegion: "iad",
      expectedVolumeName,
      recordedVolumeId: "volume-missing",
      machine: machine(),
      inventory: inventory(),
    }),
    {
      status: "adopt",
      oldVolumeId: "volume-missing",
      newVolumeId: "volume-new",
    }
  );
});

const ambiguousCases: Array<{
  name: string;
  machine: EnvironmentProviderMachine;
  inventory: EnvironmentProviderInventory;
}> = [
  {
    name: "missing mount",
    machine: machine({ mounts: [] }),
    inventory: inventory(),
  },
  {
    name: "multiple mounts",
    machine: machine({
      mounts: [
        ...(machine().mounts ?? []),
        { volumeId: "volume-other", path: "/other" },
      ],
    }),
    inventory: inventory(),
  },
  {
    name: "conflicting Workspace metadata",
    machine: machine({ workspaceId: "workspace-other" }),
    inventory: inventory(),
  },
  {
    name: "conflicting region",
    machine: machine({ region: "ord" }),
    inventory: inventory(),
  },
  {
    name: "conflicting mount name",
    machine: machine({
      mounts: [
        {
          volumeId: "volume-new",
          name: "wrong-name",
          path: "/workspace",
        },
      ],
    }),
    inventory: inventory(),
  },
  {
    name: "conflicting attachment",
    machine: machine(),
    inventory: inventory({
      volumes: [
        {
          id: "volume-new",
          name: expectedVolumeName,
          region: "iad",
          attachedMachineId: "machine-other",
        },
      ],
    }),
  },
  {
    name: "recorded Volume still exists",
    machine: machine(),
    inventory: inventory({
      volumes: [
        ...inventory().volumes,
        {
          id: "volume-missing",
          name: expectedVolumeName,
          region: "iad",
          attachedMachineId: null,
        },
      ],
    }),
  },
];

const assertAmbiguousWorkspaceReconciliation = (
  scenario: (typeof ambiguousCases)[number],
) => {
  const assessment = assessWorkspaceVolumeBinding({
    workspaceId,
    environmentRegion: "iad",
    expectedVolumeName,
    recordedVolumeId: "volume-missing",
    machine: scenario.machine,
    inventory: scenario.inventory,
  });
  assert.equal(assessment.status, "degraded");
};

test("Workspace reconciliation degrades when the recorded Machine is missing", () =>
  assertAmbiguousWorkspaceReconciliation(ambiguousCases[0]!));
test("Workspace reconciliation degrades when the recorded Volume is attached elsewhere", () =>
  assertAmbiguousWorkspaceReconciliation(ambiguousCases[1]!));
test("Workspace reconciliation degrades when the recorded Volume still exists", () =>
  assertAmbiguousWorkspaceReconciliation(ambiguousCases[2]!));

test("orphan cleanup protection includes every mounted inventory Volume", () => {
  assert.deepEqual(
    [...mountedVolumeIdsFromInventory(inventory())],
    ["volume-new"]
  );
});

test("orphan cleanup excludes mounted Volumes even when the database binding is stale", () => {
  const providerInventory = inventory({
    volumes: [
      ...inventory().volumes,
      {
        id: "volume-unmounted",
        name: "ws_unmounted",
        region: "iad",
        attachedMachineId: null,
      },
    ],
  });
  assert.deepEqual(
    selectOrphanVolumeIds({
      inventory: providerInventory,
      activeVolumeIds: new Set(["volume-stale"]),
    }),
    ["volume-unmounted"]
  );
});
