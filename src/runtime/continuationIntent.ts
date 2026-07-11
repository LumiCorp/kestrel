export interface ContinuationIntentDecision {
  approved: boolean;
  reason: "literal" | "phrase" | "affirmed_phrase" | "typo" | "rejected";
  matchedPhrase?: string | undefined;
}

const DIRECT_PHRASES = [
  "continue",
  "resume",
  "proceed",
  "go on",
  "keep going",
  "carry on",
] as const;

const AFFIRMATIONS = ["yes", "yeah", "yep", "ok", "okay", "sure", "please"] as const;

export function parseContinuationIntent(value: unknown): ContinuationIntentDecision {
  if (typeof value !== "string") {
    return { approved: false, reason: "rejected" };
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    return { approved: false, reason: "rejected" };
  }

  for (const phrase of DIRECT_PHRASES) {
    if (normalized === phrase || normalized.startsWith(`${phrase} `)) {
      return {
        approved: true,
        reason: phrase === "continue" ? "literal" : "phrase",
        matchedPhrase: phrase,
      };
    }
  }

  for (const affirmation of AFFIRMATIONS) {
    for (const phrase of DIRECT_PHRASES) {
      if (
        normalized === `${affirmation} ${phrase}` ||
        normalized.startsWith(`${affirmation} ${phrase} `)
      ) {
        return {
          approved: true,
          reason: "affirmed_phrase",
          matchedPhrase: phrase,
        };
      }
    }
  }

  const token = readSingleToken(normalized);
  if (token !== undefined) {
    for (const phrase of ["continue", "resume", "proceed"] as const) {
      if (editDistance(token, phrase) <= 2) {
        return {
          approved: true,
          reason: "typo",
          matchedPhrase: phrase,
        };
      }
    }
  }

  return { approved: false, reason: "rejected" };
}

function readSingleToken(value: string): string | undefined {
  if (/^[a-z]+$/u.test(value) === false) {
    return undefined;
  }
  return value;
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    table[row]![0] = row;
  }
  for (let col = 0; col < cols; col += 1) {
    table[0]![col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const substitutionCost = left[row - 1] === right[col - 1] ? 0 : 1;
      table[row]![col] = Math.min(
        table[row - 1]![col]! + 1,
        table[row]![col - 1]! + 1,
        table[row - 1]![col - 1]! + substitutionCost,
      );
    }
  }

  return table[rows - 1]![cols - 1]!;
}
