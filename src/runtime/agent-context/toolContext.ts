import type {
  AgentToolModelContext,
  ModelToolSpec,
} from "../../kestrel/contracts/model-io.js";
import { normalizeDevShellLifecycle } from "../devshellLifecycle.js";
import { sanitizeJsonValue, stringifySanitizedJson } from "../jsonSanitizer.js";
import { VISIBLE_TODOS_SCHEMA } from "../visibleTodos.js";

export type KestrelAgentToolActionKind = "workspace" | "control";

export interface KestrelAgentToolAliasEntry {
  providerName: string;
  canonicalName: string;
  inputSchema: Record<string, unknown>;
  description: string;
  kind: KestrelAgentToolActionKind;
}

export interface KestrelAgentToolAliasRegistry {
  requestTools: ModelToolSpec[];
  entries: KestrelAgentToolAliasEntry[];
  byProviderName: Map<string, KestrelAgentToolAliasEntry>;
}

export interface KestrelAgentToolSurfaceInput {
  workspaceTools: ModelToolSpec[];
  controlToolNames?: readonly string[] | undefined;
  finalizeStatuses?: readonly KestrelAgentFinalizeStatus[] | undefined;
  cannotSatisfyReasonCodes?: readonly KestrelAgentCannotSatisfyReasonCode[] | undefined;
}

export type KestrelAgentToolResultStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "inconclusive"
  | "running";

export interface KestrelAgentToolResultSummaryInput {
  toolName: string;
  toolInput?: Record<string, unknown> | undefined;
  toolOutput?: Record<string, unknown> | undefined;
  status: KestrelAgentToolResultStatus | string;
}

export interface KestrelAgentToolModelContextInput {
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  rawOutputRef: string;
  status: "OK" | "FAILED";
  error?: unknown | undefined;
}

export type KestrelAgentFinalizeStatus = "goal_satisfied" | "out_of_scope";

export type KestrelAgentCannotSatisfyReasonCode =
  | "unsatisfied_by_available_tools"
  | "insufficient_horizon"
  | "missing_required_capability"
  | "need_user_choice"
  | "requested_tool_unavailable";

const MODEL_CONTEXT_TEXT_LIMIT = 12_000;
const GENERIC_VALUE_PREVIEW_CHARS = 2000;
const READ_TEXT_CONTENT_LIMIT = 10_000;
const LIST_ENTRY_LIMIT = 80;
const SEARCH_MATCH_LIMIT = 40;
const WEATHER_DAILY_ENTRY_LIMIT = 10;
const WEATHER_HOURLY_ENTRY_LIMIT = 12;

const CONTROL_TOOLS: ModelToolSpec[] = [
  {
    name: "kestrel.finalize",
    description: "Finish the run with a user-facing answer. For code or artifact changes, use status goal_satisfied only after the final edited state was checked after the last relevant mutation, the main requested result passed, every explicit task constraint was checked, and any identified existing test/assertion or behavior check passed. A proxy check, build, test, or command exit code is not enough when the task names a specific final output, command, API/function call, score, ranking, artifact, format, allowed edit scope, preserved behavior, or content constraint. Final messages may claim only checks actually observed after the last relevant mutation, including constraints and existing behavior checks. If validation passed but a remaining check was not directly exercised, report that as a residual risk in the message and data.openGap or data.knownWarnings; do not leave the related visible todo open unless actionable work remains. If validation was inconclusive, failed, or could not run, keep working or report the blocker instead.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["goal_satisfied", "out_of_scope"] },
        message: { type: "string", minLength: 1 },
        data: { type: "object" },
      },
      required: ["status", "message"],
    },
  },
  {
    name: "kestrel.ask_user",
    description: "Ask the user a concise clarification or approval question.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1 },
      },
      required: ["prompt"],
    },
  },
  {
    name: "kestrel.cannot_satisfy",
    description: "Report a concrete blocker that prevents progress. Do not use this because work is unfinished, checks are still failing, or more tool steps are needed; in build mode, continue with tools or ask the user unless a concrete external blocker prevents progress.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasonCode: {
          type: "string",
          enum: [
            "unsatisfied_by_available_tools",
            "insufficient_horizon",
            "missing_required_capability",
            "need_user_choice",
            "requested_tool_unavailable",
          ],
        },
        message: { type: "string", minLength: 1 },
        details: { type: "object" },
      },
      required: ["reasonCode", "message"],
    },
  },
  {
    name: "kestrel.handoff_to_build",
    description: "Hand off a completed plan-mode task into build mode.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string", minLength: 1 },
        continuation: {
          type: "object",
          additionalProperties: false,
          properties: {
            objective: { type: "string", minLength: 1 },
            requiredToolClass: {
              type: "string",
              enum: ["read_only", "planning_write", "sandboxed_only", "external_side_effect"],
            },
            requiredCapabilities: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            resumeMessage: { type: "string", minLength: 1 },
          },
          required: ["objective", "requiredToolClass", "requiredCapabilities"],
        },
        data: { type: "object" },
      },
      required: ["message", "continuation"],
    },
  },
  {
    name: "kestrel.todo_update",
    description: "Update the visible live checklist for multi-step work. Emit this update alongside the related executable action instead of spending a separate turn on bookkeeping. After successful validation, emit completed checklist updates together with kestrel.finalize in the same decision. Use a standalone checklist update only when waiting or blocked and no executable or terminal action can accompany it. Track objective, concrete work items, item statuses, planned checks, observed results, and blockers. For file or artifact changes, keep a check-work item open until the final state is reviewed after the last mutation. Mark items complete only after the corresponding work or check has been observed. When validation passed and the remaining issue is only a documented residual risk, mark the item done with a note and report the risk through kestrel.finalize data.openGap or data.knownWarnings. Detailed closeout requirements live in kestrel.finalize.",
    inputSchema: VISIBLE_TODOS_SCHEMA,
  },
];

export function buildKestrelAgentToolSurface(
  input: KestrelAgentToolSurfaceInput,
): KestrelAgentToolAliasRegistry {
  const allowedControlToolNames = input.controlToolNames === undefined
    ? undefined
    : new Set(input.controlToolNames);
  const controlTools = buildControlToolsForSurface(input);
  const workspaceTools = input.workspaceTools.filter((tool) =>
    tool.name.startsWith("dev.shell.") === false
  );
  const entries = [
    ...workspaceTools.map((tool) => toToolAliasEntry(tool, "workspace" as const)),
    ...controlTools
      .filter((tool) => allowedControlToolNames === undefined || allowedControlToolNames.has(tool.name))
      .map((tool) => toToolAliasEntry(tool, "control" as const)),
  ].map(withAgentProgressContract);
  const byProviderName = new Map<string, KestrelAgentToolAliasEntry>();
  for (const entry of entries) {
    const existing = byProviderName.get(entry.providerName);
    if (existing !== undefined && existing.canonicalName !== entry.canonicalName) {
      throw new Error([
        "Provider tool alias collision.",
        `providerName=${entry.providerName}`,
        `firstCanonicalName=${existing.canonicalName}`,
        `secondCanonicalName=${entry.canonicalName}`,
      ].join(" "));
    }
    byProviderName.set(entry.providerName, entry);
  }
  return {
    entries,
    byProviderName,
    requestTools: entries.map((entry) => ({
      name: entry.providerName,
      description: entry.description,
      inputSchema: entry.inputSchema,
    })),
  };
}

function withAgentProgressContract(
  entry: KestrelAgentToolAliasEntry,
): KestrelAgentToolAliasEntry {
  if (
    entry.canonicalName === "kestrel.finalize" ||
    entry.canonicalName === "kestrel.ask_user" ||
    entry.canonicalName === "kestrel.cannot_satisfy"
  ) {
    return entry;
  }
  return {
    ...entry,
    description: `${entry.description} Include assistantProgress: one concise sentence describing the accepted action to the user; do not mention internal steps, routing, commits, or model calls.`,
    inputSchema: addAgentProgressToActionSchema(entry.inputSchema),
  };
}

const AGENT_PROGRESS_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 600,
  description: "One concise user-facing progress sentence for this action. It is shown only after the action is accepted and committed.",
} as const;

function addAgentProgressToActionSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = asRecord(schema.properties) ?? {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...schema,
    type: "object",
    properties: {
      ...properties,
      assistantProgress: AGENT_PROGRESS_SCHEMA,
    },
    required: [...new Set([...required, "assistantProgress"])],
    ...augmentTopLevelActionAlternatives(schema, "oneOf"),
    ...augmentTopLevelActionAlternatives(schema, "anyOf"),
    ...augmentTopLevelActionAlternatives(schema, "allOf"),
  };
}

function augmentTopLevelActionAlternatives(
  schema: Record<string, unknown>,
  key: "oneOf" | "anyOf" | "allOf",
): Record<string, unknown> {
  const alternatives = schema[key];
  if (!Array.isArray(alternatives)) {
    return {};
  }
  return {
    [key]: alternatives.map((alternative) => {
      const branch = asRecord(alternative);
      return branch === undefined ? alternative : addAgentProgressToActionSchema(branch);
    }),
  };
}

function buildControlToolsForSurface(input: KestrelAgentToolSurfaceInput): ModelToolSpec[] {
  let controlTools = CONTROL_TOOLS;
  const finalizeStatuses = input.finalizeStatuses;
  if (finalizeStatuses !== undefined) {
    const allowedStatuses = [...new Set(finalizeStatuses)]
      .filter((status): status is KestrelAgentFinalizeStatus =>
        status === "goal_satisfied" || status === "out_of_scope"
      );
    if (allowedStatuses.length > 0) {
      controlTools = controlTools.map((tool) => {
        if (tool.name !== "kestrel.finalize") {
          return tool;
        }
        return {
          ...tool,
          description: tool.description,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...(asRecord(tool.inputSchema.properties) ?? {}),
              status: { type: "string", enum: allowedStatuses },
            },
          },
        };
      });
    }
  }
  const cannotSatisfyReasonCodes = input.cannotSatisfyReasonCodes;
  if (cannotSatisfyReasonCodes !== undefined) {
    const allowedReasonCodes = [...new Set(cannotSatisfyReasonCodes)]
      .filter((reasonCode): reasonCode is KestrelAgentCannotSatisfyReasonCode =>
        reasonCode === "unsatisfied_by_available_tools" ||
        reasonCode === "insufficient_horizon" ||
        reasonCode === "missing_required_capability" ||
        reasonCode === "need_user_choice" ||
        reasonCode === "requested_tool_unavailable"
      );
    if (allowedReasonCodes.length > 0) {
      controlTools = controlTools.map((tool) => {
        if (tool.name !== "kestrel.cannot_satisfy") {
          return tool;
        }
        return {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...(asRecord(tool.inputSchema.properties) ?? {}),
              reasonCode: { type: "string", enum: allowedReasonCodes },
            },
          },
        };
      });
    }
  }
  return controlTools;
}

export function providerToolAliasForCanonicalName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

export function buildKestrelAgentToolResultSummary(
  input: KestrelAgentToolResultSummaryInput,
): string {
  const output = input.toolOutput;
  if (input.toolName === "fs.list" && Array.isArray(output?.entries)) {
    const count = asArray(output.entries).length;
    const message = asString(output.message);
    if (count === 0 && message !== undefined && message.trim().length > 0) {
      return clampModelVisibleText(message.replace(/\s+/gu, " "), 360);
    }
    return `fs.list returned ${count} ${count === 1 ? "entry" : "entries"}.`;
  }
  if (input.toolName === "fs.search_text" && Array.isArray(output?.matches)) {
    const count = typeof output.matchCount === "number" && Number.isFinite(output.matchCount)
      ? Math.max(0, Math.trunc(output.matchCount))
      : asArray(output.matches).length;
    const path = asString(output.path);
    const query = asString(output.query);
    return [
      `fs.search_text${path !== undefined ? ` ${path}` : ""}${query !== undefined ? ` for ${JSON.stringify(query)}` : ""}`,
      `returned ${count} match${count === 1 ? "" : "es"}.`,
    ].join(" ");
  }
  if (input.toolName === "fs.replace_text") {
    const replacements = typeof output?.replacements === "number" && Number.isFinite(output.replacements)
      ? Math.max(0, Math.trunc(output.replacements))
      : undefined;
    const changed = typeof output?.changed === "boolean" ? output.changed : undefined;
    const find = asString(input.toolInput?.find);
    const replace = asString(input.toolInput?.replace);
    const tokenDelta = typeof output?.whitespaceTokenCountDelta === "number" && Number.isFinite(output.whitespaceTokenCountDelta)
      ? Math.trunc(output.whitespaceTokenCountDelta)
      : undefined;
    const lineDelta = typeof output?.lineCountDelta === "number" && Number.isFinite(output.lineCountDelta)
      ? Math.trunc(output.lineCountDelta)
      : undefined;
    if (replacements !== undefined || changed !== undefined) {
      const deltas = [
        tokenDelta !== undefined && tokenDelta !== 0 ? `token delta ${formatSignedNumber(tokenDelta)}` : undefined,
        lineDelta !== undefined && lineDelta !== 0 ? `line delta ${formatSignedNumber(lineDelta)}` : undefined,
      ].filter((item): item is string => item !== undefined);
      return [
        "fs.replace_text",
        find !== undefined || replace !== undefined
          ? `${JSON.stringify(find ?? "")} -> ${JSON.stringify(replace ?? "")}`
          : changed === false ? "made no changes" : "changed text",
        replacements !== undefined ? `(${replacements} replacement${replacements === 1 ? "" : "s"}${deltas.length > 0 ? `, ${deltas.join(", ")}` : ""})` : undefined,
      ].filter((item): item is string => item !== undefined).join(" ") + ".";
    }
  }
  if (input.toolName === "fs.write_text") {
    const path = asString(output?.path);
    const mode = asString(output?.mode);
    const bytes = typeof output?.bytesWritten === "number" && Number.isFinite(output.bytesWritten)
      ? Math.max(0, Math.trunc(output.bytesWritten))
      : undefined;
    const existed = typeof output?.existed === "boolean" ? output.existed : undefined;
    const tokenDelta = numberDelta(output?.whitespaceTokenCountBefore, output?.whitespaceTokenCountAfter);
    const lineDelta = numberDelta(output?.lineCountBefore, output?.lineCountAfter);
    if (mode === "overwrite" && existed === true) {
      const deltas = [
        tokenDelta !== undefined ? `token delta ${formatSignedNumber(tokenDelta)}` : undefined,
        lineDelta !== undefined ? `line delta ${formatSignedNumber(lineDelta)}` : undefined,
      ].filter((item): item is string => item !== undefined);
      return [
        "fs.write_text overwrote existing file",
        path !== undefined ? path : undefined,
        bytes !== undefined ? `with ${bytes} bytes` : undefined,
        deltas.length > 0 ? `(${deltas.join(", ")})` : undefined,
      ].filter((item): item is string => item !== undefined).join(" ") + ".";
    }
    return `fs.write_text wrote${bytes !== undefined ? ` ${bytes} bytes` : ""}${path !== undefined ? ` to ${path}` : ""}${mode !== undefined ? ` (${mode})` : ""}.`;
  }
  const explicit =
    asString(output?.summary) ??
    asString(output?.message) ??
    asString(output?.error) ??
    asString(output?.text) ??
    asString(output?.stdout) ??
    asString(output?.chunk);
  if (explicit !== undefined && explicit.trim().length > 0) {
    return clampModelVisibleText(explicit.replace(/\s+/gu, " "), 360);
  }
  return `${input.toolName} produced ${input.status} evidence.`;
}

export function buildKestrelAgentToolModelContext(
  input: KestrelAgentToolModelContextInput,
): AgentToolModelContext {
  const bodyLines = [
    `Tool result: ${input.toolName}`,
    "",
    ...renderToolFacts(input.toolName, input.toolInput, input.toolOutput, input.status, input.error),
  ];
  const refLine = `Raw output ref: ${input.rawOutputRef}`;
  const suffixBudget = refLine.length + 64;
  const clipped = clipText(bodyLines.join("\n"), Math.max(500, MODEL_CONTEXT_TEXT_LIMIT - suffixBudget));
  const text = [
    clipped.text,
    "",
    ...(clipped.truncated ? ["[model context clipped; full output is in the audit record]"] : []),
    refLine,
  ].join("\n");
  return {
    text,
    rawOutputRef: input.rawOutputRef,
    truncated: clipped.truncated,
  };
}

function renderToolFacts(
  toolName: string,
  input: unknown,
  output: unknown,
  status: "OK" | "FAILED",
  error: unknown,
): string[] {
  const record = asRecord(output);
  if (record === undefined) {
    return renderGenericFacts(output, status, error);
  }
  if (toolName.startsWith("fs.")) {
    return renderFilesystemFacts(toolName, input, record, status, error);
  }
  if (toolName === "repo.trace") {
    return renderRepoTraceFacts(record, status, error);
  }
  if (normalizeDevShellLifecycle(toolName, input, record) !== undefined) {
    return renderDevShellFacts(toolName, input, record, status, error);
  }
  if (toolName.startsWith("internet.")) {
    return renderInternetFacts(toolName, record, status, error);
  }
  if (toolName === "free.weather.current" || toolName === "free.weather.forecast") {
    return renderWeatherFacts(toolName, record, status, error);
  }
  return renderGenericObjectFacts(record, status, error);
}

function renderWeatherFacts(
  toolName: string,
  output: Record<string, unknown>,
  status: "OK" | "FAILED",
  error: unknown,
): string[] {
  const common = [
    ...field("status", asString(output.status) ?? status),
    ...field("source", output.source),
    ...field("latitude", output.latitude),
    ...field("longitude", output.longitude),
  ];
  if (toolName === "free.weather.current") {
    return [
      ...common,
      ...field("observedAt", output.observedAt),
      ...field("temperatureC", output.temperatureC),
      ...field("apparentTemperatureC", output.apparentTemperatureC),
      ...field("humidityPct", output.humidityPct),
      ...field("windSpeedKph", output.windSpeedKph),
      ...weatherCodeFields(output.weatherCode),
      ...renderErrorFacts(error),
    ];
  }

  const target = asRecord(output.target);
  const daily = asArray(output.daily)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const nextHours = asArray(output.nextHours)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  return [
    ...common,
    ...field("timezone", output.timezone),
    ...field("requestedDays", output.requestedDays),
    ...field("granularity", output.granularity),
    ...(target !== undefined ? ["- target:", `  ${formatWeatherHour(target)}`] : []),
    ...(daily.length > 0
      ? [
          "- daily:",
          ...daily.slice(0, WEATHER_DAILY_ENTRY_LIMIT).map((entry) => `  ${formatWeatherDay(entry)}`),
          ...(daily.length > WEATHER_DAILY_ENTRY_LIMIT
            ? [`[omitted ${daily.length - WEATHER_DAILY_ENTRY_LIMIT} daily entries]`]
            : []),
        ]
      : []),
    ...(nextHours.length > 0
      ? [
          "- nextHours:",
          ...nextHours.slice(0, WEATHER_HOURLY_ENTRY_LIMIT).map((entry) => `  ${formatWeatherHour(entry)}`),
          ...(nextHours.length > WEATHER_HOURLY_ENTRY_LIMIT
            ? [`[omitted ${nextHours.length - WEATHER_HOURLY_ENTRY_LIMIT} hourly entries]`]
            : []),
        ]
      : []),
    ...renderErrorFacts(error),
  ];
}

function formatWeatherDay(entry: Record<string, unknown>): string {
  return formatWeatherValues([
    ["date", entry.date],
    ["minTemperatureC", entry.minTemperatureC],
    ["maxTemperatureC", entry.maxTemperatureC],
    ["precipitationProbabilityPct", entry.precipitationProbabilityPct],
    ["precipitationMm", entry.precipitationMm],
    ["windSpeedKph", entry.windSpeedKph],
    ["weatherCode", entry.weatherCode],
    ["condition", describeWeatherCode(entry.weatherCode)],
  ]);
}

function formatWeatherHour(entry: Record<string, unknown>): string {
  return formatWeatherValues([
    ["time", entry.time],
    ["temperatureC", entry.temperatureC],
    ["apparentTemperatureC", entry.apparentTemperatureC],
    ["precipitationProbabilityPct", entry.precipitationProbabilityPct],
    ["precipitationMm", entry.precipitationMm],
    ["windSpeedKph", entry.windSpeedKph],
    ["weatherCode", entry.weatherCode],
    ["condition", describeWeatherCode(entry.weatherCode)],
  ]);
}

function formatWeatherValues(entries: Array<[string, unknown]>): string {
  return entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatScalar(value)}`)
    .join(", ");
}

function weatherCodeFields(value: unknown): string[] {
  return [
    ...field("weatherCode", value),
    ...field("condition", describeWeatherCode(value)),
  ];
}

function describeWeatherCode(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return ;
  }
  const code = Math.trunc(value);
  if (code === 0) return "clear sky";
  if (code === 1) return "mainly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code === 51 || code === 53 || code === 55) return "drizzle";
  if (code === 56 || code === 57) return "freezing drizzle";
  if (code === 61 || code === 63 || code === 65) return "rain";
  if (code === 66 || code === 67) return "freezing rain";
  if (code === 71 || code === 73 || code === 75) return "snowfall";
  if (code === 77) return "snow grains";
  if (code === 80 || code === 81 || code === 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code === 95) return "thunderstorm";
  if (code === 96 || code === 99) return "thunderstorm with hail";
  return "unknown";
}

function renderRepoTraceFacts(
  output: Record<string, unknown>,
  status: "OK" | "FAILED",
  error: unknown,
): string[] {
  const groups = asArray(output.groups);
  return [
    ...field("status", asString(output.status) ?? status),
    ...field("path", output.path),
    ...field("seeds", formatStringArray(asArray(output.seeds))),
    ...field("searchedFileCount", output.searchedFileCount),
    ...field("matchedFileCount", output.matchedFileCount),
    ...field("resultCount", output.resultCount),
    ...field("truncated", output.truncated),
    ...(groups.length > 0
      ? [
        "- groups:",
        ...groups.slice(0, SEARCH_MATCH_LIMIT).flatMap(formatRepoTraceGroup),
        ...(groups.length > SEARCH_MATCH_LIMIT ? [`[omitted ${groups.length - SEARCH_MATCH_LIMIT} groups]`] : []),
      ]
      : []),
    ...renderErrorFacts(error),
  ];
}

function renderFilesystemFacts(
  toolName: string,
  input: unknown,
  output: Record<string, unknown>,
  status: "OK" | "FAILED",
  error: unknown,
): string[] {
  if (toolName === "fs.read_text") {
    const content = asString(output.content) ?? "";
    const clipped = clipText(content, READ_TEXT_CONTENT_LIMIT);
    return [
      ...field("status", asString(output.status) ?? status),
      ...field("path", firstString(asRecord(input)?.path, output.path)),
      ...field("encoding", asString(output.encoding)),
      ...field("truncated", output.truncated),
      ...field("contentBytes", Buffer.byteLength(content, "utf8")),
      "- content:",
      indentBlock(clipped.text.length > 0 ? clipped.text : "<empty>"),
      ...(clipped.truncated ? ["[content clipped for model context]"] : []),
      ...renderErrorFacts(error),
    ];
  }

  if (toolName === "fs.list") {
    const entries = asArray(output.entries);
    return [
      ...field("status", asString(output.status) ?? status),
      ...field("path", firstString(asRecord(input)?.path, output.path)),
      ...field("entryCount", numberOr(output.entryCount, entries.length)),
      ...field("truncated", output.truncated),
      ...(entries.length > 0
        ? [
          "- entries:",
          ...entries.slice(0, LIST_ENTRY_LIMIT).map((entry) => `  ${formatFilesystemEntry(entry)}`),
          ...(entries.length > LIST_ENTRY_LIMIT ? [`[omitted ${entries.length - LIST_ENTRY_LIMIT} entries]`] : []),
        ]
        : []),
      ...renderErrorFacts(error),
    ];
  }

  if (toolName === "fs.search_text") {
    const matches = asArray(output.matches);
    return [
      ...field("status", asString(output.status) ?? status),
      ...field("path", firstString(asRecord(input)?.path, output.path)),
      ...field("query", firstString(output.query, asRecord(input)?.query)),
      ...field("matchCount", numberOr(output.matchCount, matches.length)),
      ...field("returnedMatchCount", numberOr(output.returnedMatchCount, matches.length)),
      ...field("truncated", output.truncated),
      ...field("previewTruncatedCount", output.previewTruncatedCount),
      ...field("totalPreviewChars", output.totalPreviewChars),
      ...(matches.length > 0
        ? [
          "- matches:",
          ...matches.slice(0, SEARCH_MATCH_LIMIT).map((match) => `  ${formatSearchMatch(match)}`),
          ...(matches.length > SEARCH_MATCH_LIMIT ? [`[omitted ${matches.length - SEARCH_MATCH_LIMIT} matches]`] : []),
        ]
        : []),
      ...renderErrorFacts(error),
    ];
  }

  if (toolName === "fs.write_text") {
    return [
      ...field("path", firstString(asRecord(input)?.path, output.path)),
      ...field("mode", firstString(output.mode, asRecord(input)?.mode)),
      ...field("status", asString(output.status) ?? status),
      ...field("changed", output.changed),
      ...field("existed", output.existed),
      ...beforeAfter("bytes", output.bytesBefore, output.bytesAfter),
      ...beforeAfter("lines", output.lineCountBefore, output.lineCountAfter, output.lineCountDelta),
      ...beforeAfter(
        "whitespace tokens",
        output.whitespaceTokenCountBefore,
        output.whitespaceTokenCountAfter,
        output.whitespaceTokenCountDelta,
      ),
      ...(Object.hasOwn(output, "diffPreview") ? [`- diffPreview: ${output.diffPreview === undefined ? "absent" : "present"}`] : []),
      ...renderErrorFacts(error),
    ];
  }

  if (toolName === "fs.replace_text") {
    return [
      ...field("path", firstString(asRecord(input)?.path, output.path)),
      ...field("all", asRecord(input)?.all),
      ...field("status", asString(output.status) ?? status),
      ...field("changed", output.changed),
      ...field("replacements", output.replacements),
      ...beforeAfter("bytes", output.bytesBefore, output.bytesAfter),
      ...beforeAfter("lines", output.lineCountBefore, output.lineCountAfter, output.lineCountDelta),
      ...beforeAfter(
        "whitespace tokens",
        output.whitespaceTokenCountBefore,
        output.whitespaceTokenCountAfter,
        output.whitespaceTokenCountDelta,
      ),
      ...renderErrorFacts(error),
    ];
  }

  if (toolName === "fs.verify_json") {
    const verification = asRecord(output.artifactVerification);
    const requirements = asArray(verification?.requirements);
    return [
      ...field("status", asString(output.status) ?? status),
      ...field("path", output.path),
      ...field("target", output.target),
      ...field("summary", output.summary),
      ...field("requirementCount", requirements.length),
      ...(Array.isArray(output.failures) ? ["- failures:", ...asArray(output.failures).map((item) => `  ${String(item)}`)] : []),
      ...renderErrorFacts(error),
    ];
  }

  return [
    ...field("status", asString(output.status) ?? status),
    ...field("path", firstString(asRecord(input)?.path, output.path)),
    ...field("sourcePath", output.sourcePath),
    ...field("destinationPath", output.destinationPath),
    ...field("recursive", output.recursive),
    ...field("overwrite", output.overwrite),
    ...renderErrorFacts(error),
  ];
}

function renderDevShellFacts(
  toolName: string,
  input: unknown,
  output: Record<string, unknown>,
  status: "OK" | "FAILED",
  error: unknown,
): string[] {
  const lifecycle = normalizeDevShellLifecycle(toolName, input, output);
  const stdout = asString(output.stdout);
  const stderr = asString(output.stderr);
  const outputText = lifecycle?.outputText;
  const text = renderNonDuplicateText(asString(output.text) ?? outputText, stdout, stderr);
  const continuation = toolName === "exec_command" &&
      lifecycle?.status === "RUNNING" &&
      lifecycle.sessionId !== undefined
    ? [
      "- continuation:",
      `  process is still running; use exec_command with sessionId "${lifecycle.sessionId}" and stdin to continue it. command starts a new independent process.`,
    ]
    : [];
  return [
    ...field("command", lifecycle?.command ?? firstString(output.command, asRecord(input)?.command)),
    ...field("cwd", lifecycle?.cwd ?? firstString(output.cwd, asRecord(input)?.cwd)),
    ...field("processId", lifecycle?.processId ?? firstString(output.processId, asRecord(input)?.processId)),
    ...field("sessionId", lifecycle?.sessionId),
    ...field("stdin", lifecycle?.stdin),
    ...field("commandKind", output.commandKind),
    ...field("timeoutMs", asRecord(input)?.timeoutMs),
    ...field("status", lifecycle?.status ?? asString(output.status) ?? status),
    ...field("exitCode", lifecycle?.exitCode ?? output.exitCode),
    ...field("truncated", lifecycle?.truncated ?? output.truncated),
    ...field("cursor", lifecycle?.cursor),
    ...field("errorCode", output.errorCode),
    ...field("failurePhase", output.failurePhase),
    ...field("failureReason", output.failureReason),
    ...field("nextSuggestedAction", output.nextSuggestedAction),
    ...field("strictModeReason", output.strictModeReason),
    ...(text !== undefined ? ["- text:", indentBlock(text)] : []),
    ...(stdout !== undefined ? ["- stdout:", indentBlock(stdout.length > 0 ? stdout : "<empty>")] : []),
    ...(stderr !== undefined ? ["- stderr:", indentBlock(stderr.length > 0 ? stderr : "<empty>")] : []),
    ...continuation,
    ...renderErrorFacts(error),
  ];
}

function renderInternetFacts(
  _toolName: string,
  output: Record<string, unknown>,
  status: "OK" | "FAILED",
  error: unknown,
): string[] {
  const results = asArray(output.results);
  const report = asRecord(output.report);
  return [
    ...field("status", asString(output.status) ?? status),
    ...field("query", output.query),
    ...field("url", output.url),
    ...field("title", output.title),
    ...field("resultCount", results.length > 0 ? results.length : undefined),
    ...field("summary", output.summary ?? report?.summary),
    ...(results.length > 0
      ? [
        "- results:",
        ...results.slice(0, 8).map((item) => `  ${formatResultItem(item)}`),
        ...(results.length > 8 ? [`[omitted ${results.length - 8} results]`] : []),
      ]
      : []),
    ...renderErrorFacts(error),
  ];
}

function renderGenericObjectFacts(
  output: Record<string, unknown>,
  status: "OK" | "FAILED",
  error: unknown,
): string[] {
  const scalarLines = Object.entries(output)
    .filter(([key, value]) => key !== "status" && isScalar(value))
    .slice(0, 24)
    .flatMap(([key, value]) => field(key, value));
  const preview = scalarLines.length === 0 ? renderGenericFacts(output, status, error) : scalarLines;
  return [
    ...field("status", asString(output.status) ?? status),
    ...preview,
    ...renderErrorFacts(error),
  ];
}

function renderGenericFacts(output: unknown, status: "OK" | "FAILED", error: unknown): string[] {
  return [
    ...field("status", status),
    "- value:",
    indentBlock(clipText(stableStringify(output), GENERIC_VALUE_PREVIEW_CHARS).text),
    ...renderErrorFacts(error),
  ];
}

function renderErrorFacts(error: unknown): string[] {
  const record = asRecord(error);
  if (record === undefined) {
    return [];
  }
  return [
    ...field("errorCode", record.code),
    ...field("errorMessage", record.message),
  ];
}

function toToolAliasEntry(
  tool: ModelToolSpec,
  kind: KestrelAgentToolActionKind,
): KestrelAgentToolAliasEntry {
  return {
    providerName: providerToolAliasForCanonicalName(tool.name),
    canonicalName: tool.name,
    inputSchema: tool.inputSchema,
    description: tool.description,
    kind,
  };
}

function numberDelta(before: unknown, after: unknown): number | undefined {
  if (
    typeof before !== "number" ||
    typeof after !== "number" ||
    Number.isFinite(before) === false ||
    Number.isFinite(after) === false
  ) {
    return ;
  }
  return Math.trunc(after) - Math.trunc(before);
}

function formatSignedNumber(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function clampModelVisibleText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function field(label: string, value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  return [`- ${label}: ${formatScalar(value)}`];
}

function beforeAfter(label: string, before: unknown, after: unknown, delta?: unknown): string[] {
  if (before === undefined || after === undefined) {
    return [];
  }
  const deltaText = delta === undefined ? "" : ` (${String(delta)})`;
  return [`- ${label}: ${String(before)} -> ${String(after)}${deltaText}`];
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isScalar(value)) {
    return String(value);
  }
  return clipText(stableStringify(value), GENERIC_VALUE_PREVIEW_CHARS).text;
}

function formatRepoTraceGroup(value: unknown): string[] {
  const group = asRecord(value);
  const groupPath = asString(group?.path) ?? "<unknown>";
  const matches = asArray(group?.matches);
  return [
    `  ${groupPath}`,
    ...matches.slice(0, 8).flatMap((match) => formatRepoTraceMatch(match)),
    ...(matches.length > 8 ? [`    [omitted ${matches.length - 8} matches]`] : []),
  ];
}

function formatRepoTraceMatch(value: unknown): string[] {
  const match = asRecord(value);
  const seed = asString(match?.seed) ?? "<unknown>";
  const line = numberOr(match?.line, 0);
  const column = numberOr(match?.column, 0);
  const preview = asString(match?.preview) ?? "";
  const contextBefore = asArray(match?.contextBefore).filter((item): item is string => typeof item === "string");
  const contextAfter = asArray(match?.contextAfter).filter((item): item is string => typeof item === "string");
  return [
    `    ${line}:${column} seed=${JSON.stringify(seed)} ${preview}`,
    ...contextBefore.map((lineText) => `      before: ${lineText}`),
    ...contextAfter.map((lineText) => `      after: ${lineText}`),
  ];
}

function formatStringArray(value: unknown[]): string | undefined {
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings.join(", ") : undefined;
}

function formatFilesystemEntry(value: unknown): string {
  const record = asRecord(value);
  if (record === undefined) {
    return formatScalar(value);
  }
  const path = firstString(record.path, record.name) ?? "<unknown>";
  const type = firstString(record.type, record.kind);
  const size = typeof record.size === "number" ? ` ${record.size} bytes` : "";
  return type === undefined ? `${path}${size}` : `${path} (${type})${size}`;
}

function formatSearchMatch(value: unknown): string {
  const record = asRecord(value);
  if (record === undefined) {
    return formatScalar(value);
  }
  const path = asString(record.path) ?? "<unknown>";
  const line = typeof record.line === "number" ? `:${Math.trunc(record.line)}` : "";
  const column = typeof record.column === "number" ? `:${Math.trunc(record.column)}` : "";
  const preview = asString(record.preview) ?? asString(record.text) ?? "";
  return `${path}${line}${column} ${preview}`.trim();
}

function formatResultItem(value: unknown): string {
  const record = asRecord(value);
  if (record === undefined) {
    return formatScalar(value);
  }
  const title = firstString(record.title, record.name) ?? "Untitled";
  const url = asString(record.url);
  const snippet = asString(record.snippet) ?? asString(record.description);
  return [title, url, snippet].filter((item) => item !== undefined && item.length > 0).join(" | ");
}

function renderNonDuplicateText(
  text: string | undefined,
  stdout: string | undefined,
  stderr: string | undefined,
): string | undefined {
  if (text === undefined || text.trim().length === 0) {
    return ;
  }
  const normalized = text.trim();
  const streams = [stdout, stderr].filter((item): item is string => item !== undefined && item.length > 0).join("").trim();
  if (normalized === stdout?.trim() || normalized === stderr?.trim() || (streams.length > 0 && normalized === streams)) {
    return ;
  }
  return text;
}

function clipText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, maxChars)}\n[omitted ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

function indentBlock(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return ;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function stableStringify(value: unknown): string {
  try {
    return stringifySanitizedJson(sortValue(sanitizeJsonValue(value)));
  } catch {
    return String(value);
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort((left, right) => left.localeCompare(right))) {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
