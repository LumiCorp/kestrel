export interface EditableTextInputRow {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export function buildEditableTextInputRows(input: {
  readonly text: string;
  readonly width: number;
}): EditableTextInputRow[] {
  const width = Math.max(1, Math.trunc(input.width));
  const logicalLines = input.text.replace(/\r\n/gu, "\n").split("\n");
  const rows: EditableTextInputRow[] = [];
  let offset = 0;

  for (const line of logicalLines) {
    rows.push(...wrapEditableLogicalLine(line, offset, width));
    offset += line.length + 1;
  }

  return rows.length > 0 ? rows : [{ text: "", startOffset: 0, endOffset: 0 }];
}

export function resolveTextInputVisibleRows(input: {
  readonly text: string;
  readonly width: number;
  readonly maxRows: number;
}): number {
  const maxRows = Math.max(1, Math.trunc(input.maxRows));
  return Math.min(maxRows, buildEditableTextInputRows({ text: input.text, width: input.width }).length);
}

export function buildVisibleEditableTextInputRows(input: {
  readonly text: string;
  readonly width: number;
  readonly maxRows: number;
  readonly cursorOffset: number;
}): EditableTextInputRow[] {
  const rows = buildEditableTextInputRows({ text: input.text, width: input.width });
  const maxRows = Math.max(1, Math.trunc(input.maxRows));
  if (rows.length <= maxRows) {
    return rows;
  }

  const cursorRowIndex = findCursorRowIndex(rows, input.cursorOffset);
  const start = Math.max(0, Math.min(cursorRowIndex - maxRows + 1, rows.length - maxRows));
  return rows.slice(start, start + maxRows);
}

function wrapEditableLogicalLine(
  line: string,
  lineStartOffset: number,
  width: number,
): EditableTextInputRow[] {
  if (line.length === 0) {
    return [{ text: "", startOffset: lineStartOffset, endOffset: lineStartOffset }];
  }

  const rows: EditableTextInputRow[] = [];
  let index = 0;

  while (index < line.length) {
    const remaining = line.length - index;
    if (remaining <= width) {
      rows.push({
        text: line.slice(index),
        startOffset: lineStartOffset + index,
        endOffset: lineStartOffset + line.length,
      });
      break;
    }

    const splitAt = findEditableSplitIndex(line, index, width);
    const visibleEnd = trimTrailingWhitespaceIndex(line, index, splitAt);
    rows.push({
      text: line.slice(index, visibleEnd),
      startOffset: lineStartOffset + index,
      endOffset: lineStartOffset + splitAt,
    });

    index = splitAt;
    while (index < line.length && isWhitespace(line[index] ?? "")) {
      index += 1;
    }
  }

  return rows;
}

function findEditableSplitIndex(line: string, start: number, width: number): number {
  const hardEnd = start + width;
  for (let index = hardEnd; index > start; index -= 1) {
    const char = line[index] ?? "";
    if (isWhitespace(char)) {
      return index;
    }
  }
  return hardEnd;
}

function trimTrailingWhitespaceIndex(line: string, start: number, end: number): number {
  let index = end;
  while (index > start && isWhitespace(line[index - 1] ?? "")) {
    index -= 1;
  }
  return index;
}

function findCursorRowIndex(rows: readonly EditableTextInputRow[], cursorOffset: number): number {
  const boundedCursor = Math.max(0, cursorOffset);
  const exact = rows.findIndex((row, index) => {
    const nextRow = rows[index + 1];
    return (
      boundedCursor >= row.startOffset &&
      (boundedCursor < row.endOffset || (boundedCursor === row.endOffset && nextRow?.startOffset !== boundedCursor))
    );
  });
  return exact >= 0 ? exact : rows.length - 1;
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}
