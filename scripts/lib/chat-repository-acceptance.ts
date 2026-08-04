const BROAD_REPOSITORY_TOOLS = new Set(["fs.search_text", "repo.trace"]);

type ReplayRecord = Record<string, unknown>;

export interface ChatRepositoryReplayAnalysis {
  broadSearchBatchCount: number;
  broadSearchCallCount: number;
  successfulBroadTool?: string | undefined;
  successfulBroadStepIndex?: number | undefined;
  returnedPaths: string[];
  followingModelRequestStepIndex?: number | undefined;
  retainedSearchResult: boolean;
  followingAction: "exact_file_read" | "finalization" | "broad_search" | "other" | "missing";
  followingTool?: string | undefined;
  followingToolPath?: string | undefined;
  errors: string[];
}

export interface ChatAcceptanceAssistantText {
  text: string;
  source: "history" | "finalize-event" | "missing";
}

export function analyzeChatRepositoryReplay(
  rawEvents: readonly unknown[],
): ChatRepositoryReplayAnalysis {
  const events = rawEvents.map((event, index) => ({
    index,
    event: asRecord(event) ?? {},
  }));
  const broadStarts = events.filter(({ event }) =>
    readString(event.type) === "run.tool.started" &&
    BROAD_REPOSITORY_TOOLS.has(readToolName(event) ?? "")
  );
  const broadBatchKeys = [...new Set(broadStarts.map(({ event, index }) =>
    readStepIndex(event) === undefined ? `event:${index}` : `step:${readStepIndex(event)}`
  ))];
  const successfulBroadCompletions = events.filter(({ event }) =>
    readString(event.type) === "run.tool.completed" &&
    BROAD_REPOSITORY_TOOLS.has(readToolName(event) ?? "") &&
    readString(asRecord(asRecord(event.metadata)?.outcome)?.kind) === "success"
  );
  const errors: string[] = [];
  if (broadBatchKeys.length > 1) {
    errors.push(`observed ${broadBatchKeys.length} broad search decision batches`);
  }

  const successfulBroad = successfulBroadCompletions[0];
  const successfulBroadStepIndex = successfulBroad === undefined
    ? undefined
    : readStepIndex(successfulBroad.event);
  const successfulBatchCompletions = successfulBroad === undefined
    ? []
    : successfulBroadCompletions.filter(({ event, index }) =>
      successfulBroadStepIndex === undefined
        ? index === successfulBroad.index
        : readStepIndex(event) === successfulBroadStepIndex
    );
  const returnedPaths = uniqueStrings(successfulBatchCompletions.flatMap(({ event }) =>
    readReturnedPaths(asRecord(asRecord(event.metadata)?.output))
  ));
  const successfulBatchEndIndex = successfulBatchCompletions.reduce(
    (latest, completion) => Math.max(latest, completion.index),
    successfulBroad?.index ?? -1,
  );
  const followingModelRequest = successfulBroad === undefined
    ? undefined
    : events.find(({ event, index }) =>
      index > successfulBatchEndIndex && readString(event.type) === "model.requested"
    );
  const followingTool = followingModelRequest === undefined
    ? undefined
    : events.find(({ event, index }) =>
      index > followingModelRequest.index && readString(event.type) === "run.tool.started"
    );
  const followingToolName = followingTool === undefined
    ? undefined
    : readToolName(followingTool.event);
  const followingToolPath = followingTool === undefined
    ? undefined
    : readString(asRecord(asRecord(followingTool.event.metadata)?.input)?.path);
  const followingAction = classifyFollowingAction({
    toolName: followingToolName,
    toolPath: followingToolPath,
    returnedPaths,
  });
  const retainedSearchResult =
    followingAction === "exact_file_read" || followingAction === "finalization";

  if (successfulBroad === undefined) {
    errors.push("no successful broad repository search was observed");
  } else if (followingModelRequest === undefined) {
    errors.push("no model request followed the successful broad repository search batch");
  } else if (followingAction === "broad_search") {
    errors.push(`successful broad search batch was followed by another broad search (${followingToolName})`);
  } else if (followingAction === "missing") {
    errors.push("no tool action followed the model request after broad repository search");
  } else if (followingAction === "other") {
    errors.push(
      `successful broad search batch was followed by ${followingToolName ?? "an unknown tool"}, not an exact returned-file read or finalization`,
    );
  }

  return {
    broadSearchBatchCount: broadBatchKeys.length,
    broadSearchCallCount: broadStarts.length,
    ...(successfulBroad === undefined
      ? {}
      : { successfulBroadTool: readToolName(successfulBroad.event) }),
    ...(successfulBroadStepIndex === undefined ? {} : { successfulBroadStepIndex }),
    returnedPaths,
    ...(followingModelRequest === undefined
      ? {}
      : { followingModelRequestStepIndex: readStepIndex(followingModelRequest.event) }),
    retainedSearchResult,
    followingAction,
    ...(followingToolName === undefined ? {} : { followingTool: followingToolName }),
    ...(followingToolPath === undefined ? {} : { followingToolPath }),
    errors,
  };
}

export function resolveChatAcceptanceAssistantText(input: {
  runId?: string | undefined;
  history: readonly unknown[];
  events: readonly unknown[];
}): ChatAcceptanceAssistantText {
  const historyText = [...input.history]
    .reverse()
    .map((line) => asRecord(line))
    .find((line) =>
      readString(line?.role) === "assistant" &&
      (input.runId === undefined || readString(asRecord(line?.run)?.runId) === input.runId) &&
      readNonEmptyString(line?.text) !== undefined
    );
  const persistedText = readNonEmptyString(historyText?.text);
  if (persistedText !== undefined) {
    return { text: persistedText, source: "history" };
  }

  for (const rawEvent of [...input.events].reverse()) {
    const event = asRecord(rawEvent);
    if (
      readString(event?.type) !== "run.tool.started" &&
      readString(event?.type) !== "run.tool.completed"
    ) {
      continue;
    }
    if (readToolName(event) !== "FinalizeAnswer") {
      continue;
    }
    const metadata = asRecord(event?.metadata);
    const message = readFinalizeMessage(metadata);
    if (message !== undefined) {
      return { text: message, source: "finalize-event" };
    }
  }

  return { text: "", source: "missing" };
}

function classifyFollowingAction(input: {
  toolName?: string | undefined;
  toolPath?: string | undefined;
  returnedPaths: readonly string[];
}): ChatRepositoryReplayAnalysis["followingAction"] {
  if (input.toolName === undefined) return "missing";
  if (input.toolName === "FinalizeAnswer") return "finalization";
  if (BROAD_REPOSITORY_TOOLS.has(input.toolName)) return "broad_search";
  if (
    input.toolName === "fs.read_text" &&
    input.toolPath !== undefined &&
    input.returnedPaths.includes(input.toolPath)
  ) {
    return "exact_file_read";
  }
  return "other";
}

function readReturnedPaths(output: ReplayRecord | undefined): string[] {
  if (output === undefined) return [];
  const groups = Array.isArray(output.groups) ? output.groups : [];
  const matches = Array.isArray(output.matches) ? output.matches : [];
  return [...groups, ...matches]
    .map((entry) => readString(asRecord(entry)?.path))
    .filter((value): value is string => value !== undefined);
}

function readFinalizeMessage(metadata: ReplayRecord | undefined): string | undefined {
  const input = asRecord(metadata?.input);
  const output = asRecord(metadata?.output);
  const data = asRecord(input?.data);
  const finalizeInput = asRecord(data?.finalizeInput);
  return readNonEmptyString(finalizeInput?.message) ??
    readNonEmptyString(data?.message) ??
    readNonEmptyString(input?.message) ??
    readNonEmptyString(output?.message);
}

function readToolName(event: ReplayRecord | undefined): string | undefined {
  return readString(asRecord(event?.metadata)?.toolName);
}

function readStepIndex(event: ReplayRecord | undefined): number | undefined {
  return typeof event?.stepIndex === "number" && Number.isSafeInteger(event.stepIndex)
    ? event.stepIndex
    : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function asRecord(value: unknown): ReplayRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ReplayRecord
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
