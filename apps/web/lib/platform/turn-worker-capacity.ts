import "server-only";

import { createHash } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, min, or, sql } from "drizzle-orm";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  type FlyTurnWorkerMachine,
  FlyMachinesClient,
  type FlyMachineHealthCheck,
  sanitizeProviderDetail,
} from "@/lib/environments/providers/fly-machines";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const TURN_WORKER_APP_NAME = "kestrel-one-turn-worker";
export const TURN_WORKER_OPERATION_LEASE_MS = 15 * 60 * 1000;
const CAPACITY_ID = "default";
const ACTIVE_OPERATION_STATES = ["queued", "running"] as const;
const TURN_WORKER_HEALTH_CHECK: FlyMachineHealthCheck = {
  name: "worker",
  port: 8081,
  path: "/healthz",
  timeoutSeconds: 5,
  gracePeriodSeconds: 30,
};

export type TurnWorkerMachineRole =
  | "active"
  | "activated_standby"
  | "stopped_independent"
  | "retained_standby"
  | "transitional";

export type TurnWorkerMachineProjection = {
  id: string;
  state: string;
  region: string;
  role: TurnWorkerMachineRole;
  standbyForMachineIds: string[];
  image: string | null;
  resolvedImageDigest: string | null;
  instanceId: string | null;
  cpuKind: string | null;
  cpus: number | null;
  memoryMb: number | null;
  configuredConcurrency: number | null;
  concurrencyConfiguration: "valid" | "missing" | "invalid";
  healthStatus: string;
  workerHealthCheckConfigured: boolean;
  configurationFingerprint: string;
};

export type TurnWorkerCapacitySnapshot = {
  revision: number;
  desired: { concurrencyPerMachine: number; activeMachineCount: number };
  applied: {
    healthyActiveMachineCount: number;
    effectiveCapacity: number;
    inventoryFingerprint: string;
    drift: string[];
  };
  queue: {
    running: number;
    queued: number;
    waiting: number;
    oldestQueuedAt: string | null;
  };
  admission: { closed: boolean; expiresAt: string | null };
  operation: {
    id: string | null;
    state: string;
    stage: string | null;
    queuedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    result: unknown;
  };
  machines: TurnWorkerMachineProjection[];
};

export type CapacityErrorCode =
  | "INVALID_CAPACITY"
  | "RUNTIME_STATE_STALE"
  | "RUNTIME_OPERATION_ACTIVE"
  | "TURN_WORKERS_BUSY"
  | "TURN_WORKER_INVENTORY_DRIFT"
  | "FLY_INVENTORY_UNAVAILABLE";

export class TurnWorkerCapacityError extends Error {
  constructor(
    readonly code: CapacityErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TurnWorkerCapacityError";
  }
}

export function createPlatformTurnWorkerClient() {
  const token = process.env.FLY_API_TOKEN?.trim();
  const organizationSlug = process.env.KESTREL_FLY_ORGANIZATION_SLUG?.trim();
  if (!(token && organizationSlug)) {
    throw new TurnWorkerCapacityError(
      "FLY_INVENTORY_UNAVAILABLE",
      "Platform Fly authority is unavailable.",
    );
  }
  return new FlyMachinesClient({ token, organizationSlug });
}

function machineRole(machine: FlyTurnWorkerMachine): TurnWorkerMachineRole {
  const standby = Boolean(machine.standbyForMachineIds?.length);
  if (machine.state === "started") {
    return standby ? "activated_standby" : "active";
  }
  if (machine.state === "stopped") {
    return standby ? "retained_standby" : "stopped_independent";
  }
  return "transitional";
}

function projectMachine(machine: FlyTurnWorkerMachine): TurnWorkerMachineProjection {
  return {
    id: machine.id,
    state: machine.state,
    region: machine.region,
    role: machineRole(machine),
    standbyForMachineIds: [...(machine.standbyForMachineIds ?? [])].sort(),
    image: machine.image ?? null,
    resolvedImageDigest: machine.resolvedImageDigest ?? null,
    instanceId: machine.instanceId ?? null,
    cpuKind: machine.cpuKind ?? null,
    cpus: machine.cpus ?? null,
    memoryMb: machine.memoryMb ?? null,
    configuredConcurrency: machine.configuredConcurrency,
    concurrencyConfiguration: machine.concurrencyConfiguration,
    healthStatus: machine.healthStatus,
    workerHealthCheckConfigured: machine.workerHealthCheckConfigured,
    configurationFingerprint: machine.configurationFingerprint,
  };
}

function inventoryFingerprint(machines: TurnWorkerMachineProjection[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        machines.map((machine) => ({
          id: machine.id,
          state: machine.state,
          role: machine.role,
          standbyForMachineIds: machine.standbyForMachineIds,
          image: machine.image,
          resolvedImageDigest: machine.resolvedImageDigest,
          instanceId: machine.instanceId,
          cpuKind: machine.cpuKind,
          cpus: machine.cpus,
          memoryMb: machine.memoryMb,
          configuredConcurrency: machine.configuredConcurrency,
          healthStatus: machine.healthStatus,
          workerHealthCheckConfigured: machine.workerHealthCheckConfigured,
          configurationFingerprint: machine.configurationFingerprint,
        })),
      ),
    )
    .digest("hex");
}

async function readInventory(client = createPlatformTurnWorkerClient()) {
  try {
    const machines = (await client.listTurnWorkerMachines({
      appName: TURN_WORKER_APP_NAME,
    }))
      .map(projectMachine)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (machines.length === 0) {
      throw new TurnWorkerCapacityError(
        "TURN_WORKER_INVENTORY_DRIFT",
        "The Turn Worker app has no Machines.",
      );
    }
    return { machines, fingerprint: inventoryFingerprint(machines) };
  } catch (error) {
    if (error instanceof TurnWorkerCapacityError) throw error;
    throw new TurnWorkerCapacityError(
      "FLY_INVENTORY_UNAVAILABLE",
      "Fly Turn Worker inventory is unavailable.",
    );
  }
}

async function readQueueMetrics() {
  const rows = await knowledgeDb
    .select({
      status: schema.threadTurns.status,
      total: count(),
      oldest: min(schema.threadTurns.createdAt),
    })
    .from(schema.threadTurns)
    .where(
      inArray(schema.threadTurns.status, [
        "running",
        "queued",
        "waiting_for_input",
      ]),
    )
    .groupBy(schema.threadTurns.status);
  const byStatus = new Map(rows.map((row) => [row.status, row]));
  return {
    running: Number(byStatus.get("running")?.total ?? 0),
    queued: Number(byStatus.get("queued")?.total ?? 0),
    waiting: Number(byStatus.get("waiting_for_input")?.total ?? 0),
    oldestQueuedAt: byStatus.get("queued")?.oldest?.toISOString() ?? null,
  };
}

function driftFor(
  machines: TurnWorkerMachineProjection[],
  desired: { concurrencyPerMachine: number; activeMachineCount: number },
) {
  const drift = new Set<string>();
  const started = machines.filter((machine) => machine.state === "started");
  const activeOrdinary = started.filter((machine) => machine.role === "active");
  const standby = machines.filter(
    (machine) => machine.role === "retained_standby",
  );
  if (started.some((machine) => machine.role === "activated_standby")) {
    drift.add("failover-active");
  }
  if (activeOrdinary.length !== desired.activeMachineCount) {
    drift.add("active-machine-count");
  }
  if (
    machines.some(
      (machine) =>
        machine.concurrencyConfiguration !== "valid" ||
        machine.configuredConcurrency !== desired.concurrencyPerMachine,
    )
  ) {
    drift.add("mixed-slots");
  }
  if (standby.length !== 1) drift.add("standby-topology");
  const activeIds = activeOrdinary.map((machine) => machine.id).sort();
  if (
    standby.length === 1 &&
    JSON.stringify(standby[0]?.standbyForMachineIds ?? []) !==
      JSON.stringify(activeIds)
  ) {
    drift.add("standby-topology");
  }
  if (
    started.some(
      (machine) => !["passing", "healthy"].includes(machine.healthStatus),
    )
  ) {
    drift.add("unhealthy");
  }
  if (machines.some((machine) => machine.role === "transitional")) {
    drift.add("unhealthy");
  }
  if (
    new Set(machines.map((machine) => machine.image)).size > 1 ||
    started.some((machine) => !machine.resolvedImageDigest) ||
    new Set(started.map((machine) => machine.resolvedImageDigest)).size > 1
  ) {
    drift.add("mixed-image");
  }
  return [...drift].sort();
}

export async function getTurnWorkerCapacitySnapshot(
  client = createPlatformTurnWorkerClient(),
): Promise<TurnWorkerCapacitySnapshot> {
  const [capacity, inventory, queue] = await Promise.all([
    knowledgeDb.query.platformTurnWorkerCapacity.findFirst({
      where: eq(schema.platformTurnWorkerCapacity.id, CAPACITY_ID),
    }),
    readInventory(client),
    readQueueMetrics(),
  ]);
  if (!capacity) throw new Error("Turn Worker capacity configuration is unavailable.");
  const desired = {
    concurrencyPerMachine: capacity.concurrencyPerMachine,
    activeMachineCount: capacity.desiredActiveMachines,
  };
  const healthyStarted = inventory.machines.filter(
    (machine) =>
      machine.state === "started" &&
      ["passing", "healthy"].includes(machine.healthStatus),
  );
  const admissionClosed = Boolean(
    capacity.admissionClosedUntil &&
      capacity.admissionClosedUntil.getTime() > Date.now(),
  );
  return {
    revision: capacity.revision,
    desired,
    applied: {
      healthyActiveMachineCount: healthyStarted.length,
      effectiveCapacity: healthyStarted.reduce(
        (total, machine) => total + (machine.configuredConcurrency ?? 0),
        0,
      ),
      inventoryFingerprint: inventory.fingerprint,
      drift: driftFor(inventory.machines, desired),
    },
    queue,
    admission: {
      closed: admissionClosed,
      expiresAt: admissionClosed
        ? (capacity.admissionClosedUntil?.toISOString() ?? null)
        : null,
    },
    operation: {
      id: capacity.operationId,
      state: capacity.operationState,
      stage: capacity.operationStage,
      queuedAt: capacity.operationQueuedAt?.toISOString() ?? null,
      startedAt: capacity.operationStartedAt?.toISOString() ?? null,
      finishedAt: capacity.operationFinishedAt?.toISOString() ?? null,
      result: capacity.operationResult,
    },
    machines: inventory.machines,
  };
}

function operationIsDisruptive(input: {
  machines: TurnWorkerMachineProjection[];
  concurrencyPerMachine: number;
  activeMachineCount: number;
}) {
  const started = input.machines.filter((machine) => machine.state === "started");
  return (
    started.length > input.activeMachineCount ||
    started.some(
      (machine) =>
        machine.role === "activated_standby" ||
        !machine.workerHealthCheckConfigured ||
        machine.configuredConcurrency !== input.concurrencyPerMachine,
    )
  );
}

function assertCanonicalInventory(machines: TurnWorkerMachineProjection[]) {
  const started = machines.filter((machine) => machine.state === "started");
  if (
    machines.some((machine) => machine.role === "transitional") ||
    started.length === 0 ||
    started.some((machine) => !(machine.image && machine.resolvedImageDigest)) ||
    new Set(
      started.map((machine) =>
        JSON.stringify({
          configuration: machine.configurationFingerprint,
          imageDigest: machine.resolvedImageDigest,
        }),
      ),
    ).size > 1
  ) {
    throw new TurnWorkerCapacityError(
      "TURN_WORKER_INVENTORY_DRIFT",
      "Active Turn Worker Machines do not have one unambiguous clone configuration.",
    );
  }
}

export async function requestTurnWorkerCapacityOperation(input: {
  actorUserId: string;
  expectedRevision: number;
  expectedInventoryFingerprint: string;
  concurrencyPerMachine: number;
  activeMachineCount: number;
  client?: FlyMachinesClient;
}) {
  await interruptExpiredTurnWorkerCapacityOperation();
  if (
    !Number.isInteger(input.concurrencyPerMachine) ||
    input.concurrencyPerMachine < 1 ||
    input.concurrencyPerMachine > 64 ||
    !Number.isInteger(input.activeMachineCount) ||
    input.activeMachineCount < 1 ||
    input.activeMachineCount > 8
  ) {
    throw new TurnWorkerCapacityError(
      "INVALID_CAPACITY",
      "Turn Worker capacity is outside the supported bounds.",
    );
  }
  const inventory = await readInventory(input.client);
  assertCanonicalInventory(inventory.machines);
  const disruptive = operationIsDisruptive({
    machines: inventory.machines,
    concurrencyPerMachine: input.concurrencyPerMachine,
    activeMachineCount: input.activeMachineCount,
  });
  const operationId = crypto.randomUUID();
  const now = new Date();
  await knowledgeDb.transaction(async (tx) => {
    const [capacity] = await tx
      .select()
      .from(schema.platformTurnWorkerCapacity)
      .where(eq(schema.platformTurnWorkerCapacity.id, CAPACITY_ID))
      .limit(1)
      .for("update");
    if (!capacity) throw new Error("Turn Worker capacity configuration is unavailable.");
    if (
      ACTIVE_OPERATION_STATES.includes(
        capacity.operationState as (typeof ACTIVE_OPERATION_STATES)[number],
      ) &&
      capacity.operationLeaseUntil &&
      capacity.operationLeaseUntil.getTime() > now.getTime()
    ) {
      throw new TurnWorkerCapacityError(
        "RUNTIME_OPERATION_ACTIVE",
        "Another Turn Worker operation is already active.",
      );
    }
    if (
      capacity.revision !== input.expectedRevision ||
      inventory.fingerprint !== input.expectedInventoryFingerprint
    ) {
      throw new TurnWorkerCapacityError(
        "RUNTIME_STATE_STALE",
        "Turn Worker state changed. Refresh and try again.",
      );
    }
    if (disruptive) {
      const [running] = await tx
        .select({ total: count() })
        .from(schema.threadTurns)
        .where(eq(schema.threadTurns.status, "running"));
      const runningCount = Number(running?.total ?? 0);
      if (runningCount > 0) {
        throw new TurnWorkerCapacityError(
          "TURN_WORKERS_BUSY",
          "Capacity changes that restart or stop Machines require zero running turns.",
          { runningCount },
        );
      }
    }
    await tx
      .update(schema.platformTurnWorkerCapacity)
      .set({
        concurrencyPerMachine: input.concurrencyPerMachine,
        desiredActiveMachines: input.activeMachineCount,
        revision: capacity.revision + 1,
        operationId,
        operationState: "queued",
        operationStage: "queued",
        operationInventoryFingerprint: inventory.fingerprint,
        operationActorUserId: input.actorUserId,
        operationResult: { disruptive },
        operationQueuedAt: now,
        operationStartedAt: null,
        operationFinishedAt: null,
        operationLeaseUntil: new Date(
          now.getTime() + TURN_WORKER_OPERATION_LEASE_MS,
        ),
        admissionClosedUntil: disruptive
          ? new Date(now.getTime() + TURN_WORKER_OPERATION_LEASE_MS)
          : null,
        updatedAt: now,
      })
      .where(eq(schema.platformTurnWorkerCapacity.id, CAPACITY_ID));
  });
  await logAdminEvent({
    actorUserId: input.actorUserId,
    category: "turn-worker-capacity",
    action: "accepted",
    targetType: "platform_turn_worker_capacity",
    targetId: operationId,
    message: "Requested a Turn Worker capacity change.",
    metadata: {
      concurrencyPerMachine: input.concurrencyPerMachine,
      activeMachineCount: input.activeMachineCount,
      disruptive,
    },
  }).catch(() => {});
  return { operationId };
}

async function renewOperationLease(
  operationId: string,
  stage: string,
  disruptive: boolean,
) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + TURN_WORKER_OPERATION_LEASE_MS);
  const [updated] = await knowledgeDb
    .update(schema.platformTurnWorkerCapacity)
    .set({
      operationStage: stage,
      operationLeaseUntil: leaseUntil,
      ...(disruptive ? { admissionClosedUntil: leaseUntil } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.platformTurnWorkerCapacity.id, CAPACITY_ID),
        eq(schema.platformTurnWorkerCapacity.operationId, operationId),
        eq(schema.platformTurnWorkerCapacity.operationState, "running"),
        gt(schema.platformTurnWorkerCapacity.operationLeaseUntil, now),
        ...(disruptive
          ? [gt(schema.platformTurnWorkerCapacity.admissionClosedUntil, now)]
          : []),
      ),
    )
    .returning({ id: schema.platformTurnWorkerCapacity.id });
  if (!updated) {
    await interruptExpiredTurnWorkerCapacityOperation();
    throw new TurnWorkerCapacityError(
      "RUNTIME_OPERATION_ACTIVE",
      "The Turn Worker operation lease is no longer owned by this worker.",
    );
  }
}

async function setOperationStage(
  operationId: string,
  stage: string,
  disruptive: boolean,
) {
  return renewOperationLease(operationId, stage, disruptive);
}

async function updateMachine(
  client: FlyMachinesClient,
  operationId: string,
  disruptive: boolean,
  machine: TurnWorkerMachineProjection,
  input: {
    concurrency: number;
    standbyForMachineIds: string[];
    runtimeImage?: string;
  },
) {
  await setOperationStage(operationId, `updating:${machine.id}`, disruptive);
  const runtimeImage = input.runtimeImage ?? machine.image;
  if (!runtimeImage) {
    throw new TurnWorkerCapacityError(
      "TURN_WORKER_INVENTORY_DRIFT",
      `Machine ${machine.id} has no cloneable image.`,
    );
  }
  await client.updateMachineImage({
    appName: TURN_WORKER_APP_NAME,
    machineId: machine.id,
    runtimeImage,
    envPatch: {
      KESTREL_TURN_WORKER_CONCURRENCY: String(input.concurrency),
    },
    standbyForMachineIds: input.standbyForMachineIds,
    healthCheck: TURN_WORKER_HEALTH_CHECK,
  });
  if (machine.state === "started") {
    await setOperationStage(
      operationId,
      `waiting-for-start:${machine.id}`,
      disruptive,
    );
    await client.waitForMachine({
      appName: TURN_WORKER_APP_NAME,
      machineId: machine.id,
      state: "started",
    });
    await setOperationStage(
      operationId,
      `waiting-for-health:${machine.id}`,
      disruptive,
    );
    await client.waitForMachineHealth({
      appName: TURN_WORKER_APP_NAME,
      machineId: machine.id,
      checkName: TURN_WORKER_HEALTH_CHECK.name,
    });
  }
}

async function convergeCapacity(input: {
  operationId: string;
  concurrency: number;
  activeCount: number;
  disruptive: boolean;
  client: FlyMachinesClient;
  initialInventory: Awaited<ReturnType<typeof readInventory>>;
}) {
  let inventory = input.initialInventory;
  assertCanonicalInventory(inventory.machines);
  const started = inventory.machines.filter(
    (machine) => machine.state === "started",
  );
  for (const machine of started.filter(
    (candidate) => candidate.role === "activated_standby",
  )) {
    await updateMachine(input.client, input.operationId, input.disruptive, machine, {
      concurrency: input.concurrency,
      standbyForMachineIds: [],
    });
  }
  inventory = await readInventory(input.client);
  assertCanonicalInventory(inventory.machines);
  let active = inventory.machines
    .filter((machine) => machine.state === "started" && machine.role === "active")
    .sort((left, right) => left.id.localeCompare(right.id));
  const canonical = active[0] ?? inventory.machines.find((machine) => machine.image);
  if (!canonical?.image) {
    throw new TurnWorkerCapacityError(
      "TURN_WORKER_INVENTORY_DRIFT",
      "No canonical Turn Worker Machine is available.",
    );
  }
  if (active.length > input.activeCount) {
    const excess = active.slice(input.activeCount).sort((left, right) =>
      right.id.localeCompare(left.id),
    );
    for (const machine of excess) {
      await setOperationStage(input.operationId, `stopping:${machine.id}`, true);
      await input.client.stopMachine({
        appName: TURN_WORKER_APP_NAME,
        machineId: machine.id,
      });
      await setOperationStage(
        input.operationId,
        `waiting-for-stop:${machine.id}`,
        true,
      );
      await input.client.waitForMachine({
        appName: TURN_WORKER_APP_NAME,
        machineId: machine.id,
        state: "stopped",
      });
    }
  }
  inventory = await readInventory(input.client);
  assertCanonicalInventory(inventory.machines);
  active = inventory.machines
    .filter((machine) => machine.state === "started" && machine.role === "active")
    .sort((left, right) => left.id.localeCompare(right.id));
  const retainedStandbyIds = new Set(
    inventory.machines
      .filter((machine) => machine.role === "retained_standby")
      .map((machine) => machine.id),
  );
  const available = inventory.machines
    .filter(
      (machine) =>
        machine.state === "stopped" &&
        machine.role === "stopped_independent" &&
        machine.configurationFingerprint ===
          canonical.configurationFingerprint &&
        !retainedStandbyIds.has(machine.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  while (active.length < input.activeCount) {
    let next = available.shift();
    if (next) {
      await updateMachine(input.client, input.operationId, input.disruptive, next, {
        concurrency: input.concurrency,
        runtimeImage: canonical.image,
        standbyForMachineIds: [],
      });
    } else {
      await setOperationStage(input.operationId, "cloning-active", input.disruptive);
      const cloned = await input.client.cloneMachineAsStoppedIndependent({
        appName: TURN_WORKER_APP_NAME,
        machineId: canonical.id,
        runtimeImage: canonical.image,
        concurrency: input.concurrency,
        healthCheck: TURN_WORKER_HEALTH_CHECK,
      });
      next = {
        ...projectMachine({
          ...cloned,
          configuredConcurrency: input.concurrency,
          concurrencyConfiguration: "valid",
          healthStatus: "stopped",
          workerHealthCheckConfigured: true,
          configurationFingerprint: canonical.configurationFingerprint,
        }),
      };
    }
    await setOperationStage(input.operationId, `starting:${next.id}`, input.disruptive);
    await input.client.startMachine({
      appName: TURN_WORKER_APP_NAME,
      machineId: next.id,
    });
    await setOperationStage(
      input.operationId,
      `waiting-for-start:${next.id}`,
      input.disruptive,
    );
    await input.client.waitForMachine({
      appName: TURN_WORKER_APP_NAME,
      machineId: next.id,
      state: "started",
    });
    await setOperationStage(
      input.operationId,
      `waiting-for-health:${next.id}`,
      input.disruptive,
    );
    await input.client.waitForMachineHealth({
      appName: TURN_WORKER_APP_NAME,
      machineId: next.id,
      checkName: TURN_WORKER_HEALTH_CHECK.name,
    });
    active.push(next);
    active.sort((left, right) => left.id.localeCompare(right.id));
  }
  inventory = await readInventory(input.client);
  assertCanonicalInventory(inventory.machines);
  active = inventory.machines
    .filter((machine) => machine.state === "started" && machine.role === "active")
    .sort((left, right) => left.id.localeCompare(right.id));
  const activeIds = active.map((machine) => machine.id);
  let standby = inventory.machines
    .filter((machine) => machine.role === "retained_standby")
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!standby) {
    standby = inventory.machines
      .filter(
        (machine) =>
          machine.state === "stopped" && machine.role === "stopped_independent",
      )
      .sort((left, right) => left.id.localeCompare(right.id))[0];
  }
  if (standby) {
    await updateMachine(input.client, input.operationId, input.disruptive, standby, {
      concurrency: input.concurrency,
      runtimeImage: canonical.image,
      standbyForMachineIds: activeIds,
    });
  } else {
    await setOperationStage(input.operationId, "cloning-standby", input.disruptive);
    const cloned = await input.client.cloneMachineAsStoppedStandby({
      appName: TURN_WORKER_APP_NAME,
      machineId: active[0]?.id ?? canonical.id,
      runtimeImage: active[0]?.image ?? canonical.image,
      concurrency: input.concurrency,
      standbyForMachineIds: activeIds,
      healthCheck: TURN_WORKER_HEALTH_CHECK,
    });
    standby = projectMachine({
      ...cloned,
      configuredConcurrency: input.concurrency,
      concurrencyConfiguration: "valid",
      healthStatus: "stopped",
      workerHealthCheckConfigured: true,
      configurationFingerprint: canonical.configurationFingerprint,
    });
  }
  inventory = await readInventory(input.client);
  assertCanonicalInventory(inventory.machines);
  for (const machine of inventory.machines) {
    const desiredStandbys =
      machine.id === standby.id ? activeIds : [];
    if (
      machine.image !== canonical.image ||
      !machine.workerHealthCheckConfigured ||
      machine.configuredConcurrency !== input.concurrency ||
      JSON.stringify(machine.standbyForMachineIds) !==
        JSON.stringify(desiredStandbys)
    ) {
      await updateMachine(input.client, input.operationId, input.disruptive, machine, {
        concurrency: input.concurrency,
        runtimeImage: canonical.image,
        standbyForMachineIds: desiredStandbys,
      });
    }
  }
  const finalInventory = await readInventory(input.client);
  assertCanonicalInventory(finalInventory.machines);
  const finalDrift = driftFor(finalInventory.machines, {
    concurrencyPerMachine: input.concurrency,
    activeMachineCount: input.activeCount,
  });
  if (finalDrift.length > 0) {
    throw new TurnWorkerCapacityError(
      "TURN_WORKER_INVENTORY_DRIFT",
      `Turn Worker inventory still has drift: ${finalDrift.join(", ")}.`,
    );
  }
  return finalInventory;
}

export async function processTurnWorkerCapacityOperation(
  operationId: string,
  client = createPlatformTurnWorkerClient(),
) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + TURN_WORKER_OPERATION_LEASE_MS);
  const [operation] = await knowledgeDb
    .update(schema.platformTurnWorkerCapacity)
    .set({
      operationState: "running",
      operationStage: "inventory",
      operationStartedAt: now,
      operationLeaseUntil: leaseUntil,
      admissionClosedUntil: sql`CASE
        WHEN ${schema.platformTurnWorkerCapacity.admissionClosedUntil} IS NULL THEN NULL
        ELSE ${leaseUntil}
      END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.platformTurnWorkerCapacity.id, CAPACITY_ID),
        eq(schema.platformTurnWorkerCapacity.operationId, operationId),
        inArray(schema.platformTurnWorkerCapacity.operationState, ["queued", "running"]),
        gt(schema.platformTurnWorkerCapacity.operationLeaseUntil, now),
        or(
          isNull(schema.platformTurnWorkerCapacity.admissionClosedUntil),
          gt(schema.platformTurnWorkerCapacity.admissionClosedUntil, now),
        ),
      ),
    )
    .returning();
  if (!operation) {
    await interruptExpiredTurnWorkerCapacityOperation();
    return "not_claimed" as const;
  }
  const operationResult = operation.operationResult as Record<string, unknown> | null;
  const disruptive = operationResult?.disruptive === true;
  try {
    const acceptedInventory = await readInventory(client);
    if (
      !operation.operationInventoryFingerprint ||
      acceptedInventory.fingerprint !== operation.operationInventoryFingerprint
    ) {
      throw new TurnWorkerCapacityError(
        "RUNTIME_STATE_STALE",
        "Turn Worker inventory changed after this operation was accepted.",
      );
    }
    await setOperationStage(operationId, "inventory-validated", disruptive);
    const inventory = await convergeCapacity({
      operationId,
      concurrency: operation.concurrencyPerMachine,
      activeCount: operation.desiredActiveMachines,
      disruptive,
      client,
      initialInventory: acceptedInventory,
    });
    const finishedAt = new Date();
    const [completed] = await knowledgeDb
      .update(schema.platformTurnWorkerCapacity)
      .set({
        operationState: "succeeded",
        operationStage: "complete",
        operationResult: {
          disruptive,
          inventoryFingerprint: inventory.fingerprint,
        },
        operationFinishedAt: finishedAt,
        operationLeaseUntil: null,
        admissionClosedUntil: null,
        updatedAt: finishedAt,
      })
      .where(
        and(
          eq(schema.platformTurnWorkerCapacity.operationId, operationId),
          eq(schema.platformTurnWorkerCapacity.operationState, "running"),
        ),
      )
      .returning({ id: schema.platformTurnWorkerCapacity.id });
    if (!completed) return "interrupted" as const;
    await logAdminEvent({
      actorUserId: operation.operationActorUserId,
      category: "turn-worker-capacity",
      action: "succeeded",
      targetType: "platform_turn_worker_capacity",
      targetId: operationId,
      message: "Applied the requested Turn Worker capacity.",
      metadata: { inventoryFingerprint: inventory.fingerprint },
    }).catch(() => {});
    return "succeeded" as const;
  } catch (error) {
    const finishedAt = new Date();
    const sanitizedMessage =
      sanitizeProviderDetail(
        error instanceof Error
          ? error.message
          : "Turn Worker operation failed.",
      ) ?? "Turn Worker operation failed.";
    const current =
      await knowledgeDb.query.platformTurnWorkerCapacity.findFirst({
        where: and(
          eq(schema.platformTurnWorkerCapacity.id, CAPACITY_ID),
          eq(schema.platformTurnWorkerCapacity.operationId, operationId),
        ),
        columns: { operationStage: true },
      });
    const partiallyApplied = Boolean(
      current?.operationStage &&
        !["inventory", "inventory-validated", "queued"].includes(
          current.operationStage,
        ),
    );
    const [failed] = await knowledgeDb
      .update(schema.platformTurnWorkerCapacity)
      .set({
        operationState: "failed",
        operationStage: "failed",
        operationResult: {
          disruptive,
          partiallyApplied,
          code:
            error instanceof TurnWorkerCapacityError
              ? error.code
              : "FLY_INVENTORY_UNAVAILABLE",
          message:
            sanitizedMessage,
        },
        operationFinishedAt: finishedAt,
        operationLeaseUntil: null,
        admissionClosedUntil: null,
        updatedAt: finishedAt,
      })
      .where(
        and(
          eq(schema.platformTurnWorkerCapacity.operationId, operationId),
          eq(schema.platformTurnWorkerCapacity.operationState, "running"),
        ),
      )
      .returning({ id: schema.platformTurnWorkerCapacity.id });
    if (!failed) return "interrupted" as const;
    await logAdminEvent({
      actorUserId: operation.operationActorUserId,
      level: "error",
      category: "turn-worker-capacity",
      action: "failed",
      targetType: "platform_turn_worker_capacity",
      targetId: operationId,
      message: "Turn Worker capacity was only partially applied or failed.",
    }).catch(() => {});
    if (partiallyApplied) {
      await logAdminEvent({
        actorUserId: operation.operationActorUserId,
        level: "warn",
        category: "turn-worker-capacity",
        action: "partially-applied",
        targetType: "platform_turn_worker_capacity",
        targetId: operationId,
        message: "Fly applied part of the requested Turn Worker capacity before failure.",
      }).catch(() => {});
    }
    return "failed" as const;
  }
}

export async function interruptExpiredTurnWorkerCapacityOperation() {
  const now = new Date();
  const interrupted = await knowledgeDb
    .update(schema.platformTurnWorkerCapacity)
    .set({
      operationState: "interrupted",
      operationStage: "lease-expired",
      operationFinishedAt: now,
      operationLeaseUntil: null,
      admissionClosedUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.platformTurnWorkerCapacity.id, CAPACITY_ID),
        inArray(schema.platformTurnWorkerCapacity.operationState, [
          "queued",
          "running",
        ]),
        or(
          isNull(schema.platformTurnWorkerCapacity.operationLeaseUntil),
          sql`${schema.platformTurnWorkerCapacity.operationLeaseUntil} <= now()`,
        ),
      ),
    )
    .returning({
      operationId: schema.platformTurnWorkerCapacity.operationId,
      actorUserId: schema.platformTurnWorkerCapacity.operationActorUserId,
    });
  for (const operation of interrupted) {
    await logAdminEvent({
      actorUserId: operation.actorUserId,
      level: "warn",
      category: "turn-worker-capacity",
      action: "interrupted",
      targetType: "platform_turn_worker_capacity",
      targetId: operation.operationId,
      message: "Turn Worker capacity operation ownership expired.",
    }).catch(() => {});
  }
}

export async function failQueuedTurnWorkerCapacityOperation(
  operationId: string,
  message: string,
) {
  const now = new Date();
  const sanitizedMessage =
    sanitizeProviderDetail(message) ?? "Capacity queue unavailable.";
  await knowledgeDb
    .update(schema.platformTurnWorkerCapacity)
    .set({
      operationState: "failed",
      operationStage: "queue-failed",
      operationResult: {
        code: "QUEUE_UNAVAILABLE",
        message: sanitizedMessage,
      },
      operationFinishedAt: now,
      operationLeaseUntil: null,
      admissionClosedUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.platformTurnWorkerCapacity.operationId, operationId),
        eq(schema.platformTurnWorkerCapacity.operationState, "queued"),
      ),
    );
}
