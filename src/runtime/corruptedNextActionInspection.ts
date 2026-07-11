import { readActiveWaitState } from "./waitState.js";

export interface CorruptedNextActionSessionRow {
  sessionId: string;
  latestVersion: number;
  currentStepAgent?: string | undefined;
  currentState: Record<string, unknown>;
}

export interface CorruptedNextActionVersionRow {
  sessionId: string;
  version: number;
  state: Record<string, unknown>;
  statePatch: Record<string, unknown>;
}

export interface CorruptedNextActionInspectionReport {
  mutatesData: false;
  affectedSessions: CorruptedNextActionInspectionSession[];
}

export interface CorruptedNextActionInspectionSession {
  sessionId: string;
  latestVersion: number;
  firstCorruptedVersion?: number | undefined;
  currentStepAgent?: string | undefined;
  waitEventType?: string | undefined;
  latestStateCorrupt: boolean;
  repairability: "candidate:lastAction" | "candidate:commandBatch" | "none";
}

export function buildCorruptedNextActionInspectionReport(input: {
  sessions: CorruptedNextActionSessionRow[];
  versions: CorruptedNextActionVersionRow[];
}): CorruptedNextActionInspectionReport {
  const versionRowsBySession = new Map<string, CorruptedNextActionVersionRow[]>();
  for (const version of input.versions) {
    const existing = versionRowsBySession.get(version.sessionId) ?? [];
    existing.push(version);
    versionRowsBySession.set(version.sessionId, existing);
  }

  const affectedSessions = input.sessions
    .map((session): CorruptedNextActionInspectionSession | undefined => {
      const agent = asRecord(session.currentState.agent);
      const latestStateCorrupt = isCircularNextAction(agent);
      const corruptedVersions = (versionRowsBySession.get(session.sessionId) ?? [])
        .filter((version) =>
          isCircularNextAction(asRecord(version.state.agent)) ||
          isCircularNextAction(asRecord(version.statePatch.agent))
        )
        .sort((left, right) => left.version - right.version);
      if (latestStateCorrupt === false && corruptedVersions.length === 0) {
        return undefined;
      }

      const wait = readActiveWaitState(agent);
      return {
        sessionId: session.sessionId,
        latestVersion: session.latestVersion,
        ...(corruptedVersions[0]?.version !== undefined
          ? { firstCorruptedVersion: corruptedVersions[0].version }
          : {}),
        ...(session.currentStepAgent !== undefined ? { currentStepAgent: session.currentStepAgent } : {}),
        ...(wait?.eventType !== undefined ? { waitEventType: wait.eventType } : {}),
        latestStateCorrupt,
        repairability: classifyRepairability(agent),
      };
    })
    .filter((entry): entry is CorruptedNextActionInspectionSession => entry !== undefined)
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));

  return {
    mutatesData: false,
    affectedSessions,
  };
}

function isCircularNextAction(agent: Record<string, unknown> | undefined): boolean {
  return agent?.nextAction === "[Circular]";
}

function classifyRepairability(
  agent: Record<string, unknown> | undefined,
): CorruptedNextActionInspectionSession["repairability"] {
  if (asRecord(agent?.lastAction) !== undefined) {
    return "candidate:lastAction";
  }
  const commandBatch = asRecord(agent?.commandBatch);
  const commands = Array.isArray(commandBatch?.commands) ? commandBatch.commands : [];
  if (commands.some((entry) => asRecord(entry) !== undefined)) {
    return "candidate:commandBatch";
  }
  return "none";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
