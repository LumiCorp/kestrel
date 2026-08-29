import type {
  TuiPendingQueueSubmission,
  TuiQueuedRunReservation,
  TuiSessionMeta,
  TuiTerminalQueuedRun,
} from "../contracts.js";

type QueueRecord = TuiPendingQueueSubmission | TuiQueuedRunReservation | TuiTerminalQueuedRun;

export class TuiQueueGraphConsistencyError extends Error {
  readonly code = "TUI_QUEUE_GRAPH_CONSISTENCY_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "TuiQueueGraphConsistencyError";
  }
}

export interface NormalizedTuiQueueGraph {
  pendingQueueSubmissions: TuiSessionMeta["pendingQueueSubmissions"];
  queuedRunReservations: TuiSessionMeta["queuedRunReservations"];
  terminalQueuedRuns: TuiSessionMeta["terminalQueuedRuns"];
}

export function normalizeTuiQueueGraph(session: TuiSessionMeta): NormalizedTuiQueueGraph {
  const pendingQueueSubmissions = normalizeDurableJournalOrder(
    session.pendingQueueSubmissions,
  );
  const queuedRunReservations = normalizeDurableJournalOrder(
    session.queuedRunReservations,
  );
  // Terminal records are independent durable tombstones, not pending journal
  // siblings. Preserve their exact historical predecessor evidence.
  const terminalQueuedRuns = session.terminalQueuedRuns?.map((record) => ({ ...record }));
  assertExactQueueGraph({
    pendingQueueSubmissions,
    queuedRunReservations,
    terminalQueuedRuns,
  });
  return { pendingQueueSubmissions, queuedRunReservations, terminalQueuedRuns };
}

export function removeAndRewireTuiQueueRecord(
  graph: NormalizedTuiQueueGraph,
  removed: QueueRecord,
): NormalizedTuiQueueGraph {
  const rewire = <T extends QueueRecord>(records: T[] | undefined): T[] | undefined => {
    const next = records
      ?.filter((candidate) => candidate.runId !== removed.runId)
      .map((candidate) => candidate.predecessorRunId === removed.runId
        ? {
            ...candidate,
            predecessorRunId: removed.predecessorRunId,
          }
        : candidate);
    return next === undefined || next.length === 0 ? undefined : next;
  };
  return normalizeTuiQueueGraph({
    sessionId: "queue-graph",
    name: "queue-graph",
    profileId: "queue-graph",
    createdAt: "",
    updatedAt: "",
    started: false,
    pendingQueueSubmissions: rewire(graph.pendingQueueSubmissions),
    queuedRunReservations: rewire(graph.queuedRunReservations),
    terminalQueuedRuns: graph.terminalQueuedRuns?.map((record) => ({ ...record })),
  });
}

export function exactTuiQueueTailRunId(
  session: TuiSessionMeta,
  graph = normalizeTuiQueueGraph(session),
): string | undefined {
  const active = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
  ];
  if (active.length === 0) return session.acceptedRunId;
  const tails = active.filter((candidate) => active.some(
    (other) => other.predecessorRunId === candidate.runId,
  ) === false);
  if (tails.length !== 1) {
    throw new TuiQueueGraphConsistencyError("Queue graph has no unique exact active tail.");
  }
  return tails[0]!.runId;
}

function normalizeDurableJournalOrder<T extends QueueRecord>(records: T[] | undefined): T[] | undefined {
  if (records === undefined || records.length === 0) return undefined;
  const latestSiblingByPredecessor = new Map<string | undefined, string>();
  return records.map((record) => {
    const durablePredecessor = record.predecessorRunId;
    const priorSibling = latestSiblingByPredecessor.get(durablePredecessor);
    latestSiblingByPredecessor.set(durablePredecessor, record.runId);
    if (priorSibling === undefined) return { ...record };
    return { ...record, predecessorRunId: priorSibling };
  });
}

function assertExactQueueGraph(graph: NormalizedTuiQueueGraph): void {
  const records: QueueRecord[] = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
    ...(graph.terminalQueuedRuns ?? []),
  ];
  const byRunId = new Map<string, QueueRecord>();
  const byMessageId = new Map<string, QueueRecord>();
  for (const record of records) {
    if (byRunId.has(record.runId)) {
      throw new TuiQueueGraphConsistencyError(`Queue graph contains duplicate run '${record.runId}'.`);
    }
    if (byMessageId.has(record.messageId)) {
      throw new TuiQueueGraphConsistencyError(
        `Queue graph contains conflicting message '${record.messageId}'.`,
      );
    }
    byRunId.set(record.runId, record);
    byMessageId.set(record.messageId, record);
  }
  for (const record of records) {
    const visited = new Set<string>([record.runId]);
    let predecessorRunId = record.predecessorRunId;
    while (predecessorRunId !== undefined) {
      if (visited.has(predecessorRunId)) {
        throw new TuiQueueGraphConsistencyError("Queue graph contains a predecessor cycle.");
      }
      visited.add(predecessorRunId);
      predecessorRunId = byRunId.get(predecessorRunId)?.predecessorRunId;
    }
  }
  const activeRecords: QueueRecord[] = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
  ];
  const activeTails = activeRecords.filter((candidate) => activeRecords.some(
    (other) => other.predecessorRunId === candidate.runId,
  ) === false);
  if (activeRecords.length > 0 && activeTails.length !== 1) {
    throw new TuiQueueGraphConsistencyError("Queue graph has no unique exact active tail.");
  }
}
