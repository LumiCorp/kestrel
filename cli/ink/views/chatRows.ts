import type { TranscriptLine, ViewScrollState } from "../../contracts.js";

const CHAT_MIN_CONTENT_WIDTH = 24;
const CHAT_PREFIX_GUTTER = 10;
const CHAT_HEADER_AND_BASE_SPACER_ROWS = 2;
const ASSISTANT_EXTRA_SPACER_ROWS = 1;

export interface ChatVisualRow {
  role: TranscriptLine["role"];
  text: string;
  transcriptIndex: number;
  wrappedLineIndex: number;
  isFirstLine: boolean;
  reasoning: boolean;
  attention: boolean;
  timestamp: string;
  run?: TranscriptLine["run"] | undefined;
}

export interface ChatVisualAnchor {
  transcriptIndex: number;
  wrappedLineIndex: number;
}

export function buildAnchoredAppendScroll(input: {
  previousVisualCount: number;
  droppedVisualCount: number;
  nextVisualCount: number;
  listRows: number;
}): ViewScrollState {
  const boundedWindow = Math.max(1, Math.trunc(input.listRows));
  const retainedVisualCount = Math.max(0, input.previousVisualCount - input.droppedVisualCount);
  const anchorCursor =
    retainedVisualCount > 0 ? retainedVisualCount - 1 : Math.max(0, input.nextVisualCount - 1);
  const maxOffset = Math.max(0, input.nextVisualCount - boundedWindow);
  return {
    offset: Math.min(anchorCursor, maxOffset),
    cursor: anchorCursor,
    tailLocked: false,
  };
}

export function buildTranscriptStartScroll(input: {
  rows: ChatVisualRow[];
  transcriptIndex: number;
  listRows: number;
}): ViewScrollState | undefined {
  const rowIndex = input.rows.findIndex(
    (row) => row.transcriptIndex === input.transcriptIndex && row.isFirstLine,
  );
  if (rowIndex < 0) {
    return ;
  }

  const boundedWindow = Math.max(1, Math.trunc(input.listRows));
  const maxOffset = Math.max(0, input.rows.length - boundedWindow);
  return {
    offset: Math.min(rowIndex, maxOffset),
    cursor: rowIndex,
    tailLocked: false,
  };
}

export function deriveChatContentWidth(viewportColumns: number): number {
  return Math.max(CHAT_MIN_CONTENT_WIDTH, Math.trunc(viewportColumns) - CHAT_PREFIX_GUTTER);
}

export function buildChatVisualRows(
  transcript: TranscriptLine[],
  viewportColumns: number,
): ChatVisualRow[] {
  const width = deriveChatContentWidth(viewportColumns);
  const rows: ChatVisualRow[] = [];

  for (let transcriptIndex = 0; transcriptIndex < transcript.length; transcriptIndex += 1) {
    const line = transcript[transcriptIndex];
    if (line === undefined) {
      continue;
    }
    const attention = line.role === "system" && line.data?.waitEventType === "user.reply";
    const wrapped = wrapTextToWidth(line.text, width);
    if (wrapped.length === 0) {
      rows.push({
        role: line.role,
        text: "",
        transcriptIndex,
        wrappedLineIndex: 0,
        isFirstLine: true,
        reasoning: line.data?.reasoning === true,
        attention,
        timestamp: line.timestamp,
        ...(line.run !== undefined ? { run: line.run } : {}),
      });
      continue;
    }

    for (let wrappedLineIndex = 0; wrappedLineIndex < wrapped.length; wrappedLineIndex += 1) {
      const text = wrapped[wrappedLineIndex] ?? "";
      rows.push({
        role: line.role,
        text,
        transcriptIndex,
        wrappedLineIndex,
        isFirstLine: wrappedLineIndex === 0,
        reasoning: line.data?.reasoning === true,
        attention,
        timestamp: line.timestamp,
        ...(line.run !== undefined ? { run: line.run } : {}),
      });
    }
  }

  return rows;
}

export function countChatVisualRows(
  transcript: TranscriptLine[],
  viewportColumns: number,
): number {
  return buildChatVisualRows(transcript, viewportColumns).length;
}

export function countRenderedChatRows(rows: ChatVisualRow[]): number {
  if (rows.length === 0) {
    return 0;
  }

  let renderedRows = 0;
  let previousTranscriptIndex = -1;

  for (const row of rows) {
    renderedRows += 1;
    if (row.transcriptIndex !== previousTranscriptIndex) {
      renderedRows += messageOverheadRows(row.role);
      previousTranscriptIndex = row.transcriptIndex;
    }
  }

  return renderedRows;
}

export function ensureChatCursorVisible(
  rows: ChatVisualRow[],
  scroll: ViewScrollState,
  listRows: number,
): ViewScrollState {
  if (rows.length === 0) {
    return {
      offset: 0,
      cursor: 0,
      tailLocked: scroll.tailLocked,
    };
  }

  const boundedWindow = Math.max(1, Math.trunc(listRows));
  const cursor = Math.max(0, Math.min(scroll.cursor, rows.length - 1));
  let offset = Math.max(0, Math.min(scroll.offset, cursor));
  let end = computeChatWindowEnd(rows, offset, boundedWindow);

  while (cursor >= end && offset < rows.length - 1) {
    offset += 1;
    end = computeChatWindowEnd(rows, offset, boundedWindow);
  }

  return {
    offset,
    cursor,
    tailLocked: scroll.tailLocked,
  };
}

export function buildChatWindow(
  rows: ChatVisualRow[],
  scroll: ViewScrollState,
  listRows: number,
): {
  items: ChatVisualRow[];
  start: number;
  end: number;
  scroll: ViewScrollState;
} {
  const normalized = ensureChatCursorVisible(rows, scroll, listRows);
  const start = normalized.offset;
  const end = computeChatWindowEnd(rows, start, listRows);

  return {
    items: rows.slice(start, end),
    start,
    end,
    scroll: normalized,
  };
}

export function resolveChatVisualAnchor(
  rows: ChatVisualRow[],
  cursor: number,
): ChatVisualAnchor | undefined {
  if (rows.length === 0) {
    return ;
  }
  const bounded = Math.max(0, Math.min(cursor, rows.length - 1));
  const row = rows[bounded];
  if (row === undefined) {
    return ;
  }
  return {
    transcriptIndex: row.transcriptIndex,
    wrappedLineIndex: row.wrappedLineIndex,
  };
}

export function resolveChatVisualCursorFromAnchor(
  rows: ChatVisualRow[],
  anchor: ChatVisualAnchor | undefined,
): number {
  if (rows.length === 0) {
    return 0;
  }
  if (anchor === undefined) {
    return rows.length - 1;
  }

  const exact = rows.findIndex(
    (row) =>
      row.transcriptIndex === anchor.transcriptIndex &&
      row.wrappedLineIndex === anchor.wrappedLineIndex,
  );
  if (exact >= 0) {
    return exact;
  }

  const sameTranscript = rows.findIndex(
    (row) => row.transcriptIndex === anchor.transcriptIndex && row.isFirstLine,
  );
  if (sameTranscript >= 0) {
    return sameTranscript;
  }

  const nextTranscript = rows.findIndex((row) => row.transcriptIndex > anchor.transcriptIndex);
  if (nextTranscript >= 0) {
    return nextTranscript;
  }

  return rows.length - 1;
}

export function wrapTextToWidth(input: string, width: number): string[] {
  const bounded = Math.max(1, Math.trunc(width));
  const normalized = input.replace(/\r\n/gu, "\n");
  const logicalLines = normalized.split("\n");
  const rows: string[] = [];

  for (const logicalLine of logicalLines) {
    rows.push(...wrapLogicalLine(logicalLine, bounded));
  }

  return rows.length > 0 ? rows : [""];
}

function wrapLogicalLine(line: string, width: number): string[] {
  if (line.length === 0) {
    return [""];
  }

  const rows: string[] = [];
  let remaining = line;

  while (remaining.length > width) {
    const splitAt = findSplitIndex(remaining, width);
    const head = remaining.slice(0, splitAt).trimEnd();
    rows.push(head.length > 0 ? head : remaining.slice(0, width));
    remaining = remaining.slice(splitAt).replace(/^\s+/u, "");
  }

  rows.push(remaining);
  return rows;
}

function computeChatWindowEnd(
  rows: ChatVisualRow[],
  start: number,
  listRows: number,
): number {
  const boundedWindow = Math.max(1, Math.trunc(listRows));
  let end = Math.max(0, Math.min(start, rows.length));
  let renderedRows = 0;
  let previousTranscriptIndex = -1;

  while (end < rows.length) {
    const row = rows[end];
    if (row === undefined) {
      break;
    }

    const nextRenderedRows =
      renderedRows + 1 + (row.transcriptIndex !== previousTranscriptIndex ? messageOverheadRows(row.role) : 0);
    if (end > start && nextRenderedRows > boundedWindow) {
      break;
    }

    renderedRows = nextRenderedRows;
    previousTranscriptIndex = row.transcriptIndex;
    end += 1;
  }

  return Math.max(start, end);
}

function messageOverheadRows(role: ChatVisualRow["role"]): number {
  return role === "assistant"
    ? CHAT_HEADER_AND_BASE_SPACER_ROWS + ASSISTANT_EXTRA_SPACER_ROWS
    : CHAT_HEADER_AND_BASE_SPACER_ROWS;
}

function findSplitIndex(value: string, width: number): number {
  const max = Math.min(width, value.length);
  const minAcceptable = Math.max(1, Math.floor(max * 0.6));
  for (let index = max; index > 0; index -= 1) {
    const char = value[index - 1];
    if (char !== undefined && /\s/u.test(char) && index >= minAcceptable) {
      return index;
    }
  }
  return max;
}
