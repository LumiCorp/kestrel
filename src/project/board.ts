import { createHash } from "node:crypto";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  ProductBoardCard,
  ProductBoardEvidenceEntry,
  ProductBoardEvidenceOutcome,
  ProductBoardEvidenceSource,
  ProductBoardLane,
  ProductBoardSnapshot,
  ProductProjectBoardAction,
} from "./contracts.js";

export const PRODUCT_BOARD_LANES: ProductBoardLane[] = ["idea", "planned", "wip", "testing", "done"];
const LEGACY_BOARD_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export function createEmptyProjectBoard(): ProductBoardSnapshot {
  return {
    version: 1,
    boardVersion: 1,
    nextCardNumber: 1,
    lanes: [...PRODUCT_BOARD_LANES],
    settings: {
      autopilotEnabled: false,
      wipLimit: 1,
    },
    cards: {},
  };
}

export function normalizeProjectBoard(value: unknown): ProductBoardSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createEmptyProjectBoard();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.cards !== "object" || record.cards === null || Array.isArray(record.cards)) {
    return createEmptyProjectBoard();
  }
  const cards: Record<string, ProductBoardCard> = {};
  for (const [cardId, cardValue] of Object.entries(record.cards as Record<string, unknown>)) {
    const card = normalizeCard(cardId, cardValue);
    if (card !== undefined) {
      cards[card.id] = card;
    }
  }
  const highestCardNumber = Object.keys(cards).reduce((highest, cardId) => {
    const match = /^K-(\d+)$/u.exec(cardId);
    return match === null ? highest : Math.max(highest, Number(match[1]));
  }, 0);
  const nextCardNumber =
    Number.isInteger(record.nextCardNumber) && Number(record.nextCardNumber) > highestCardNumber
      ? Number(record.nextCardNumber)
      : highestCardNumber + 1;
  return {
    version: 1,
    boardVersion: Number.isInteger(record.boardVersion) && Number(record.boardVersion) > 0
      ? Number(record.boardVersion)
      : 1,
    nextCardNumber,
    lanes: [...PRODUCT_BOARD_LANES],
    settings: {
      autopilotEnabled: asRecord(record.settings)?.autopilotEnabled === true,
      ...(typeof asRecord(record.settings)?.autopilotConfirmedAt === "string"
        ? { autopilotConfirmedAt: asRecord(record.settings)?.autopilotConfirmedAt as string }
        : {}),
      wipLimit: normalizePositiveInteger(asRecord(record.settings)?.wipLimit, 1),
    },
    cards,
  };
}

export function applyProjectBoardAction(
  board: ProductBoardSnapshot,
  action: ProductProjectBoardAction,
): ProductBoardSnapshot {
  const current = normalizeProjectBoard(board);
  if (
    action.expectedBoardVersion !== undefined &&
    action.expectedBoardVersion !== current.boardVersion
  ) {
    throw createRuntimeFailure(
      "PROJECT_BOARD_VERSION_CONFLICT",
      `Project board version conflict: expected=${action.expectedBoardVersion} actual=${current.boardVersion}.`,
      {
        expectedBoardVersion: action.expectedBoardVersion,
        actualBoardVersion: current.boardVersion,
      },
    );
  }
  switch (action.type) {
    case "board.autopilot.configure":
      if (
        action.autopilotEnabled === true &&
        current.settings.autopilotEnabled !== true &&
        !isValidTimestamp(action.autopilotConfirmedAt)
      ) {
        throw createRuntimeFailure(
          "PROJECT_BOARD_AUTOPILOT_CONFIRMATION_REQUIRED",
          "Enabling Project Autopilot requires an explicit confirmation timestamp.",
        );
      }
      return bumpBoard({
        ...current,
        settings: {
          ...current.settings,
          ...(action.autopilotEnabled !== undefined ? { autopilotEnabled: action.autopilotEnabled } : {}),
          ...(action.autopilotConfirmedAt !== undefined ? { autopilotConfirmedAt: action.autopilotConfirmedAt } : {}),
          ...(action.wipLimit !== undefined ? { wipLimit: normalizePositiveInteger(action.wipLimit, 1) } : {}),
        },
      });
    case "board.card.create":
      return createCard(current, action);
    case "board.card.update":
      return updateCard(current, action);
    case "board.card.move":
      return moveCard(current, action);
    case "board.card.manual_done":
      return manualDone(current, action);
    case "board.card.delete":
      return deleteCard(current, action);
    case "board.card.start_implementation":
      return startAssignedThread(current, action, "implementation", "copilot");
    case "board.card.start_testing":
      return startAssignedThread(current, action, "testing", "copilot");
    case "board.card.thread_completed":
      return completeThread(current, action, "success");
    case "board.card.thread_failed":
      return failThread(current, action, "failure");
    case "board.card.thread_stopped":
      return stopThread(current, action);
    case "board.card.testing_verdict":
      return testingVerdict(current, action);
    case "board.autopilot.tick":
      return runAutopilotTick(current, action);
    default:
      return current;
  }
}

function createCard(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.create" }>,
): ProductBoardSnapshot {
  const title = readRequiredString(action.title, "title");
  const prompt = readRequiredString(action.prompt, "prompt");
  const cardId = `K-${board.nextCardNumber}`;
  const now = action.actionTs;
  const card: ProductBoardCard = {
    id: cardId,
    title,
    prompt,
    lane: "idea",
    order: nextLaneOrder(board, "idea"),
    createdAt: now,
    updatedAt: now,
    threads: [],
    evidence: [makeEvidence(action.source ?? "tool", "created", action.summary ?? "Card created.", undefined, action, "created", now)],
  };
  return bumpBoard({
    ...board,
    nextCardNumber: board.nextCardNumber + 1,
    cards: {
      ...board.cards,
      [cardId]: card,
    },
  });
}

function updateCard(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.update" }>,
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  if (card.lane !== "idea" && card.lane !== "planned") {
    throw createRuntimeFailure("PROJECT_BOARD_CARD_NOT_EDITABLE", "Only idea and planned cards can be updated.", {
      cardId: card.id,
      lane: card.lane,
    });
  }
  const now = action.actionTs;
  const next: ProductBoardCard = {
    ...card,
    ...(action.title !== undefined ? { title: readRequiredString(action.title, "title") } : {}),
    ...(action.prompt !== undefined ? { prompt: readRequiredString(action.prompt, "prompt") } : {}),
    updatedAt: now,
    evidence: [
      ...card.evidence,
      makeEvidence(action.source ?? "tool", "updated", action.summary ?? "Card updated.", undefined, action, "updated", now),
    ],
  };
  return replaceCard(board, next);
}

function moveCard(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.move" }>,
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  const targetLane = parseLane(action.targetLane ?? action.lane);
  const source = action.source ?? "operator";
  if (targetLane === "done") {
    throw createRuntimeFailure("PROJECT_BOARD_DONE_REQUIRES_OVERRIDE", "Use board.card.manual_done to manually mark a card done.", {
      cardId: card.id,
      sourceLane: card.lane,
    });
  }
  validateMove(card, targetLane, source);
  const now = action.actionTs;
  const stopped = shouldStopAssignedThread(card, targetLane);
  const next: ProductBoardCard = {
    ...card,
    lane: targetLane,
    order: action.order ?? nextLaneOrder(board, targetLane, card.id),
    ...(stopped ? { activeClaim: undefined } : card.activeClaim !== undefined ? { activeClaim: card.activeClaim } : {}),
    updatedAt: now,
    threads: stopped
      ? card.threads.map((thread) =>
          thread.threadId === card.activeClaim?.threadId ? { ...thread, status: "stopped", completedAt: now } : thread,
        )
      : card.threads,
    evidence: [
      ...card.evidence,
      makeEvidence(source, "moved", action.summary ?? `Moved from ${card.lane} to ${targetLane}.`, card.activeClaim?.threadId, action, "moved", now),
      ...(stopped
        ? [makeEvidence("operator", "thread_stopped", "Running assigned thread stopped by manual lane movement.", card.activeClaim?.threadId, action, "thread_stopped", now, "move-stop")]
        : []),
    ],
  };
  return replaceCard(board, next);
}

function manualDone(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.manual_done" }>,
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  if (card.lane === "done") {
    return board;
  }
  const now = action.actionTs;
  const stopped = card.activeClaim !== undefined;
  const next: ProductBoardCard = {
    ...card,
    lane: "done",
    order: nextLaneOrder(board, "done", card.id),
    ...(stopped ? { activeClaim: undefined } : card.activeClaim !== undefined ? { activeClaim: card.activeClaim } : {}),
    updatedAt: now,
    threads: stopped
      ? card.threads.map((thread) =>
          thread.threadId === card.activeClaim?.threadId ? { ...thread, status: "stopped", completedAt: now } : thread,
        )
      : card.threads,
    evidence: [
      ...card.evidence,
      makeEvidence(
        "operator",
        "manual_done",
        action.reason ?? action.summary ?? "Marked done by manual override.",
        card.activeClaim?.threadId,
        action,
        "manual-done",
        now,
      ),
      ...(stopped
        ? [makeEvidence("operator", "thread_stopped", "Running assigned thread stopped by manual done override.", card.activeClaim?.threadId, action, "thread_stopped", now, "manual-done-stop")]
        : []),
    ],
  };
  return replaceCard(board, next);
}

function deleteCard(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.delete" }>,
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  if ((card.lane !== "idea" && card.lane !== "planned") || card.activeClaim !== undefined) {
    throw createRuntimeFailure("PROJECT_BOARD_CARD_NOT_DELETABLE", "Only inactive idea and planned cards can be deleted.", {
      cardId: card.id,
      lane: card.lane,
      active: card.activeClaim !== undefined,
    });
  }
  const cards = { ...board.cards };
  delete cards[card.id];
  return bumpBoard({ ...board, cards });
}

function runAutopilotTick(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.autopilot.tick" }>,
): ProductBoardSnapshot {
  if (board.settings.autopilotEnabled !== true) {
    return board;
  }
  const testing = sortedLaneCards(board, "testing").find((card) => card.activeClaim === undefined);
  if (testing !== undefined) {
    return startAssignedThread(board, buildAutopilotThreadAction(action, "board.card.start_testing", testing.id), "testing", "autopilot");
  }
  const wipCount = sortedLaneCards(board, "wip").length;
  if (wipCount >= board.settings.wipLimit) {
    return board;
  }
  const planned = sortedLaneCards(board, "planned").find((card) => card.activeClaim === undefined);
  if (planned === undefined) {
    return board;
  }
  return startAssignedThread(board, buildAutopilotThreadAction(action, "board.card.start_implementation", planned.id), "implementation", "autopilot");
}

function startAssignedThread(
  board: ProductBoardSnapshot,
  action:
    | Extract<ProductProjectBoardAction, { type: "board.card.start_implementation" }>
    | Extract<ProductProjectBoardAction, { type: "board.card.start_testing" }>,
  kind: "implementation" | "testing",
  claimReason: "autopilot" | "copilot",
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  const requiredLane = kind === "implementation" ? "planned" : "testing";
  if (card.lane !== requiredLane) {
    throw createRuntimeFailure(
      kind === "implementation" ? "PROJECT_BOARD_CARD_NOT_READY_FOR_IMPLEMENTATION" : "PROJECT_BOARD_CARD_NOT_READY_FOR_TESTING",
      kind === "implementation"
        ? "Implementation can only start from planned cards."
        : "Testing can only start from testing cards.",
      {
        cardId: card.id,
        lane: card.lane,
      },
    );
  }
  if (card.activeClaim !== undefined) {
    throw createRuntimeFailure("PROJECT_BOARD_CARD_ALREADY_CLAIMED", "Card already has an active assigned thread.", {
      cardId: card.id,
      threadId: card.activeClaim.threadId,
    });
  }
  if (kind === "implementation") {
    const wipCount = sortedLaneCards(board, "wip").length;
    if (wipCount >= board.settings.wipLimit) {
      throw createRuntimeFailure("PROJECT_BOARD_WIP_LIMIT_REACHED", "WIP limit reached.", {
        wipLimit: board.settings.wipLimit,
      });
    }
  }
  const lane = kind === "implementation" ? "wip" : "testing";
  const now = action.actionTs;
  const sessionId = buildAssignedThreadSessionId(action.sessionId, card.id, kind, action.actionId);
  const threadId = `thread-main:${sessionId}`;
  const next: ProductBoardCard = {
    ...card,
    lane,
    order: card.lane === lane ? card.order : nextLaneOrder(board, lane, card.id),
    activeClaim: {
      threadId,
      sessionId,
      kind,
      claimedAt: now,
      claimReason,
    },
    threads: [
      ...card.threads,
      {
        threadId,
        sessionId,
        kind,
        startedAt: now,
        status: "active",
      },
    ],
    updatedAt: now,
    evidence: [
      ...card.evidence,
      makeEvidence(claimReason, "claimed", `${kind} thread claimed.`, threadId, action, "claimed", now),
      makeEvidence(claimReason, "thread_started", `${kind} thread started.`, threadId, action, "thread_started", now),
    ],
  };
  return replaceCard(board, next);
}

function completeThread(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.thread_completed" }>,
  outcome: ProductBoardEvidenceOutcome,
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  if (card.activeClaim === undefined || card.activeClaim.kind !== "implementation") {
    throw createRuntimeFailure("PROJECT_BOARD_NO_ACTIVE_IMPLEMENTATION", "Card has no active implementation thread.", {
      cardId: card.id,
    });
  }
  const now = action.actionTs;
  const next: ProductBoardCard = {
    ...card,
    lane: "testing",
    order: nextLaneOrder(board, "testing", card.id),
    activeClaim: undefined,
    updatedAt: now,
    threads: completeLinkedThread(card, "completed", now),
    evidence: [
      ...card.evidence,
      makeEvidence("implementation_thread", outcome, action.summary ?? "Implementation completed.", card.activeClaim.threadId, action, outcome, now),
      makeEvidence("autopilot", "moved", "Moved from wip to testing.", card.activeClaim.threadId, action, "moved", now, "to-testing"),
    ],
  };
  return replaceCard(board, next);
}

function failThread(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.thread_failed" }>,
  outcome: ProductBoardEvidenceOutcome,
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  if (card.activeClaim === undefined || card.activeClaim.kind !== "implementation") {
    throw createRuntimeFailure("PROJECT_BOARD_NO_ACTIVE_IMPLEMENTATION", "Card has no active implementation thread.", {
      cardId: card.id,
    });
  }
  const now = action.actionTs;
  const next: ProductBoardCard = {
    ...card,
    lane: "planned",
    order: nextLaneOrder(board, "planned", card.id),
    activeClaim: undefined,
    updatedAt: now,
    threads: completeLinkedThread(card, "failed", now),
    evidence: [
      ...card.evidence,
      makeEvidence("implementation_thread", outcome, action.summary ?? "Implementation failed.", card.activeClaim.threadId, action, outcome, now),
      makeEvidence("autopilot", "moved", "Moved from wip to planned.", card.activeClaim.threadId, action, "moved", now, "to-planned"),
    ],
  };
  return replaceCard(board, next);
}

function stopThread(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.thread_stopped" }>,
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  if (card.activeClaim === undefined) {
    return board;
  }
  const now = action.actionTs;
  const next: ProductBoardCard = {
    ...card,
    lane: "planned",
    order: nextLaneOrder(board, "planned", card.id),
    activeClaim: undefined,
    updatedAt: now,
    threads: completeLinkedThread(card, "stopped", now),
    evidence: [
      ...card.evidence,
      makeEvidence("operator", "thread_stopped", action.summary ?? "Assigned thread stopped.", card.activeClaim.threadId, action, "thread_stopped", now),
    ],
  };
  return replaceCard(board, next);
}

function testingVerdict(
  board: ProductBoardSnapshot,
  action: Extract<ProductProjectBoardAction, { type: "board.card.testing_verdict" }>,
): ProductBoardSnapshot {
  const card = requireCard(board, action.cardId);
  if (card.activeClaim === undefined || card.activeClaim.kind !== "testing") {
    throw createRuntimeFailure("PROJECT_BOARD_NO_ACTIVE_TESTING", "Card has no active testing thread.", {
      cardId: card.id,
    });
  }
  if (action.testingVerdict !== "pass" && action.testingVerdict !== "fail") {
    throw createRuntimeFailure("PROJECT_BOARD_TESTING_VERDICT_INVALID", "Testing verdict must be pass or fail.", {
      cardId: card.id,
    });
  }
  const now = action.actionTs;
  const pass = action.testingVerdict === "pass";
  const next: ProductBoardCard = {
    ...card,
    lane: pass ? "done" : "planned",
    order: nextLaneOrder(board, pass ? "done" : "planned", card.id),
    activeClaim: undefined,
    updatedAt: now,
    threads: completeLinkedThread(card, pass ? "completed" : "failed", now),
    evidence: [
      ...card.evidence,
      makeEvidence("testing_thread", pass ? "verdict_pass" : "verdict_fail", action.summary ?? `Testing ${action.testingVerdict}.`, card.activeClaim.threadId, action, pass ? "verdict_pass" : "verdict_fail", now),
    ],
  };
  return replaceCard(board, next);
}

function validateMove(card: ProductBoardCard, targetLane: ProductBoardLane, source: ProductBoardEvidenceSource): void {
  if (source === "tool") {
    const allowed =
      (card.lane === "idea" && targetLane === "planned") ||
      (card.lane === "planned" && targetLane === "idea");
    if (!allowed) {
      throw createRuntimeFailure("PROJECT_BOARD_TOOL_MOVE_INVALID", "Card movement tool can only move idea <-> planned.", {
        cardId: card.id,
        sourceLane: card.lane,
        targetLane,
      });
    }
  }
}

function shouldStopAssignedThread(card: ProductBoardCard, targetLane: ProductBoardLane): boolean {
  return card.activeClaim !== undefined &&
    ((card.lane === "wip" || card.lane === "testing") &&
      (targetLane === "planned" || targetLane === "idea" || targetLane === "done"));
}

function completeLinkedThread(
  card: ProductBoardCard,
  status: "completed" | "failed" | "stopped",
  completedAt: string,
): ProductBoardCard["threads"] {
  return card.threads.map((thread) =>
    thread.threadId === card.activeClaim?.threadId
      ? { ...thread, status, completedAt }
      : thread,
  );
}

function replaceCard(board: ProductBoardSnapshot, card: ProductBoardCard): ProductBoardSnapshot {
  return bumpBoard({
    ...board,
    cards: {
      ...board.cards,
      [card.id]: card,
    },
  });
}

function bumpBoard(board: ProductBoardSnapshot): ProductBoardSnapshot {
  return {
    ...board,
    boardVersion: board.boardVersion + 1,
  };
}

function requireCard(board: ProductBoardSnapshot, cardId: string | undefined): ProductBoardCard {
  if (cardId === undefined || board.cards[cardId] === undefined) {
    throw createRuntimeFailure("PROJECT_BOARD_CARD_NOT_FOUND", "Card was not found.", {
      cardId,
    });
  }
  return board.cards[cardId] as ProductBoardCard;
}

function normalizeCard(cardId: string, value: unknown): ProductBoardCard | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.title !== "string" || typeof record.prompt !== "string") {
    return ;
  }
  const lane = readLane(record.lane);
  if (lane === undefined) {
    return ;
  }
  const now = LEGACY_BOARD_TIMESTAMP;
  return {
    id: typeof record.id === "string" ? record.id : cardId,
    title: record.title,
    prompt: record.prompt,
    lane,
    order: typeof record.order === "number" && Number.isFinite(record.order) ? record.order : 0,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
    ...(normalizeClaim(record.activeClaim) !== undefined ? { activeClaim: normalizeClaim(record.activeClaim) } : {}),
    threads: Array.isArray(record.threads)
      ? record.threads.map((entry, index) => normalizeThread(entry, index)).filter((entry): entry is ProductBoardCard["threads"][number] => entry !== undefined)
      : [],
    evidence: Array.isArray(record.evidence)
      ? record.evidence.map((entry, index) => normalizeEvidence(cardId, entry, index)).filter((entry): entry is ProductBoardEvidenceEntry => entry !== undefined)
      : [],
  };
}

function normalizeClaim(value: unknown): ProductBoardCard["activeClaim"] | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    typeof record.threadId !== "string" ||
    typeof record.sessionId !== "string" ||
    (record.kind !== "implementation" && record.kind !== "testing")
  ) {
    return ;
  }
  return {
    threadId: record.threadId,
    sessionId: record.sessionId,
    kind: record.kind,
    claimedAt: typeof record.claimedAt === "string" ? record.claimedAt : LEGACY_BOARD_TIMESTAMP,
    claimReason: record.claimReason === "copilot" ? "copilot" : "autopilot",
  };
}

function normalizeThread(value: unknown, _index: number): ProductBoardCard["threads"][number] | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    typeof record.threadId !== "string" ||
    typeof record.sessionId !== "string" ||
    (record.kind !== "implementation" && record.kind !== "testing")
  ) {
    return ;
  }
  return {
    threadId: record.threadId,
    sessionId: record.sessionId,
    kind: record.kind,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : LEGACY_BOARD_TIMESTAMP,
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    ...(record.status === "completed" || record.status === "failed" || record.status === "stopped"
      ? { status: record.status }
      : { status: "active" }),
  };
}

function normalizeEvidence(cardId: string, value: unknown, index: number): ProductBoardEvidenceEntry | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.summary !== "string") {
    return ;
  }
  return {
    id: typeof record.id === "string" ? record.id : buildLegacyEvidenceId(cardId, index, record.summary),
    timestamp: typeof record.timestamp === "string" ? record.timestamp : LEGACY_BOARD_TIMESTAMP,
    source: parseEvidenceSource(record.source),
    outcome: parseEvidenceOutcome(record.outcome),
    summary: record.summary,
    ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
  };
}

function makeEvidence(
  source: ProductBoardEvidenceSource,
  outcome: ProductBoardEvidenceOutcome,
  summary: string,
  threadId: string | undefined,
  action: ProductProjectBoardAction,
  suffix: string,
  timestamp = action.actionTs,
  detail = "",
): ProductBoardEvidenceEntry {
  return {
    id: buildEvidenceId(action, outcome, suffix, detail),
    timestamp,
    source,
    outcome,
    summary,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

function nextLaneOrder(board: ProductBoardSnapshot, lane: ProductBoardLane, excludeCardId?: string): number {
  const cards = sortedLaneCards(board, lane).filter((card) => card.id !== excludeCardId);
  return cards.length === 0 ? 0 : Math.max(...cards.map((card) => card.order)) + 1;
}

function sortedLaneCards(board: ProductBoardSnapshot, lane: ProductBoardLane): ProductBoardCard[] {
  return Object.values(board.cards)
    .filter((card) => card.lane === lane)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function readRequiredString(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw createRuntimeFailure("PROJECT_BOARD_FIELD_INVALID", `Card ${field} is required.`, { field });
  }
  return trimmed;
}

function parseLane(value: unknown): ProductBoardLane {
  const lane = readLane(value);
  if (lane !== undefined) {
    return lane;
  }
  throw createRuntimeFailure("PROJECT_BOARD_LANE_INVALID", "Board lane is invalid.", { lane: value });
}

function readLane(value: unknown): ProductBoardLane | undefined {
  return value === "idea" || value === "planned" || value === "wip" || value === "testing" || value === "done"
    ? value
    : undefined;
}

function parseEvidenceSource(value: unknown): ProductBoardEvidenceSource {
  return value === "autopilot" ||
    value === "copilot" ||
    value === "operator" ||
    value === "implementation_thread" ||
    value === "testing_thread" ||
    value === "tool"
    ? value
    : "operator";
}

function parseEvidenceOutcome(value: unknown): ProductBoardEvidenceOutcome {
  return value === "created" ||
    value === "updated" ||
    value === "moved" ||
    value === "deleted" ||
    value === "claimed" ||
    value === "claim_failed" ||
    value === "thread_started" ||
    value === "thread_stopped" ||
    value === "success" ||
    value === "failure" ||
    value === "manual_done" ||
    value === "verdict_pass" ||
    value === "verdict_fail"
    ? value
    : "updated";
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isNaN(Date.parse(value)) === false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function buildAutopilotThreadAction(
  action: Extract<ProductProjectBoardAction, { type: "board.autopilot.tick" }>,
  type: "board.card.start_implementation" | "board.card.start_testing",
  cardId: string,
): Extract<ProductProjectBoardAction, { type: "board.card.start_implementation" | "board.card.start_testing" }> {
  const suffix = type === "board.card.start_testing" ? "start-testing" : "start-implementation";
  return {
    type,
    sessionId: action.sessionId,
    actionId: `${action.actionId}:${suffix}:${cardId}`,
    actionTs: action.actionTs,
    cardId,
    source: "autopilot",
    ...(action.summary !== undefined ? { summary: action.summary } : {}),
  };
}

function buildAssignedThreadSessionId(
  projectSessionId: string,
  cardId: string,
  kind: "implementation" | "testing",
  actionId: string,
): string {
  return `${projectSessionId}:card:${cardId}:${kind}:${actionId}`;
}

function buildEvidenceId(
  action: ProductProjectBoardAction,
  outcome: ProductBoardEvidenceOutcome,
  suffix: string,
  detail: string,
): string {
  return `board-evidence:${hashString([action.type, action.sessionId, action.actionId, outcome, suffix, detail].join("|"))}`;
}

function buildLegacyEvidenceId(cardId: string, index: number, summary: string): string {
  return `board-evidence:${hashString([cardId, String(index), summary].join("|"))}`;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
