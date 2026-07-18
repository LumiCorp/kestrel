export type SdkAgentShakedownScenarioId = "read" | "filesystem" | "exec" | "coding";

export interface SdkAgentShakedownToolRequirement {
  toolName: string;
  phase?: "completed" | "failed" | undefined;
  resultStatus?: "OK" | "FAILED" | undefined;
  outputStatus?: string | undefined;
  minCount?: number | undefined;
}

export interface SdkAgentShakedownScenario {
  id: SdkAgentShakedownScenarioId;
  title: string;
  marker: string;
  prompt: string;
  requiredTools: SdkAgentShakedownToolRequirement[];
  timeoutMs?: number | undefined;
}

export interface SdkAgentShakedownToolObservation {
  toolName: string;
  phase: "started" | "completed" | "failed";
  seq?: number | undefined;
  stepIndex?: number | undefined;
  input?: Record<string, unknown> | undefined;
  resultStatus?: "OK" | "FAILED" | undefined;
  outputStatus?: string | undefined;
  durationMs?: number | undefined;
  sessionId?: string | undefined;
  changedFiles?: string[] | undefined;
}

export interface SdkAgentShakedownLifecycleDiagnostics {
  execStarts: number;
  execContinuations: number;
  runningObservations: number;
  terminalSettlements: number;
  observedMutationEvents: number;
}

export interface SdkAgentShakedownObservation {
  terminalType: string;
  outputStatus?: string | undefined;
  assistantText?: string | null | undefined;
  visibleTodos?: unknown;
  tools: SdkAgentShakedownToolObservation[];
}

export const SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL = "openai/gpt-5.4-mini";
export const SDK_AGENT_SHAKEDOWN_CODING_CHANGELOG_ENTRY =
  "- Preserve zero-quantity inventory rows.";

export const SDK_AGENT_SHAKEDOWN_FORBIDDEN_MODEL_TOOLS = [
  "dev.shell.run",
  "dev.process.start",
  "dev.process.write",
  "dev.process.write_and_read",
  "dev.process.read",
  "dev.process.stop",
] as const;

export const SDK_AGENT_SHAKEDOWN_SCENARIOS: readonly SdkAgentShakedownScenario[] = [
  {
    id: "read",
    title: "Balanced and read-only tools",
    marker: "SHAKEDOWN_READ_OK",
    prompt: [
      "Run the read-only part of an automated Kestrel SDK systems check.",
      "Use every named tool below. Do not replace a named tool with a shell command.",
      "1. Create a short visible todo plan for this check.",
      "2. Call free.time.current for Etc/UTC.",
      "3. Call fs.list on '.' with recursive true.",
      "4. Call fs.read_text on 'seed/readme.txt' and confirm it contains SHAKEDOWN_NEEDLE=alpha.",
      "5. Call fs.search_text on '.' for SHAKEDOWN_NEEDLE.",
      "6. Call repo.trace on '.' with the seed SHAKEDOWN_NEEDLE.",
      "7. In the same final model turn, call kestrel.todo_update with every item status done and call kestrel.finalize.",
      "Your final message must include the exact marker SHAKEDOWN_READ_OK.",
    ].join("\n"),
    requiredTools: [
      { toolName: "free.time.current", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.list", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.read_text", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.search_text", phase: "completed", resultStatus: "OK" },
      { toolName: "repo.trace", phase: "completed", resultStatus: "OK" },
    ],
  },
  {
    id: "filesystem",
    title: "Filesystem mutation and verification",
    marker: "SHAKEDOWN_FILESYSTEM_OK",
    prompt: [
      "Run the filesystem part of an automated Kestrel SDK systems check.",
      "Use every named tool below. Do not replace a named tool with a shell command.",
      "1. Create a visible todo plan that includes the final verification.",
      "2. Call fs.mkdir for '.kestrel-shakedown/work'.",
      "3. Call fs.write_text to create '.kestrel-shakedown/work/scratch.txt', then call fs.delete to remove it.",
      "4. Call fs.write_text to create '.kestrel-shakedown/work/data.json' with valid JSON: {\"items\":[{\"id\":\"alpha\",\"url\":\"https://example.com/alpha\"}]}.",
      "5. Call fs.replace_text on data.json to replace alpha with beta everywhere.",
      "6. Call fs.copy from data.json to copy.json.",
      "7. Call fs.move from copy.json to final.json.",
      "8. Call fs.search_text in '.kestrel-shakedown/work' for beta.",
      "9. Last, call fs.verify_json on final.json with arrayPath 'items', minLength 1, requiredStringFields ['id'], and requiredAbsoluteUrlFields ['url'].",
      "10. After verification passes, in the same final model turn call kestrel.todo_update with every item status done and call kestrel.finalize.",
      "Your final message must include the exact marker SHAKEDOWN_FILESYSTEM_OK.",
    ].join("\n"),
    requiredTools: [
      { toolName: "fs.mkdir", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.write_text", phase: "completed", resultStatus: "OK", minCount: 2 },
      { toolName: "fs.delete", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.replace_text", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.copy", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.move", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.search_text", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.verify_json", phase: "completed", resultStatus: "OK" },
    ],
  },
  {
    id: "exec",
    title: "Unified exec_command lifecycle",
    marker: "SHAKEDOWN_EXEC_OK",
    prompt: [
      "Run the terminal part of an automated Kestrel SDK systems check.",
      "Use only exec_command for terminal work. Never call dev.shell.* or dev.process.*.",
      "1. Create a visible todo plan that includes settling the live session and validating the final file.",
      "2. Start exec_command with `node -e \"console.log('QUICK_OK')\"` and yieldTimeMs 1000. Confirm it returns completed.",
      "3. Start exec_command with `node -e \"process.stderr.write('EXPECTED_FAIL');process.exit(7)\"` and yieldTimeMs 1000. This nonzero exit is expected; do not retry it.",
      "4. Start exec_command with `node -e \"console.log('SESSION_START');setTimeout(()=>console.log('SESSION_OK'),400)\"` and yieldTimeMs 25. It must return running. Reuse that exact sessionId with exec_command and no command until it becomes terminal.",
      "5. Start exec_command with `printf '{\"items\":[{\"status\":\"ok\"}]}\\n' > .kestrel-shakedown/exec.json` and yieldTimeMs 1000.",
      "6. Last, call fs.verify_json on '.kestrel-shakedown/exec.json' with arrayPath 'items', minLength 1, and requiredStringFields ['status'].",
      "7. After the live session is terminal and JSON verification passes, in the same final model turn call kestrel.todo_update with every item status done and call kestrel.finalize.",
      "Your final message must include the exact marker SHAKEDOWN_EXEC_OK.",
    ].join("\n"),
    requiredTools: [
      { toolName: "exec_command", phase: "completed", resultStatus: "OK", outputStatus: "completed", minCount: 2 },
      { toolName: "exec_command", phase: "completed", resultStatus: "OK", outputStatus: "failed" },
      { toolName: "exec_command", phase: "completed", resultStatus: "OK", outputStatus: "running" },
      { toolName: "fs.verify_json", phase: "completed", resultStatus: "OK", outputStatus: "passed" },
    ],
  },
  {
    id: "coding",
    title: "Coding lifecycle and current-state validation",
    marker: "SHAKEDOWN_CODING_OK",
    timeoutMs: 300_000,
    prompt: [
      "Fix the reported bug in the dependency-free Node project at 'coding-fixture'.",
      "Issue: formatInventory drops valid rows whose quantity is 0. It must include every row, trim each name, preserve input order, render zero as 0, and never mutate its input.",
      "Treat this like a small coding task: inspect the repository, keep a visible todo plan current, diagnose the failure, make the smallest correct change, and validate the final state.",
      "Execution lifecycle requirements for this systems check:",
      "1. Before changing source code, call exec_command with command 'npm test', cwd 'coding-fixture', and yieldTimeMs 25. It must return running. Reuse that exact sessionId until the baseline test reaches terminal status failed.",
      "2. Fix the implementation with fs.replace_text. Preserve the existing regression tests.",
      "3. After the source mutation, call exec_command again with command 'npm test', cwd 'coding-fixture', and yieldTimeMs 25. The cwd must stay the exact relative string 'coding-fixture'; do not replace it with an absolute path. Reuse its returned sessionId until the test reaches terminal status completed.",
      `4. Only after that passing test, use fs.write_text in append mode to add the exact line '${SDK_AGENT_SHAKEDOWN_CODING_CHANGELOG_ENTRY}' to 'coding-fixture/CHANGELOG.md'.`,
      "5. After the changelog mutation has returned, use fs.read_text on 'coding-fixture/CHANGELOG.md' in a later action. Do not issue the write and read in parallel. This proves that the post-test mutation received later current-state evidence.",
      "6. Set every visible todo item to done and call kestrel.finalize in the same final model turn.",
      "Use only exec_command for terminal work. Never call dev.shell.* or dev.process.*. Do not install packages, use the network, or ask the user questions.",
      "Your final message must include the exact marker SHAKEDOWN_CODING_OK.",
    ].join("\n"),
    requiredTools: [
      { toolName: "exec_command", phase: "completed", resultStatus: "OK", outputStatus: "running", minCount: 2 },
      { toolName: "exec_command", phase: "completed", resultStatus: "OK", outputStatus: "failed" },
      { toolName: "exec_command", phase: "completed", resultStatus: "OK", outputStatus: "completed" },
      { toolName: "fs.replace_text", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.write_text", phase: "completed", resultStatus: "OK" },
      { toolName: "fs.read_text", phase: "completed", resultStatus: "OK" },
    ],
  },
];

export function selectSdkAgentShakedownScenarios(
  requested: readonly string[],
): SdkAgentShakedownScenario[] {
  if (requested.length === 0) {
    return [...SDK_AGENT_SHAKEDOWN_SCENARIOS];
  }
  const requestedSet = new Set(requested);
  const unknown = [...requestedSet].filter(
    (id) => SDK_AGENT_SHAKEDOWN_SCENARIOS.some((scenario) => scenario.id === id) === false,
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown SDK shake-down scenario(s): ${unknown.join(", ")}. Expected read, filesystem, exec, or coding.`,
    );
  }
  return SDK_AGENT_SHAKEDOWN_SCENARIOS.filter((scenario) => requestedSet.has(scenario.id));
}

export function validateSdkAgentShakedownObservation(
  scenario: SdkAgentShakedownScenario,
  observation: SdkAgentShakedownObservation,
): string[] {
  const errors: string[] = [];
  if (observation.terminalType !== "run.completed") {
    errors.push(`Expected run.completed, received ${observation.terminalType}.`);
  }
  if (observation.outputStatus !== "COMPLETED") {
    errors.push(`Expected output status COMPLETED, received ${observation.outputStatus ?? "missing"}.`);
  }
  if (observation.assistantText?.includes(scenario.marker) !== true) {
    errors.push(`Final assistant text is missing ${scenario.marker}.`);
  }
  const visibleTodos = asRecord(observation.visibleTodos);
  const todoItems = Array.isArray(visibleTodos?.items) ? visibleTodos.items : [];
  if (typeof visibleTodos?.objective !== "string" || visibleTodos.objective.trim().length === 0 || todoItems.length === 0) {
    errors.push("Expected a non-empty visible todo plan in final session state.");
  } else if (todoItems.some((item) => asRecord(item)?.status !== "done")) {
    errors.push("Expected every visible todo item to be done before finalization.");
  }

  for (const requirement of scenario.requiredTools) {
    const matching = observation.tools.filter((tool) =>
      tool.toolName === requirement.toolName &&
      (requirement.phase === undefined || tool.phase === requirement.phase) &&
      (requirement.resultStatus === undefined || tool.resultStatus === requirement.resultStatus) &&
      (requirement.outputStatus === undefined || tool.outputStatus === requirement.outputStatus)
    );
    const expectedCount = requirement.minCount ?? 1;
    if (matching.length < expectedCount) {
      const details = [
        requirement.phase,
        requirement.resultStatus,
        requirement.outputStatus,
      ].filter((value): value is string => value !== undefined).join("/");
      errors.push(
        `Expected ${expectedCount} ${requirement.toolName} observation(s)${details.length > 0 ? ` with ${details}` : ""}; received ${matching.length}.`,
      );
    }
  }

  const forbidden = observation.tools
    .filter((tool) => SDK_AGENT_SHAKEDOWN_FORBIDDEN_MODEL_TOOLS.includes(
      tool.toolName as (typeof SDK_AGENT_SHAKEDOWN_FORBIDDEN_MODEL_TOOLS)[number],
    ))
    .map((tool) => tool.toolName);
  if (forbidden.length > 0) {
    errors.push(`Model used internal terminal tool(s): ${[...new Set(forbidden)].join(", ")}.`);
  }
  if (scenario.id === "coding") {
    errors.push(...validateCodingLifecycleObservation(observation.tools));
  }
  return errors;
}

export function summarizeSdkAgentShakedownLifecycle(
  tools: readonly SdkAgentShakedownToolObservation[],
): SdkAgentShakedownLifecycleDiagnostics {
  return {
    execStarts: tools.filter((tool) =>
      tool.toolName === "exec_command" && asString(tool.input?.command) !== undefined
    ).length,
    execContinuations: tools.filter((tool) =>
      tool.toolName === "exec_command" && asString(tool.input?.sessionId) !== undefined
    ).length,
    runningObservations: tools.filter((tool) =>
      tool.toolName === "exec_command" && tool.outputStatus === "running"
    ).length,
    terminalSettlements: tools.filter((tool) =>
      tool.toolName === "exec_command" && isTerminalProcessStatus(tool.outputStatus)
    ).length,
    observedMutationEvents: tools.filter((tool) => observedMutationPaths(tool).length > 0).length,
  };
}

export function validateCodingLifecycleObservation(
  tools: readonly SdkAgentShakedownToolObservation[],
): string[] {
  const errors: string[] = [];
  const completed = tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => tool.phase === "completed");
  const baselineRunning = completed.find(({ tool }) =>
    isCodingTestStart(tool) && tool.outputStatus === "running" && tool.sessionId !== undefined
  );
  if (baselineRunning === undefined) {
    return ["Coding lifecycle did not start the delayed baseline test as a running exec_command session."];
  }

  const baselineTerminal = completed.find(({ tool, index }) =>
    index > baselineRunning.index &&
    isExecContinuationFor(tool, baselineRunning.tool.sessionId) &&
    tool.outputStatus === "failed"
  );
  if (baselineTerminal === undefined) {
    errors.push(`Baseline test session ${baselineRunning.tool.sessionId} was not continued to terminal failed status.`);
  }

  const baselineTerminalIndex = baselineTerminal?.index ?? baselineRunning.index;
  const sourceMutation = completed.find(({ tool, index }) =>
    index > baselineTerminalIndex && changedPathEndsWith(tool, "coding-fixture/src/inventory.mjs")
  );
  if (sourceMutation === undefined) {
    errors.push("No observed inventory source mutation followed the failed baseline test.");
  }

  const sourceMutationIndex = sourceMutation?.index ?? baselineTerminalIndex;
  const passingRunning = completed.find(({ tool, index }) =>
    index > sourceMutationIndex &&
    isCodingTestStart(tool) &&
    tool.outputStatus === "running" &&
    tool.sessionId !== undefined
  );
  if (passingRunning === undefined) {
    errors.push("No delayed running test session followed the inventory source mutation.");
  }

  const passingTerminal = passingRunning === undefined
    ? undefined
    : completed.find(({ tool, index }) =>
        index > passingRunning.index &&
        isExecContinuationFor(tool, passingRunning.tool.sessionId) &&
        tool.outputStatus === "completed"
      );
  if (passingRunning !== undefined && passingTerminal === undefined) {
    errors.push(`Post-fix test session ${passingRunning.tool.sessionId} was not continued to terminal completed status.`);
  }

  const passingTerminalIndex = passingTerminal?.index ?? passingRunning?.index ?? sourceMutationIndex;
  const changelogMutation = completed.find(({ tool, index }) =>
    index > passingTerminalIndex && changedPathEndsWith(tool, "coding-fixture/CHANGELOG.md")
  );
  if (changelogMutation === undefined) {
    errors.push("No observed changelog mutation followed the passing test.");
  }

  if (changelogMutation !== undefined) {
    const mutationStep = changelogMutation.tool.stepIndex;
    const laterRead = completed.find(({ tool, index }) =>
      index > changelogMutation.index &&
      tool.toolName === "fs.read_text" &&
      inputPathEndsWith(tool, "coding-fixture/CHANGELOG.md") &&
      mutationStep !== undefined &&
      tool.stepIndex !== undefined &&
      tool.stepIndex > mutationStep
    );
    if (mutationStep === undefined) {
      errors.push("Changelog mutation is missing runtime step identity and cannot prove later freshness.");
    } else if (laterRead === undefined) {
      errors.push("Changelog read-back did not occur in a later runtime step after the mutation.");
    }
  }

  for (const running of completed.filter(({ tool }) =>
    tool.toolName === "exec_command" && tool.outputStatus === "running" && tool.sessionId !== undefined
  )) {
    const settled = completed.some(({ tool, index }) =>
      index > running.index &&
      isExecContinuationFor(tool, running.tool.sessionId) &&
      isTerminalProcessStatus(tool.outputStatus)
    );
    if (!settled) {
      errors.push(`Running exec_command session ${running.tool.sessionId} has no later terminal continuation.`);
    }
  }
  return errors;
}

export function readSdkAgentShakedownToolObservation(value: unknown): SdkAgentShakedownToolObservation | undefined {
  const event = asRecord(value);
  const payload = asRecord(event?.payload);
  const update = asRecord(payload?.update);
  let toolName = asString(update?.toolName);
  const phase = asToolPhase(update?.phase);
  if (toolName === undefined || phase === undefined) {
    return ;
  }
  let result = asRecord(update?.output);
  let auditRecord = asRecord(result?.auditRecord);
  let output = asRecord(auditRecord?.output);
  let toolInput = asRecord(update?.input);
  let durationMs = typeof update?.durationMs === "number" ? update.durationMs : undefined;
  if (toolName === "effect_result_lookup" && phase === "completed") {
    const effectToolResult = asRecord(output?.output);
    const effectAuditRecord = asRecord(effectToolResult?.auditRecord);
    const effectToolName = asString(effectToolResult?.toolName) ?? asString(effectAuditRecord?.toolName);
    if (effectToolName !== undefined && effectAuditRecord !== undefined) {
      toolName = effectToolName;
      result = effectToolResult;
      auditRecord = effectAuditRecord;
      output = asRecord(effectAuditRecord.output);
      toolInput = asRecord(effectAuditRecord.input) ?? toolInput;
      durationMs = typeof effectAuditRecord.durationMs === "number"
        ? effectAuditRecord.durationMs
        : durationMs;
    }
  }
  const changedFiles = Array.isArray(output?.changedFiles)
    ? output.changedFiles.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    toolName,
    phase,
    ...(readNonNegativeInteger(update?.seq) !== undefined
      ? { seq: readNonNegativeInteger(update?.seq) }
      : {}),
    ...(readNonNegativeInteger(update?.stepIndex) !== undefined
      ? { stepIndex: readNonNegativeInteger(update?.stepIndex) }
      : {}),
    ...(toolInput !== undefined ? { input: toolInput } : {}),
    ...(result?.status === "OK" || result?.status === "FAILED"
      ? { resultStatus: result.status }
      : {}),
    ...(asString(output?.status) !== undefined
      ? { outputStatus: asString(output?.status)?.toLowerCase() }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(asString(output?.sessionId) !== undefined ? { sessionId: asString(output?.sessionId) } : {}),
    ...(changedFiles !== undefined && changedFiles.length > 0 ? { changedFiles } : {}),
  };
}

function isCodingTestStart(tool: SdkAgentShakedownToolObservation): boolean {
  return tool.toolName === "exec_command" &&
    asString(tool.input?.command) === "npm test" &&
    normalizeRelativePath(asString(tool.input?.cwd)) === "coding-fixture" &&
    tool.input?.yieldTimeMs === 25;
}

function isExecContinuationFor(
  tool: SdkAgentShakedownToolObservation,
  sessionId: string | undefined,
): boolean {
  return sessionId !== undefined &&
    tool.toolName === "exec_command" &&
    asString(tool.input?.sessionId) === sessionId;
}

function isTerminalProcessStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "timeout" || status === "stopped";
}

function changedPathEndsWith(tool: SdkAgentShakedownToolObservation, suffix: string): boolean {
  const normalizedSuffix = suffix.replaceAll("\\", "/");
  return observedMutationPaths(tool).some((file) =>
    file.replaceAll("\\", "/").endsWith(normalizedSuffix)
  );
}

function observedMutationPaths(tool: SdkAgentShakedownToolObservation): string[] {
  const changedFiles = tool.changedFiles ?? [];
  if (
    tool.phase !== "completed" ||
    tool.resultStatus !== "OK" ||
    (tool.toolName !== "fs.replace_text" && tool.toolName !== "fs.write_text")
  ) {
    return changedFiles;
  }
  const path = asString(tool.input?.path);
  return path === undefined ? changedFiles : [...new Set([...changedFiles, path])];
}

function inputPathEndsWith(
  tool: SdkAgentShakedownToolObservation,
  suffix: string,
  field = "path",
): boolean {
  return asString(tool.input?.[field])?.replaceAll("\\", "/").endsWith(suffix) === true;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  return value?.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asToolPhase(value: unknown): SdkAgentShakedownToolObservation["phase"] | undefined {
  return value === "started" || value === "completed" || value === "failed" ? value : undefined;
}
