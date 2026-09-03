import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import type {
  BrowserMachineInfrastructureProvider,
  EnvironmentProviderMachine,
} from "@/lib/environments/providers/contracts";
import type { HostedBrowserResourceRecord } from "./store";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../../../src/browser/runtimeReleaseManifest.js";
import { deleteConfirmedBrowserMachine } from "./machine-cleanup";

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
    state: "closed" | "expired" | "lost" | "failed";
    reason: BrowserSessionV1["terminalReason"] & string;
    now: Date;
  }): Promise<BrowserSessionV1>;
  confirmCleanup(sessionId: string, now?: Date): Promise<void>;
}

export type HostedBrowserReconciliationResult = {
  scannedSessions: number;
  healthySessions: number;
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
  onFailure?: ((error: unknown, metadata: Record<string, string>) => void) | undefined;
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
    expiredSessions: 0,
    lostSessions: 0,
    cleanedSessions: 0,
    orphanMachinesDeleted: 0,
    failureCount: 0,
  };

  for (const record of records) {
    try {
      await reconcileRecord({
        ...input,
        now,
        record,
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
    left.id.localeCompare(right.id)
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
  machineById: Map<
    string,
    EnvironmentProviderMachine
  >;
  handledMachineIds: Set<string>;
  result: HostedBrowserReconciliationResult;
}) {
  const { session, resource } = input.record;
  if (!resource) {
    const matchingMachines = [...input.machineById.values()].filter(
      (machine) => machine.browserSessionId === session.sessionId,
    );
    if (TERMINAL_STATES.has(session.state)) return;
    if (
      input.now >= new Date(session.idleExpiresAt) ||
      input.now >= new Date(session.hardExpiresAt)
    ) {
      await input.store.markTerminal({
        sessionId: session.sessionId,
        expectedGeneration: session.generation,
        state: "expired",
        reason: "BROWSER_SESSION_EXPIRED",
        now: input.now,
      });
      input.result.expiredSessions += 1;
      for (const machine of matchingMachines.filter((candidate) =>
        hasExactUnattachedIdentity(input, candidate)
      )) {
        input.handledMachineIds.add(machine.id);
        await deleteConfirmedMachine(input.machines, input.appName, machine.id);
        input.result.cleanedSessions += 1;
      }
      return;
    }
    if (
      session.state === "opening" &&
      matchingMachines.length === 1 &&
      isExpectedUnattachedMachine(input, matchingMachines[0]!)
    ) {
      input.result.healthySessions += 1;
      return;
    }
    await input.store.markTerminal({
      sessionId: session.sessionId,
      expectedGeneration: session.generation,
      state: "lost",
      reason: "BROWSER_SESSION_LOST",
      now: input.now,
    });
    input.result.lostSessions += 1;
    return;
  }

  if (TERMINAL_STATES.has(session.state)) {
    await cleanupRecord(input, resource);
    return;
  }

  if (session.state === "closing") {
    await input.store.markTerminal({
      sessionId: session.sessionId,
      expectedGeneration: session.generation,
      state: "closed",
      reason: "closed_by_user",
      now: input.now,
    });
    await cleanupRecord(input, resource);
    return;
  }

  if (
    input.now >= new Date(session.idleExpiresAt) ||
    input.now >= new Date(session.hardExpiresAt)
  ) {
    await input.store.markTerminal({
      sessionId: session.sessionId,
      expectedGeneration: session.generation,
      state: "expired",
      reason: "BROWSER_SESSION_EXPIRED",
      now: input.now,
    });
    input.result.expiredSessions += 1;
    await cleanupRecord(input, resource);
    return;
  }

  const machine = input.machineById.get(resource.machineId) ??
    (await input.machines.getMachine({
      appName: input.appName,
      machineId: resource.machineId,
    }));
  if (!machine) {
    await input.store.markTerminal({
      sessionId: session.sessionId,
      expectedGeneration: session.generation,
      state: "lost",
      reason: "BROWSER_SESSION_LOST",
      now: input.now,
    });
    input.result.lostSessions += 1;
    await input.store.confirmCleanup(session.sessionId, input.now);
    input.result.cleanedSessions += 1;
    return;
  }

  if (!isExpectedMachine(input, machine)) {
    await input.store.markTerminal({
      sessionId: session.sessionId,
      expectedGeneration: session.generation,
      state: "lost",
      reason: "BROWSER_ENGINE_FAILURE",
      now: input.now,
    });
    input.result.lostSessions += 1;
    await cleanupRecord(input, resource);
    return;
  }

  input.result.healthySessions += 1;
}

function isExpectedUnattachedMachine(
  input: Parameters<typeof reconcileRecord>[0],
  machine: EnvironmentProviderMachine,
) {
  return (
    machine.state === "started" &&
    hasExactUnattachedIdentity(input, machine)
  );
}

function hasExactUnattachedIdentity(
  input: Parameters<typeof reconcileRecord>[0],
  machine: EnvironmentProviderMachine,
) {
  const { session } = input.record;
  return (
    session.engineRevision === BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision &&
    machine.region === input.region &&
    machine.browserSessionId === session.sessionId &&
    machine.browserGeneration === session.generation &&
    machine.resolvedImageDigest ===
      input.workerImageDigest.split("@").at(-1) &&
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
    session.engineRevision === BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision &&
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
