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
  // Routed responses can arrive in reverse order, so reservation order is not
  // submission authority. Terminal records are independent tombstones too.
  const queuedRunReservations = session.queuedRunReservations?.map((record) => ({ ...record }));
  const terminalQueuedRuns = session.terminalQueuedRuns?.map((record) => ({ ...record }));
  const graph = resolveAcceptedTerminalAuthority(session, {
    pendingQueueSubmissions,
    queuedRunReservations,
    terminalQueuedRuns,
  });
  assertExactQueueGraph(graph);
  return graph;
}

export function advanceTuiQueueAuthority(
  graph: NormalizedTuiQueueGraph,
  accepted: QueueRecord,
): NormalizedTuiQueueGraph {
  const advance = <T extends QueueRecord>(records: T[] | undefined): T[] | undefined => {
    const next = records
      ?.filter((candidate) => candidate.runId !== accepted.runId)
      .map((candidate) => candidate.predecessorRunId === accepted.predecessorRunId
        ? { ...candidate, predecessorRunId: accepted.runId }
        : candidate);
    return next === undefined || next.length === 0 ? undefined : next;
  };
  const next = {
    pendingQueueSubmissions: advance(graph.pendingQueueSubmissions),
    queuedRunReservations: advance(graph.queuedRunReservations),
    terminalQueuedRuns: graph.terminalQueuedRuns?.map((record) => ({ ...record })),
  };
  assertExactQueueGraph(next);
  return next;
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
  const next = {
    pendingQueueSubmissions: rewire(graph.pendingQueueSubmissions),
    queuedRunReservations: rewire(graph.queuedRunReservations),
    terminalQueuedRuns: graph.terminalQueuedRuns?.map((record) => ({ ...record })),
  };
  assertExactQueueGraph(next);
  return next;
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
  assertActiveRecordsReachAccepted(graph, session.acceptedRunId);
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

function resolveAcceptedTerminalAuthority(
  session: TuiSessionMeta,
  graph: NormalizedTuiQueueGraph,
): NormalizedTuiQueueGraph {
  if (session.acceptedRunId === undefined) return graph;
  const acceptedTerminal = graph.terminalQueuedRuns?.find((terminal) =>
    terminal.runId === session.acceptedRunId
    && (
      session.acceptedRunMessageId === undefined
      || terminal.messageId === session.acceptedRunMessageId
    )
    && (
      session.acceptedRunThreadId === undefined
      || terminal.threadId === session.acceptedRunThreadId
    )
  );
  if (acceptedTerminal === undefined) return graph;
  const repair = <T extends QueueRecord>(records: T[] | undefined): T[] | undefined => records?.map(
    (candidate) =>
      candidate.runId !== acceptedTerminal.runId
      && candidate.predecessorRunId === acceptedTerminal.predecessorRunId
        ? { ...candidate, predecessorRunId: acceptedTerminal.runId }
        : candidate,
  );
  return {
    pendingQueueSubmissions: repair(graph.pendingQueueSubmissions),
    queuedRunReservations: repair(graph.queuedRunReservations),
    terminalQueuedRuns: graph.terminalQueuedRuns,
  };
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
}

function assertActiveRecordsReachAccepted(
  graph: NormalizedTuiQueueGraph,
  acceptedRunId: string | undefined,
): void {
  if (acceptedRunId === undefined) return;
  const records: QueueRecord[] = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
    ...(graph.terminalQueuedRuns ?? []),
  ];
  const byRunId = new Map(records.map((record) => [record.runId, record]));
  const activeRecords: QueueRecord[] = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
  ];
  for (const record of activeRecords) {
    let predecessorRunId = record.predecessorRunId;
    const visited = new Set<string>([record.runId]);
    let reachesAcceptedAuthority = false;
    while (predecessorRunId !== undefined && visited.has(predecessorRunId) === false) {
      if (predecessorRunId === acceptedRunId) {
        reachesAcceptedAuthority = true;
        break;
      }
      visited.add(predecessorRunId);
      predecessorRunId = byRunId.get(predecessorRunId)?.predecessorRunId;
    }
    if (reachesAcceptedAuthority === false) {
      throw new TuiQueueGraphConsistencyError(
        `Queue graph record '${record.runId}' does not reach accepted run '${acceptedRunId}'.`,
      );
    }
  }
}
