import type { TranscriptLine } from "../contracts.js";

export function clampIndex(value: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value >= length) {
    return length - 1;
  }
  return value;
}

export function summarizePreview(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function dataHasArtifacts(
  data: Record<string, unknown> | undefined,
): boolean {
  if (data === undefined) {
    return false;
  }
  const ui = data.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    return false;
  }
  const artifacts = (ui as Record<string, unknown>).artifacts;
  return Array.isArray(artifacts) && artifacts.length > 0;
}

export function splitTranscriptMessage(
  role: TranscriptLine["role"],
  text: string,
): string[] {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (role !== "system") {
    return [normalized];
  }

  if (normalized.length <= 420 && normalized.includes("\n") === false) {
    return [normalized];
  }

  const lines = normalized.split("\n");
  const maxLinesPerSegment = 10;
  const maxCharsPerSegment = 420;
  const segments: string[] = [];
  let buffer: string[] = [];
  let bufferChars = 0;

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    segments.push(buffer.join("\n"));
    buffer = [];
    bufferChars = 0;
  };

  for (const line of lines) {
    if (line.length > maxCharsPerSegment) {
      flush();
      segments.push(...chunkLongLine(line, maxCharsPerSegment));
      continue;
    }

    const nextChars = bufferChars + line.length + (buffer.length > 0 ? 1 : 0);
    if (buffer.length >= maxLinesPerSegment || nextChars > maxCharsPerSegment) {
      flush();
    }

    buffer.push(line);
    bufferChars += line.length + (buffer.length > 1 ? 1 : 0);
  }

  flush();
  return segments.length > 0 ? segments : [normalized];
}

export function stripMcpSummary(statusLine: string): string {
  const marker = " | mcp:";
  const index = statusLine.indexOf(marker);
  if (index < 0) {
    return statusLine;
  }
  return statusLine.slice(0, index);
}

function chunkLongLine(value: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    chunks.push(value.slice(start, start + maxChars));
    start += maxChars;
  }
  return chunks;
}
