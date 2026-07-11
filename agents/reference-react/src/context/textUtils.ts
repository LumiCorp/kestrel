import { createHash } from "node:crypto";

import { asRecord, asString } from "../../../shared/valueAccess.js";

export function clampHistoryByChars(history: unknown[], maxChars: number): unknown[] {
  const result: unknown[] = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const line = history[index];
    const text = asString(asRecord(line)?.text) ?? "";
    const size = text.length;
    if (result.length > 0 && used + size > maxChars) {
      break;
    }
    used += size;
    result.unshift(line);
  }
  return result;
}

export function preserveInitialUserHistoryLine(history: unknown[], limit: number): unknown[] {
  if (history.length <= limit) {
    return history;
  }
  const recent = history.slice(-limit);
  const firstUser = history.find((line) => asString(asRecord(line)?.role) === "user");
  if (
    firstUser === undefined ||
    recent.some((line) => line === firstUser)
  ) {
    return recent;
  }
  return [firstUser, ...history.slice(-(limit - 1))];
}

export function stableObjectHash(value: unknown): string {
  const serialized = stableStringify(value);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}

export function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isFinite(value) === false || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function clampText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function clampRawText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = "\n... [latest output clipped] ...\n";
  if (maxChars <= marker.length + 20) {
    return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
  }
  const available = maxChars - marker.length;
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${value.slice(0, headChars)}${marker}${value.slice(Math.max(0, value.length - tailChars))}`;
}

export function clampLoopStateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const lines = value.split(/\r?\n/u);
  const heading = lines[0]?.endsWith(":") === true ? lines[0] : undefined;
  const body = (heading === undefined ? value : lines.slice(1).join(" ")).replace(/\s+/gu, " ").trim();
  const headingBudget = heading === undefined ? 0 : heading.length + 1;
  const selected = selectImportantLoopStateSentences(body, Math.max(80, maxChars - headingBudget));
  const withHeading = heading === undefined ? selected : `${heading}\n${selected}`;
  if (withHeading.length <= maxChars) {
    return withHeading;
  }
  return clampAtWordBoundary(withHeading, maxChars);
}

function selectImportantLoopStateSentences(body: string, maxChars: number): string {
  const sentences = splitLoopStateSentences(body);
  if (sentences.length <= 2) {
    return body;
  }
  const selected = new Set<number>([0, sentences.length - 1]);
  const important = /\b(premature|verify|verification|blocked|missing|unverified|next turn)\b/iu;
  const importantIndices: number[] = [];
  sentences.forEach((sentence, index) => {
    if (important.test(sentence)) {
      importantIndices.push(index);
    }
  });
  for (const index of importantIndices) {
    selected.add(index);
    const rendered = renderSelectedLoopStateSentences(sentences, selected);
    if (rendered.length > maxChars) {
      selected.delete(index);
    }
  }
  return renderSelectedLoopStateSentences(sentences, selected);
}

function renderSelectedLoopStateSentences(sentences: string[], selected: Set<number>): string {
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => sentences[index])
    .filter((sentence): sentence is string => sentence !== undefined && sentence.length > 0)
    .join(" ... ");
}

export function splitLoopStateSentences(value: string): string[] {
  return value
    .match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/gu)
    ?.map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0) ?? [value];
}

export function clampAtWordBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = " ... [loop state clipped]";
  const budget = Math.max(0, maxChars - marker.length);
  const prefix = value.slice(0, budget);
  const boundary = prefix.search(/\s+\S*$/u);
  const clipped = boundary > 80 ? prefix.slice(0, boundary) : prefix;
  return `${clipped.trimEnd()}${marker}`;
}

export function clampTaskText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return clampRawText(normalized, maxChars);
}

export function summarizeValue(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(sortValue(value));
    if (serialized.length <= maxChars) {
      return serialized;
    }
    return `${serialized.slice(0, Math.max(0, maxChars - 3))}...`;
  } catch {
    return String(value).slice(0, maxChars);
  }
}

export function estimateSerializedLength(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}
