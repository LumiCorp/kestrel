import type { EnvironmentProviderInventory } from "@/lib/environments/providers/contracts";

export type ProviderMapEnvironment = {
  id: string;
  appName: string | null;
  gatewayMachineId: string | null;
  workspaces: Array<{ machineId: string | null; volumeId: string | null }>;
};

export type ProviderEnvironmentState = {
  environmentId: string;
  checkedAt: string;
  lastKnownAt: string | null;
  status: "live" | "not_configured" | "unavailable";
  message: string | null;
  gateway: { id: string; state: string; region: string } | null;
  machines: Array<{ id: string; state: string; region: string }>;
  volumes: Array<{
    id: string;
    name: string;
    region: string | null;
    sizeGb: number | null;
    attachedMachineId: string | null;
  }>;
  missingMachineCount: number;
  missingVolumeCount: number;
  unlinkedMachineCount: number;
  unlinkedVolumeCount: number;
};

export function summarizeProviderEnvironment(input: {
  environment: ProviderMapEnvironment;
  inventory: EnvironmentProviderInventory;
  checkedAt: string;
}): ProviderEnvironmentState {
  const expectedMachineIds = new Set(
    [
      input.environment.gatewayMachineId,
      ...input.environment.workspaces.map((workspace) => workspace.machineId),
    ].filter((id): id is string => Boolean(id)),
  );
  const expectedVolumeIds = new Set(
    input.environment.workspaces
      .map((workspace) => workspace.volumeId)
      .filter((id): id is string => Boolean(id)),
  );
  const machineById = new Map(
    input.inventory.machines.map((machine) => [
      machine.id,
      {
        id: machine.id,
        state: machine.state ?? "unknown",
        region: machine.region ?? "unknown",
      },
    ]),
  );
  const gateway = input.environment.gatewayMachineId
    ? machineById.get(input.environment.gatewayMachineId) ?? null
    : null;

  return {
    environmentId: input.environment.id,
    checkedAt: input.checkedAt,
    lastKnownAt: input.checkedAt,
    status: "live",
    message: null,
    gateway: gateway
      ? { id: gateway.id, state: gateway.state, region: gateway.region }
      : null,
    machines: input.environment.workspaces
      .map((workspace) => workspace.machineId)
      .filter((id): id is string => Boolean(id))
      .flatMap((id) => {
        const machine = machineById.get(id);
        return machine
          ? [{ id: machine.id, state: machine.state, region: machine.region }]
          : [];
      }),
    volumes: input.inventory.volumes
      .filter((volume) => expectedVolumeIds.has(volume.id))
      .map((volume) => ({
        id: volume.id,
        name: volume.name,
        region: volume.region ?? null,
        sizeGb: volume.sizeGb ?? null,
        attachedMachineId: volume.attachedMachineId ?? null,
      })),
    missingMachineCount: [...expectedMachineIds].filter(
      (machineId) => !machineById.has(machineId),
    ).length,
    missingVolumeCount: [...expectedVolumeIds].filter(
      (volumeId) => !input.inventory.volumes.some((volume) => volume.id === volumeId),
    ).length,
    unlinkedMachineCount: input.inventory.machines.filter(
      (machine) => !expectedMachineIds.has(machine.id),
    ).length,
    unlinkedVolumeCount: input.inventory.volumes.filter(
      (volume) => !expectedVolumeIds.has(volume.id),
    ).length,
  };
}

export function unavailableProviderState(input: {
  environment: ProviderMapEnvironment;
  checkedAt: string;
  status: "not_configured" | "unavailable";
  message: string;
}): ProviderEnvironmentState {
  return {
    environmentId: input.environment.id,
    checkedAt: input.checkedAt,
    lastKnownAt: null,
    status: input.status,
    message: input.message,
    gateway: null,
    machines: [],
    volumes: [],
    missingMachineCount: 0,
    missingVolumeCount: 0,
    unlinkedMachineCount: 0,
    unlinkedVolumeCount: 0,
  };
}

export function mergeProviderEstateStates(
  current: ProviderEnvironmentState[],
  incoming: ProviderEnvironmentState[],
) {
  const states = new Map(current.map((state) => [state.environmentId, state]));
  for (const state of incoming) {
    const existing = states.get(state.environmentId);
    if (existing && state.checkedAt < existing.checkedAt) {
      continue;
    }
    if (state.status !== "live" && existing?.lastKnownAt) {
      states.set(state.environmentId, {
        ...existing,
        checkedAt: state.checkedAt,
        status: state.status,
        message: state.message,
      });
      continue;
    }
    states.set(state.environmentId, state);
  }
  return [...states.values()];
}
