import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import { clampText } from "./textUtils.js";

export interface ManagedEntrypointContext {
  path: string;
  command: string;
  cwd: string;
  securityMode: "protected_entrypoint";
  requiredTransport: "kestrel_devshell.start" | "dev.process.start";
}

export function readManagedEntrypoints(eventPayload: Record<string, unknown>): ManagedEntrypointContext[] {
  const metadata = asRecord(eventPayload.metadata);
  const orchestration = asRecord(eventPayload.orchestration);
  const rawEntries = asArray(
    metadata?.managedEntrypoints ??
    orchestration?.managedEntrypoints ??
    eventPayload.managedEntrypoints,
  );
  const entries: ManagedEntrypointContext[] = [];
  const seen = new Set<string>();
  for (const item of rawEntries) {
    const record = asRecord(item);
    const path = asString(record?.path)?.trim();
    const command = asString(record?.command)?.trim();
    const cwd = asString(record?.cwd)?.trim();
    if (path === undefined || path.length === 0 || command === undefined || command.length === 0 || cwd === undefined || cwd.length === 0) {
      continue;
    }
    const securityMode = asString(record?.securityMode);
    if (securityMode !== "protected_entrypoint") {
      continue;
    }
    const rawTransport = asString(record?.requiredTransport);
    const requiredTransport = rawTransport === "dev.process.start"
      ? "dev.process.start"
      : "kestrel_devshell.start";
    const key = `${cwd}\0${command}\0${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({
      path,
      command,
      cwd,
      securityMode,
      requiredTransport,
    });
    if (entries.length >= 8) {
      break;
    }
  }
  return entries;
}

export function buildDevShellProcessContext(devShell: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (devShell === undefined) {
    return [];
  }
  const processes = asRecord(devShell.processes) ?? {};
  const liveProcessIds = new Set(
    asArray(devShell.liveProcessIds)
      .map((item) => asString(item))
      .filter((item): item is string => item !== undefined),
  );
  const entries = Object.entries(processes)
    .map(([processId, value]) => {
      const record = asRecord(value) ?? {};
      return {
        processId,
        ...(asString(record.command) !== undefined ? { command: clampText(asString(record.command), 180) } : {}),
        ...(asString(record.cwd) !== undefined ? { cwd: asString(record.cwd) } : {}),
        ...(asString(record.workspaceRoot) !== undefined ? { workspaceRoot: asString(record.workspaceRoot) } : {}),
        ...(asString(record.status) !== undefined ? { status: asString(record.status) } : {}),
        ...(asString(record.securityMode) !== undefined ? { securityMode: asString(record.securityMode) } : {}),
        live: liveProcessIds.has(processId),
        ...(asString(record.startedAt) !== undefined ? { startedAt: asString(record.startedAt) } : {}),
        ...(asString(record.updatedAt) !== undefined ? { updatedAt: asString(record.updatedAt) } : {}),
        ...(asString(record.completedAt) !== undefined ? { completedAt: asString(record.completedAt) } : {}),
        ...(typeof record.exitCode === "number" ? { exitCode: Math.trunc(record.exitCode) } : {}),
        ...(typeof record.chunkBytes === "number" ? { chunkBytes: Math.max(0, Math.trunc(record.chunkBytes)) } : {}),
        ...(record.truncated === true ? { truncated: true } : {}),
        ...(asString(record.lastStdinPreview) !== undefined
          ? { lastStdinPreview: clampText(asString(record.lastStdinPreview), 120) }
          : {}),
        ...(asString(record.lastStdinAt) !== undefined ? { lastStdinAt: asString(record.lastStdinAt) } : {}),
      };
    });
  if (entries.length > 0) {
    return entries.slice(-8);
  }
  const activeProcessId = asString(devShell.activeProcessId) ?? asString(devShell.processId);
  if (activeProcessId === undefined) {
    return [];
  }
  const lastCommand = asRecord(devShell.lastCommand);
  return [
    {
      processId: activeProcessId,
      ...(asString(lastCommand?.command) !== undefined ? { command: clampText(asString(lastCommand?.command), 180) } : {}),
      ...(asString(lastCommand?.cwd) !== undefined ? { cwd: asString(lastCommand?.cwd) } : {}),
      ...(asString(lastCommand?.workspaceRoot) !== undefined ? { workspaceRoot: asString(lastCommand?.workspaceRoot) } : {}),
      ...(asString(devShell.status) !== undefined ? { status: asString(devShell.status) } : {}),
      ...(asString(devShell.securityMode) !== undefined ? { securityMode: asString(devShell.securityMode) } : {}),
      live: liveProcessIds.size === 0 || liveProcessIds.has(activeProcessId),
    },
  ];
}
