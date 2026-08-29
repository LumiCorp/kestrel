import type {
  TuiPendingQueueSubmission,
  TuiQueuedRunReservation,
  TuiSessionMeta,
  TuiTerminalQueuedRun,
} from "../contracts.js";

type QueueRecord = TuiPendingQueueSubmission | TuiQueuedRunReservation | TuiTerminalQueuedRun;

export interface ResolvedTuiQueuedEvidence {
  runId: string;
  messageId: string;
  threadId: string;
  predecessorRunId?: string | undefined;
  source: "pending" | "reservation" | "accepted" | "tombstone";
  terminalStatus?: TuiTerminalQueuedRun["status"] | undefined;
}

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
  const graph = {
    pendingQueueSubmissions,
    queuedRunReservations,
    terminalQueuedRuns,
  };
  assertExactQueueGraph(graph);
  return graph;
}

export function resolveExactTuiQueuedEvidence(
  session: TuiSessionMeta,
  identity: { runId: string; messageId?: string | undefined; threadId: string },
): ResolvedTuiQueuedEvidence | undefined {
  const graph = normalizeTuiQueueGraph(session);
  const matchingGraphRecords = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
    ...(graph.terminalQueuedRuns ?? []),
  ].filter((candidate) =>
    candidate.runId === identity.runId && candidate.threadId === identity.threadId
  );
  const acceptedMatches =
    session.acceptedRunPredecessorId !== undefined
    && session.acceptedRunId === identity.runId
    && session.acceptedRunMessageId !== undefined
    && session.acceptedRunThreadId === identity.threadId;
  const exactMessages = new Set(matchingGraphRecords.map((candidate) => candidate.messageId));
  if (acceptedMatches) exactMessages.add(session.acceptedRunMessageId!);
  if (exactMessages.size === 0) return undefined;
  if (exactMessages.size !== 1) {
    throw new TuiQueueGraphConsistencyError(
      `Queued evidence for run '${identity.runId}' has conflicting message authority.`,
    );
  }
  const messageId = [...exactMessages][0]!;
  if (identity.messageId !== undefined && identity.messageId !== messageId) return undefined;
  const predecessorAuthorities = new Set(
    matchingGraphRecords.map((candidate) => candidate.predecessorRunId ?? null),
  );
  if (acceptedMatches) predecessorAuthorities.add(session.acceptedRunPredecessorId ?? null);
  if (predecessorAuthorities.size !== 1) {
    throw new TuiQueueGraphConsistencyError(
      `Queued evidence for run '${identity.runId}' has conflicting predecessor authority.`,
    );
  }
  const terminalStatuses = new Set(
    matchingGraphRecords.flatMap((candidate) =>
      "status" in candidate ? [candidate.status] : []
    ),
  );
  if (
    acceptedMatches
    && (session.lastRunStatus === "COMPLETED" || session.lastRunStatus === "FAILED")
  ) terminalStatuses.add(session.lastRunStatus);
  if (terminalStatuses.size > 1) {
    throw new TuiQueueGraphConsistencyError(
      `Queued evidence for run '${identity.runId}' has conflicting terminal status authority.`,
    );
  }
  const matchesIdentity = (candidate: QueueRecord) =>
    candidate.runId === identity.runId
    && candidate.messageId === messageId
    && candidate.threadId === identity.threadId;
  const candidates: ResolvedTuiQueuedEvidence[] = [];
  const pending = graph.pendingQueueSubmissions?.find(matchesIdentity);
  if (pending !== undefined) candidates.push({ ...pending, source: "pending" });
  const reservation = graph.queuedRunReservations?.find(matchesIdentity);
  if (reservation !== undefined) candidates.push({ ...reservation, source: "reservation" });
  if (
    session.acceptedRunPredecessorId !== undefined
    && session.acceptedRunId === identity.runId
    && session.acceptedRunMessageId === messageId
    && session.acceptedRunThreadId === identity.threadId
  ) {
    candidates.push({
      runId: identity.runId,
      messageId,
      threadId: identity.threadId,
      ...(session.acceptedRunPredecessorId === null
        ? {}
        : { predecessorRunId: session.acceptedRunPredecessorId }),
      source: "accepted",
    });
  }
  const tombstone = graph.terminalQueuedRuns?.find(matchesIdentity);
  if (tombstone !== undefined) {
    const { status, ...identityEvidence } = tombstone;
    candidates.push({
      ...identityEvidence,
      source: "tombstone",
      terminalStatus: status,
    });
  }
  if (candidates.length === 0) return undefined;
  return candidates.find((candidate) => candidate.source === "tombstone")
    ?? candidates.find((candidate) => candidate.source === "accepted")
    ?? candidates.find((candidate) => candidate.source === "reservation")
    ?? candidates[0];
}

export function advanceTuiQueueAuthority(
  graph: NormalizedTuiQueueGraph,
  accepted: QueueRecord,
): NormalizedTuiQueueGraph {
  const activeRecords: QueueRecord[] = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
  ];
  const preservesUnresolvedFork = activeRecords.some((candidate) =>
    candidate.runId !== accepted.runId
    && candidate.predecessorRunId === accepted.predecessorRunId
  );
  const advance = <T extends QueueRecord>(records: T[] | undefined): T[] | undefined => {
    const next = records?.filter((candidate) =>
      preservesUnresolvedFork || candidate.runId !== accepted.runId
    );
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

export function bindTuiQueueSuccessor(
  graph: NormalizedTuiQueueGraph,
  successor: QueueRecord,
  predecessor: Pick<QueueRecord, "runId" | "messageId" | "threadId">,
): NormalizedTuiQueueGraph {
  if (successor.runId === predecessor.runId || successor.threadId !== predecessor.threadId) {
    throw new TuiQueueGraphConsistencyError("Queue ordering evidence has conflicting identities.");
  }
  let matched = false;
  const bind = <T extends QueueRecord>(records: T[] | undefined): T[] | undefined => records?.map(
    (candidate) => {
      if (candidate.runId !== successor.runId) return candidate;
      if (
        candidate.messageId !== successor.messageId
        || candidate.threadId !== successor.threadId
      ) {
        throw new TuiQueueGraphConsistencyError("Queue successor identity conflicted with durable evidence.");
      }
      matched = true;
      return { ...candidate, predecessorRunId: predecessor.runId };
    },
  );
  const next = {
    pendingQueueSubmissions: bind(graph.pendingQueueSubmissions),
    queuedRunReservations: bind(graph.queuedRunReservations),
    terminalQueuedRuns: bind(graph.terminalQueuedRuns),
  };
  if (matched === false) {
    throw new TuiQueueGraphConsistencyError("Queue successor was absent from durable state.");
  }
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

export function replaceTuiQueueRunIdentity(
  graph: NormalizedTuiQueueGraph,
  current: QueueRecord,
  runtimeRunId: string,
): NormalizedTuiQueueGraph {
  if (runtimeRunId === current.runId) return graph;
  const allRecords: QueueRecord[] = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
    ...(graph.terminalQueuedRuns ?? []),
  ];
  if (allRecords.some((candidate) => candidate.runId === runtimeRunId)) {
    throw new TuiQueueGraphConsistencyError(
      `Runtime run '${runtimeRunId}' already belongs to different queued evidence.`,
    );
  }
  let replaced = false;
  const replace = <T extends QueueRecord>(records: T[] | undefined): T[] | undefined => records?.map(
    (candidate) => {
      if (candidate.runId === current.runId) {
        if (
          candidate.messageId !== current.messageId
          || candidate.threadId !== current.threadId
        ) {
          throw new TuiQueueGraphConsistencyError(
            "Queued runtime identity conflicted with the pending message.",
          );
        }
        replaced = true;
        return { ...candidate, runId: runtimeRunId };
      }
      return candidate.predecessorRunId === current.runId
        ? { ...candidate, predecessorRunId: runtimeRunId }
        : candidate;
    },
  );
  const next = {
    pendingQueueSubmissions: replace(graph.pendingQueueSubmissions),
    queuedRunReservations: replace(graph.queuedRunReservations),
    terminalQueuedRuns: replace(graph.terminalQueuedRuns),
  };
  if (replaced === false) {
    throw new TuiQueueGraphConsistencyError("Queued message was absent from durable state.");
  }
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
  assertNoUnorderedQueueForks(graph);
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

function assertNoUnorderedQueueForks(graph: NormalizedTuiQueueGraph): void {
  const records: QueueRecord[] = [
    ...(graph.pendingQueueSubmissions ?? []),
    ...(graph.queuedRunReservations ?? []),
    ...(graph.terminalQueuedRuns ?? []),
  ];
  for (const record of records) {
    const siblings = records.filter(
      (candidate) => candidate.predecessorRunId === record.predecessorRunId,
    );
    if (siblings.length > 1) {
      throw new TuiQueueGraphConsistencyError(
        `Queue graph contains an unresolved queue fork after '${record.predecessorRunId ?? "<root>"}'.`,
      );
    }
  }
}

function assertActiveRecordsReachAccepted(
  graph: NormalizedTuiQueueGraph,
  acceptedRunId: string | undefined,
): void {
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
      if (acceptedRunId !== undefined && predecessorRunId === acceptedRunId) {
        reachesAcceptedAuthority = true;
        break;
      }
      visited.add(predecessorRunId);
      const predecessor = byRunId.get(predecessorRunId);
      if (predecessor === undefined) {
        throw new TuiQueueGraphConsistencyError(
          `Queue graph record '${record.runId}' has dangling predecessor '${predecessorRunId}'.`,
        );
      }
      predecessorRunId = predecessor.predecessorRunId;
    }
    if (acceptedRunId !== undefined && reachesAcceptedAuthority === false) {
      throw new TuiQueueGraphConsistencyError(
        `Queue graph record '${record.runId}' does not reach accepted run '${acceptedRunId}'.`,
      );
    }
  }
}
