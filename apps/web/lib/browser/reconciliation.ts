import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import type {
  BrowserMachineInfrastructureProvider,
  EnvironmentProviderMachine,
} from "@/lib/environments/providers/contracts";
import type { HostedBrowserResourceRecord } from "./store";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../../../src/browser/runtimeReleaseManifest.js";
import { deleteConfirmedBrowserMachine } from "./machine-cleanup";

// Opening cleanup grace, measured from durable opening creation.
// Reconciliation observes this deadline; it never extends worker acceptance.
export const HOSTED_BROWSER_OPENING_TIMEOUT_MS = 5 * 60_000;

const TERMINAL_STATES = new Set<BrowserSessionV1["state"]>([
  "closed",
  "expired",
  "lost",
  "failed",
]);

export type HostedBrowserReconciliationRecord = {
  session: BrowserSessionV1;
  resource: HostedBrowserResourceRecord | null;
};

export interface HostedBrowserReconciliationStore {
  read(sessionId: string): Promise<HostedBrowserReconciliationRecord | null>;
  listForReconciliation(input: {
    organizationId: string;
    environmentId: string;
    now: Date;
  }): Promise<HostedBrowserReconciliationRecord[]>;
  recordReconciliationAttempt(sessionId: string, now: Date): Promise<void>;
  ownsPendingMachine(input: {
    organizationId: string;
    environmentId: string;
    machineId: string;
    browserSessionId?: string | undefined;
    browserGeneration?: number | undefined;
  }): Promise<boolean>;
  markTerminal(input: {
    sessionId: string;
    expectedGeneration?: number | undefined;
    expectedState?: BrowserSessionV1["state"] | undefined;
    expectedMachineId?: string | null | undefined;
    state: "closed" | "expired" | "lost" | "failed";
    reason: BrowserSessionV1["terminalReason"] & string;
    now: Date;
  }): Promise<BrowserSessionV1>;
  confirmCleanup(sessionId: string, now?: Date): Promise<void>;
}

export type HostedBrowserReconciliationResult = {
  scannedSessions: number;
  healthySessions: number;
  pendingSessions: number;
  expiredSessions: number;
  lostSessions: number;
  cleanedSessions: number;
  orphanMachinesDeleted: number;
  failureCount: number;
};

export async function reconcileHostedBrowserSessionsForEnvironment(input: {
  organizationId: string;
  environmentId: string;
  appName: string;
  region: string;
  workerImageDigest: string;
  store: HostedBrowserReconciliationStore;
  machines: BrowserMachineInfrastructureProvider;
  now?: Date | undefined;
  onFailure?:
    | ((error: unknown, metadata: Record<string, string>) => void)
    | undefined;
}): Promise<HostedBrowserReconciliationResult> {
  const now = input.now ?? new Date();
  const records = await input.store.listForReconciliation({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    now,
  });
  const machines = await input.machines.listBrowserMachines({
    appName: input.appName,
  });
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const handledMachineIds = new Set(
    records.flatMap((record) =>
      record.resource ? [record.resource.machineId] : [],
    ),
  );
  const result: HostedBrowserReconciliationResult = {
    scannedSessions: records.length,
    healthySessions: 0,
    pendingSessions: 0,
    expiredSessions: 0,
    lostSessions: 0,
    cleanedSessions: 0,
    orphanMachinesDeleted: 0,
    failureCount: 0,
  };

  for (const record of records) {
    try {
      const current = await input.store.read(record.session.sessionId);
      if (!current) continue;
      if (current.resource) handledMachineIds.add(current.resource.machineId);
      await reconcileRecord({
        ...input,
        now,
        record: current,
        machineById,
        handledMachineIds,
        result,
      });
    } catch (error) {
      result.failureCount += 1;
      input.onFailure?.(error, {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        sessionId: record.session.sessionId,
      });
    } finally {
      if (record.resource) {
        try {
          await input.store.recordReconciliationAttempt(
            record.session.sessionId,
            now,
          );
        } catch (error) {
          result.failureCount += 1;
          input.onFailure?.(error, {
            organizationId: input.organizationId,
            environmentId: input.environmentId,
            sessionId: record.session.sessionId,
          });
        }
      }
    }
  }

  let orphanDeletionAttempts = 0;
  for (const machine of [...machines].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (orphanDeletionAttempts >= 100) break;
    if (
      handledMachineIds.has(machine.id) ||
      (await input.store.ownsPendingMachine({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        machineId: machine.id,
        browserSessionId: machine.browserSessionId,
        browserGeneration: machine.browserGeneration,
      }))
    ) {
      continue;
    }
    orphanDeletionAttempts += 1;
    try {
      await deleteConfirmedMachine(input.machines, input.appName, machine.id);
      result.orphanMachinesDeleted += 1;
    } catch (error) {
      result.failureCount += 1;
      input.onFailure?.(error, {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        machineId: machine.id,
      });
    }
  }

  return result;
}

async function reconcileRecord(input: {
  organizationId: string;
  environmentId: string;
  appName: string;
  region: string;
  workerImageDigest: string;
  store: HostedBrowserReconciliationStore;
  machines: BrowserMachineInfrastructureProvider;
  now: Date;
  record: HostedBrowserReconciliationRecord;
  machineById: Map<string, EnvironmentProviderMachine>;
  handledMachineIds: Set<string>;
  result: HostedBrowserReconciliationResult;
}) {
  const { session, resource } = input.record;
  if (session.state === "opening") {
    await reconcileOpening(input);
    return;
  }
  if (!resource) {
    const matchingMachines = [...input.machineById.values()].filter(
      (machine) => machine.browserSessionId === session.sessionId,
    );
    if (TERMINAL_STATES.has(session.state)) return;
    if (
      input.now >= new Date(session.idleExpiresAt) ||
      input.now >= new Date(session.hardExpiresAt)
    ) {
      await markRecordTerminal(input, {
        state: "expired",
        reason: "BROWSER_SESSION_EXPIRED",
      });
      input.result.expiredSessions += 1;
      for (const machine of matchingMachines.filter((candidate) =>
        hasExactUnattachedIdentity(input, candidate),
      )) {
        input.handledMachineIds.add(machine.id);
        await deleteConfirmedMachine(input.machines, input.appName, machine.id);
        input.result.cleanedSessions += 1;
      }
      return;
    }
    await markRecordTerminal(input, {
      state: "lost",
      reason: "BROWSER_SESSION_LOST",
    });
    input.result.lostSessions += 1;
    return;
  }

  if (TERMINAL_STATES.has(session.state)) {
    await cleanupRecord(input, resource);
    return;
  }

  if (session.state === "closing") {
    await markRecordTerminal(input, {
      state: "closed",
      reason: "closed_by_user",
    });
    await cleanupRecord(input, resource);
    return;
  }

  if (
    input.now >= new Date(session.idleExpiresAt) ||
    input.now >= new Date(session.hardExpiresAt)
  ) {
    await markRecordTerminal(input, {
      state: "expired",
      reason: "BROWSER_SESSION_EXPIRED",
    });
    input.result.expiredSessions += 1;
    await cleanupRecord(input, resource);
    return;
  }

  const machine = await input.machines.getMachine({
    appName: input.appName,
    machineId: resource.machineId,
  });
  if (!machine) {
    await markRecordTerminal(input, {
      state: "lost",
      reason: "BROWSER_SESSION_LOST",
    });
    input.result.lostSessions += 1;
    await input.store.confirmCleanup(session.sessionId, input.now);
    input.result.cleanedSessions += 1;
    return;
  }

  if (!isExpectedMachine(input, machine)) {
    await markRecordTerminal(input, {
      state: "lost",
      reason: "BROWSER_ENGINE_FAILURE",
    });
    input.result.lostSessions += 1;
    await cleanupRecord(input, resource);
    return;
  }

  input.result.healthySessions += 1;
}

async function reconcileOpening(input: Parameters<typeof reconcileRecord>[0]) {
  const { session, resource } = input.record;
  const deadline = Math.min(
    Date.parse(session.createdAt) + HOSTED_BROWSER_OPENING_TIMEOUT_MS,
    Date.parse(session.idleExpiresAt),
    Date.parse(session.hardExpiresAt),
  );
  const candidates = resource
    ? [
        await input.machines.getMachine({
          appName: input.appName,
          machineId: resource.machineId,
        }),
      ]
    : await input.machines.listBrowserMachines({
        appName: input.appName,
        sessionId: session.sessionId,
      });
  const machines = candidates.filter(
    (machine): machine is EnvironmentProviderMachine => machine !== null,
  );
  for (const machine of machines) input.handledMachineIds.add(machine.id);
  const exact =
    (!resource ||
      (resource.machineGeneration === session.generation &&
        resource.workerImageDigest === input.workerImageDigest)) &&
    machines.length <= 1 &&
    machines.every(
      (machine) =>
        (machine.state === "created" ||
          machine.state === "starting" ||
          machine.state === "started") &&
        hasExactUnattachedIdentity(input, machine, true) &&
        (!resource || machine.id === resource.machineId),
    );
  if (input.now.getTime() < deadline && exact) {
    // A missing provider record can also be a create/attach visibility race.
    // Only the opener can acknowledge readiness; a pending session is not ready.
    input.result.pendingSessions += 1;
    return;
  }
  const expired =
    input.now >= new Date(session.idleExpiresAt) ||
    input.now >= new Date(session.hardExpiresAt);
  await markRecordTerminal(input, {
    state: expired ? "expired" : "lost",
    reason: expired ? "BROWSER_SESSION_EXPIRED" : "BROWSER_ENGINE_FAILURE",
  });
  if (expired) input.result.expiredSessions += 1;
  else input.result.lostSessions += 1;
  if (resource) {
    await cleanupRecord(input, resource);
  } else {
    for (const machine of machines.filter((candidate) =>
      hasExactUnattachedIdentity(input, candidate, true),
    )) {
      await deleteConfirmedMachine(input.machines, input.appName, machine.id);
      input.result.cleanedSessions += 1;
    }
  }
}

function markRecordTerminal(
  input: Parameters<typeof reconcileRecord>[0],
  terminal: Pick<
    Parameters<HostedBrowserReconciliationStore["markTerminal"]>[0],
    "state" | "reason"
  >,
) {
  return input.store.markTerminal({
    sessionId: input.record.session.sessionId,
    expectedGeneration: input.record.session.generation,
    expectedState: input.record.session.state,
    expectedMachineId: input.record.resource?.machineId ?? null,
    now: input.now,
    ...terminal,
  });
}

function hasExactUnattachedIdentity(
  input: Parameters<typeof reconcileRecord>[0],
  machine: EnvironmentProviderMachine,
  opening = false,
) {
  const { session } = input.record;
  return (
    session.engineRevision ===
      BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision &&
    machine.region === input.region &&
    machine.browserSessionId === session.sessionId &&
    machine.browserGeneration === session.generation &&
    (machine.image === undefined ||
      machine.image === input.workerImageDigest) &&
    (machine.resolvedImageDigest ===
      input.workerImageDigest.split("@").at(-1) ||
      (opening &&
        (machine.state === "created" || machine.state === "starting") &&
        machine.resolvedImageDigest === undefined &&
        machine.image === input.workerImageDigest)) &&
    (machine.mounts?.length ?? 0) === 0
  );
}

function isExpectedMachine(
  input: Parameters<typeof reconcileRecord>[0],
  machine: EnvironmentProviderMachine,
) {
  const { session, resource } = input.record;
  if (!resource) return false;
  return (
    session.engineRevision ===
      BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision &&
    resource.workerImageDigest === input.workerImageDigest &&
    machine.state === "started" &&
    machine.region === input.region &&
    machine.browserSessionId === session.sessionId &&
    machine.browserGeneration === session.generation &&
    resource.machineGeneration === session.generation &&
    machine.resolvedImageDigest ===
      resource.workerImageDigest.split("@").at(-1) &&
    (machine.mounts?.length ?? 0) === 0
  );
}

async function cleanupRecord(
  input: Parameters<typeof reconcileRecord>[0],
  resource: HostedBrowserResourceRecord,
) {
  await deleteConfirmedMachine(
    input.machines,
    input.appName,
    resource.machineId,
  );
  await input.store.confirmCleanup(resource.sessionId, input.now);
  input.result.cleanedSessions += 1;
}

async function deleteConfirmedMachine(
  machines: BrowserMachineInfrastructureProvider,
  appName: string,
  machineId: string,
) {
  await deleteConfirmedBrowserMachine({ machines, appName, machineId });
}
