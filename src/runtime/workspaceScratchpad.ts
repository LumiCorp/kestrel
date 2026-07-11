import type { NormalizedOutput } from "../kestrel/contracts/execution.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";
import { readActiveTaskGoalFromTranscript } from "./modelTranscript.js";

export const WORKSPACE_SCRATCHPAD_RELATIVE_PATH = "workspaces";

const SECTION_ORDER = [
  "Goal",
  "Current Plan",
  "Facts",
  "Open Issues",
  "Next Actions",
  "Recent Decisions",
] as const;

type ScratchpadSectionName = (typeof SECTION_ORDER)[number];

const MAX_SECTION_ITEMS = 8;
const MAX_ITEM_CHARS = 240;

export interface ManagedScratchpad {
  goal?: string | undefined;
  currentPlan: string[];
  facts: string[];
  openIssues: string[];
  nextActions: string[];
  recentDecisions: string[];
}

export function parseManagedScratchpad(content: string): ManagedScratchpad {
  const normalized = content.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  const sections = createEmptyScratchpad();
  let currentSection: ScratchpadSectionName | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const section = parseSectionHeader(line);
    if (section !== undefined) {
      currentSection = section;
      continue;
    }
    if (currentSection === undefined || line.length === 0) {
      continue;
    }

    const normalizedLine = normalizeScratchpadLine(line);
    if (normalizedLine === undefined) {
      continue;
    }

    if (currentSection === "Goal") {
      sections.goal = normalizedLine;
      continue;
    }

    const target = sectionItems(sections, currentSection);
    if (target.length < MAX_SECTION_ITEMS && target.includes(normalizedLine) === false) {
      target.push(normalizedLine);
    }
  }

  return sections;
}

export function serializeManagedScratchpad(scratchpad: ManagedScratchpad): string {
  const normalized = normalizeManagedScratchpad(scratchpad);
  const lines: string[] = [];

  for (const section of SECTION_ORDER) {
    lines.push(`## ${section}`);
    if (section === "Goal") {
      lines.push(normalized.goal ?? "(none)");
    } else {
      const items = sectionItems(normalized, section);
      if (items.length === 0) {
        lines.push("- (none)");
      } else {
        for (const item of items) {
          lines.push(`- ${item}`);
        }
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function normalizeManagedScratchpad(scratchpad: ManagedScratchpad): ManagedScratchpad {
  return {
    ...(normalizeScratchpadLine(scratchpad.goal) !== undefined
      ? { goal: normalizeScratchpadLine(scratchpad.goal) }
      : {}),
    currentPlan: normalizeScratchpadItems(scratchpad.currentPlan),
    facts: normalizeScratchpadItems(scratchpad.facts),
    openIssues: normalizeScratchpadItems(scratchpad.openIssues),
    nextActions: normalizeScratchpadItems(scratchpad.nextActions),
    recentDecisions: normalizeScratchpadItems(scratchpad.recentDecisions),
  };
}

export function buildManagedScratchpadFromRuntime(input: {
  session?: SessionRecord | undefined;
  output: NormalizedOutput;
  operatorAffordance?: {
    recommendedAction?: { summary: string } | undefined;
  } | undefined;
}): ManagedScratchpad {
  const reactState = asRecord(input.session?.state.agent) ?? {};
  const plan = asRecord(reactState.plan);
  const wait = asRecord(reactState.wait);
  const waitMetadata = asRecord(wait?.metadata);
  const continuation = asRecord(reactState.continuation);
  const pendingContinuation = asRecord(continuation?.pendingContinuationRequest);
  const nextAction = asRecord(reactState.nextAction);
  const observations = Array.isArray(reactState.observations) ? reactState.observations : [];
  const recentFacts = observations
    .map((entry) => asString(asRecord(entry)?.summary))
    .filter((value): value is string => value !== undefined)
    .slice(-4)
    .reverse();
  const completedSoFar = readStringArray(waitMetadata?.completedSoFar ?? pendingContinuation?.completedSoFar);
  const nextIfApproved = readStringArray(waitMetadata?.nextIfApproved ?? pendingContinuation?.nextIfApproved);
  const successCriteria = readStringArray(plan?.successCriteria);
  const requiredCapabilities = readStringArray(reactState.requiredCapabilities).map(
    (value) => `Need capability '${value}'.`,
  );
  const decisionSummary = summarizeDecision(nextAction);
  const lastActionSummary = summarizeLastAction(asRecord(reactState.lastActionResult));
  const transcriptGoal = readActiveTaskGoalFromTranscript(reactState.modelTranscript);

  return normalizeManagedScratchpad({
    goal:
      transcriptGoal ??
      asString(plan?.intent) ??
      asString(asRecord(reactState.finalOutput)?.message) ??
      undefined,
    currentPlan: [
      ...successCriteria,
      ...nextIfApproved,
    ],
    facts: [
      ...completedSoFar,
      ...recentFacts,
      ...requiredCapabilities,
    ],
    openIssues: [
      asString(waitMetadata?.blockedOn),
      input.output.status === "FAILED" ? asString(input.output.errors[0]?.message) : undefined,
      input.output.status === "WAITING" ? asString(waitMetadata?.prompt) : undefined,
    ].filter((value): value is string => value !== undefined),
    nextActions: [
      ...nextIfApproved,
      input.operatorAffordance?.recommendedAction?.summary,
    ].filter((value): value is string => typeof value === "string"),
    recentDecisions: [
      decisionSummary,
      lastActionSummary,
    ].filter((value): value is string => value !== undefined),
  });
}

function createEmptyScratchpad(): ManagedScratchpad {
  return {
    currentPlan: [],
    facts: [],
    openIssues: [],
    nextActions: [],
    recentDecisions: [],
  };
}

function parseSectionHeader(line: string): ScratchpadSectionName | undefined {
  const normalized = line.replace(/^##\s+/u, "").trim();
  return SECTION_ORDER.find((section) => normalized === section);
}

function sectionItems(
  scratchpad: ManagedScratchpad,
  section: Exclude<ScratchpadSectionName, "Goal">,
): string[] {
  switch (section) {
    case "Current Plan":
      return scratchpad.currentPlan;
    case "Facts":
      return scratchpad.facts;
    case "Open Issues":
      return scratchpad.openIssues;
    case "Next Actions":
      return scratchpad.nextActions;
    case "Recent Decisions":
      return scratchpad.recentDecisions;
  }
}

function normalizeScratchpadItems(items: string[] | undefined): string[] {
  if (Array.isArray(items) === false) {
    return [];
  }
  const normalized: string[] = [];
  for (const item of items) {
    const next = normalizeScratchpadLine(item);
    if (next === undefined || normalized.includes(next)) {
      continue;
    }
    normalized.push(next);
    if (normalized.length >= MAX_SECTION_ITEMS) {
      break;
    }
  }
  return normalized;
}

function normalizeScratchpadLine(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .replace(/^[-*]\s+/u, "")
    .replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized === "(none)") {
    return undefined;
  }
  return normalized.length > MAX_ITEM_CHARS
    ? `${normalized.slice(0, MAX_ITEM_CHARS - 1).trimEnd()}...`
    : normalized;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => normalizeScratchpadLine(item))
        .filter((item): item is string => item !== undefined)
    : [];
}

function summarizeDecision(nextAction: Record<string, unknown> | undefined): string | undefined {
  if (nextAction === undefined) {
    return undefined;
  }
  const kind = asString(nextAction.kind);
  if (kind === undefined) {
    return undefined;
  }
  if (kind === "tool") {
    const name = asString(nextAction.name);
    return name !== undefined ? `Selected tool '${name}'.` : "Selected a tool action.";
  }
  if (kind === "tool_batch") {
    return "Selected a batched tool action.";
  }
  if (kind === "finalize") {
    return "Selected finalization.";
  }
  if (kind === "resolve_tool") {
    return "Deferred to tool resolution.";
  }
  return `Selected action '${kind}'.`;
}

function summarizeLastAction(lastAction: Record<string, unknown> | undefined): string | undefined {
  if (lastAction === undefined) {
    return undefined;
  }
  const kind = asString(lastAction.kind);
  const name = asString(lastAction.name);
  if (kind === "tool" && name !== undefined) {
    return summarizeFilesystemToolResult(name, lastAction) ?? `Ran tool '${name}'.`;
  }
  if (kind === "finalize") {
    return "Produced a final answer.";
  }
  return undefined;
}

function summarizeFilesystemToolResult(
  toolName: string,
  lastAction: Record<string, unknown>,
): string | undefined {
  if (toolName !== "fs.read_text" && toolName !== "fs.search_text" && toolName !== "fs.list") {
    return undefined;
  }
  const input = asRecord(lastAction.input);
  const output = asRecord(lastAction.output);
  if (toolName === "fs.read_text") {
    const targetPath = asString(output?.path) ?? asString(input?.path);
    const content = asString(output?.content);
    if (targetPath === undefined) {
      return "Ran fs.read_text.";
    }
    if (content === undefined) {
      return `Ran fs.read_text on ${targetPath}.`;
    }
    return `Ran fs.read_text on ${targetPath}: ${content}`;
  }
  if (toolName === "fs.search_text") {
    const targetPath = asString(output?.path) ?? asString(input?.path) ?? ".";
    const query = asString(output?.query) ?? asString(input?.query);
    const matches = Array.isArray(output?.matches) ? output.matches : [];
    const matchCount = typeof output?.matchCount === "number" && Number.isFinite(output.matchCount)
      ? Math.max(0, Math.trunc(output.matchCount))
      : matches.length;
    const firstMatch = asRecord(matches[0]);
    const firstPath = asString(firstMatch?.path);
    const firstPreview = asString(firstMatch?.preview);
    return [
      `Ran fs.search_text in ${targetPath}`,
      query !== undefined ? `for ${JSON.stringify(query)}` : undefined,
      `and found ${matchCount} match${matchCount === 1 ? "" : "es"}`,
      firstPath !== undefined ? `first at ${firstPath}` : undefined,
      firstPreview !== undefined ? `: ${firstPreview}` : ".",
    ].filter((item): item is string => item !== undefined).join(" ");
  }
  const targetPath = asString(output?.path) ?? asString(input?.path) ?? ".";
  const entries = Array.isArray(output?.entries) ? output.entries : [];
  return `Ran fs.list on ${targetPath} and found ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
