import type {
  DevShellProcessRecord,
  DevShellProcessStatus,
  DevShellProcessStore,
} from "./contracts.js";

export class InMemoryDevShellStore implements DevShellProcessStore {
  private readonly processes = new Map<string, DevShellProcessRecord>();

  async upsertProcess(record: DevShellProcessRecord): Promise<void> {
    this.processes.set(record.processId, cloneProcess(record));
  }

  async getProcess(processId: string): Promise<DevShellProcessRecord | null> {
    const record = this.processes.get(processId);
    return record === undefined ? null : cloneProcess(record);
  }

  async listProcesses(input?: {
    status?: DevShellProcessStatus[] | undefined;
  }): Promise<DevShellProcessRecord[]> {
    const statuses = input?.status;
    return [...this.processes.values()]
      .filter((record) => (statuses !== undefined ? statuses.includes(record.status) : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => cloneProcess(record));
  }
}

function cloneProcess(record: DevShellProcessRecord): DevShellProcessRecord {
  return {
    ...record,
    readiness: {
      ...record.readiness,
      tools: record.readiness.tools.map((tool) => ({ ...tool })),
      env: record.readiness.env.map((env) => ({ ...env })),
    },
    requestedTools: [...record.requestedTools],
    envNames: [...record.envNames],
    ...(record.preflight !== undefined ? { preflight: clonePreflight(record.preflight) } : {}),
    ...(record.sourceWriteGuard !== undefined
      ? { sourceWriteGuard: cloneSourceWriteGuard(record.sourceWriteGuard) }
      : {}),
  };
}

function clonePreflight(record: DevShellProcessRecord["preflight"]): DevShellProcessRecord["preflight"] {
  if (record === undefined) {
    return undefined;
  }
  return {
    ...record,
    ...(record.pnpmBuildApproval !== undefined
      ? {
          pnpmBuildApproval: {
            ...record.pnpmBuildApproval,
          },
        }
      : {}),
  };
}

function cloneSourceWriteGuard(
  guard: DevShellProcessRecord["sourceWriteGuard"],
): DevShellProcessRecord["sourceWriteGuard"] {
  if (guard === undefined) {
    return undefined;
  }
  return {
    ...guard,
    sourceRoots: [...guard.sourceRoots],
    allowedWriteRoots: [...guard.allowedWriteRoots],
    unauthorizedSourceWrites: guard.unauthorizedSourceWrites.map((write) => ({ ...write })),
    ...(guard.changedFiles !== undefined ? { changedFiles: [...guard.changedFiles] } : {}),
  };
}
