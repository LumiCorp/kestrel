export type KestrelBenchmarkSource = "swe-verified" | "terminal-bench";

export interface KestrelBenchmarkContext {
  source: KestrelBenchmarkSource;
  instanceId?: string | undefined;
  taskId?: string | undefined;
  problemStatement?: string | undefined;
  hintsText?: string | undefined;
  workspaceRoot?: string | undefined;
  requiredArtifacts?: string[] | undefined;
}

const SWE_VERIFIED_GUIDANCE = [
  "Work only from the issue text, repository state, and evidence you gather in this workspace.",
  "You are running inside the SWE-bench testbed at /testbed.",
  "Treat issue hints and proposed causes as hypotheses, not requirements.",
  "When the issue touches emitted values, paths, serialized output, API returns, or user-visible strings, preserve the observed emitted semantics unless direct evidence shows the requested fix requires changing them.",
  "Validate the exact emitted value or behavior at risk, not only a nearby reproduction or ordering check.",
  "Before editing, find the relevant source file and existing tests for that behavior.",
  "Edit the checked-out repository directly under /testbed and leave the final candidate fix as a git diff.",
  "Use exec_command for focused validation; it runs in this SWE-bench testbed.",
  "Run the focused existing test before finalizing.",
  "If the first test command fails because the runner is unavailable, find the repo-native test command and try that.",
  "Use a reproduction script only when no relevant test exists or no runnable project test command can be found.",
  "Keep the patch focused. Do not remove unrelated tests.",
  "Do not create benchmark bookkeeping files inside the candidate repository.",
  "Finalize only after the relevant check passes.",
];

const TERMINAL_BENCH_TASK_CONTRACT = [
  "",
  "Kestrel Terminal-Bench execution contract:",
  "- Work from the public task instructions and files under /app. Do not read, execute, copy, or infer answers from /protected or verifier-only helper paths.",
  "- Terminal-Bench runs are noninteractive after task start. Do not ask the user/operator for clarification, approval, hints, or missing data; use public evidence, create the required outputs, or finish with a concrete blocker.",
  "- Use exec_command for terminal work. Its command field starts a new independent process.",
  "- If exec_command returns status running with sessionId, the process is alive. Continue that same process with { sessionId, stdin }; include the newline a terminal user would press.",
  "- Do not use repeated fresh command calls as a substitute for stdin when task state depends on continuity.",
  "- For repeated exploration or protocol-driving tasks, prefer a small controller script over many manual probes.",
  "- When a task specifies exact file contents, create those bytes exactly. If it asks for a trailing newline, verify the final byte is a newline and do not leave a literal backslash-n unless the task explicitly asks for those two characters.",
  "- Before finalizing, create every required output under /app and read it back or run a bounded public check that proves it exists and contains the intended content.",
].join("\n");

export function renderTaskInstruction(input: {
  goal: string;
  benchmarkContext: KestrelBenchmarkContext | undefined;
}): string {
  if (input.benchmarkContext === undefined) {
    return input.goal;
  }
  if (input.benchmarkContext.source === "swe-verified") {
    return renderSweVerifiedTaskInstruction({
      goal: input.goal,
      context: input.benchmarkContext,
    });
  }
  if (input.benchmarkContext.source === "terminal-bench") {
    return renderTerminalBenchTaskInstruction({
      goal: input.goal,
      context: input.benchmarkContext,
    });
  }
  return input.goal;
}

export function readBenchmarkContext(eventPayload: Record<string, unknown>): KestrelBenchmarkContext | undefined {
  const metadata = asRecord(eventPayload.metadata);
  const benchmark = asRecord(metadata?.benchmark);
  const context = asRecord(benchmark?.context) ?? asRecord(eventPayload.benchmarkContext);
  if (context === undefined) {
    return ;
  }
  const source = asString(context.source) ?? asString(benchmark?.name);
  if (source !== "swe-verified" && source !== "terminal-bench") {
    return ;
  }
  return {
    source,
    instanceId: asString(context.instanceId) ?? asString(benchmark?.instanceId),
    taskId: asString(context.taskId) ?? asString(benchmark?.taskId),
    problemStatement: asString(context.problemStatement),
    hintsText: asString(context.hintsText),
    workspaceRoot: asString(context.workspaceRoot),
    requiredArtifacts: readStringArray(context.requiredArtifacts),
  };
}

function renderSweVerifiedTaskInstruction(input: {
  goal: string;
  context: KestrelBenchmarkContext;
}): string {
  const instanceId = input.context.instanceId ?? "unknown";
  const problemStatement = input.context.problemStatement?.trim();
  const hintsText = input.context.hintsText?.trim();
  const issue = problemStatement !== undefined && problemStatement.length > 0
    ? problemStatement
    : input.goal;
  const hintBlock = hintsText === undefined || hintsText.length === 0
    ? ""
    : `\n\nHints:\n${hintsText}`;
  return [
    `Resolve SWE-bench Verified instance ${instanceId} in this checked-out repository.`,
    "",
    "Issue:",
    issue,
    hintBlock,
    "",
    "Kestrel runner guidance:",
    ...SWE_VERIFIED_GUIDANCE.map((item) => `- ${item}`),
  ].join("\n");
}

function renderTerminalBenchTaskInstruction(input: {
  goal: string;
  context: KestrelBenchmarkContext;
}): string {
  if (input.goal.includes("Kestrel Terminal-Bench execution contract")) {
    return input.goal;
  }
  const requiredArtifacts = (input.context.requiredArtifacts ?? []).length > 0
    ? [
        "",
        "Required output artifacts:",
        ...(input.context.requiredArtifacts ?? []).map((artifact) => `- ${artifact}`),
      ].join("\n")
    : "";
  const stripped = input.goal.trimEnd();
  if (stripped.length === 0) {
    return `${TERMINAL_BENCH_TASK_CONTRACT.trim()}${requiredArtifacts}`;
  }
  return `${stripped}\n${TERMINAL_BENCH_TASK_CONTRACT}${requiredArtifacts}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value) === false) {
    return ;
  }
  const values = value
    .map(asString)
    .filter((item): item is string => item !== undefined && item.trim().length > 0)
    .map((item) => item.trim());
  return values.length > 0 ? [...new Set(values)] : undefined;
}
