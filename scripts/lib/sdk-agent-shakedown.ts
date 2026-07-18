export type SdkAgentShakedownScenarioId = "read" | "filesystem" | "exec";

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
}

export interface SdkAgentShakedownToolObservation {
  toolName: string;
  phase: "started" | "completed" | "failed";
  resultStatus?: "OK" | "FAILED" | undefined;
  outputStatus?: string | undefined;
  durationMs?: number | undefined;
  sessionId?: string | undefined;
  changedFiles?: string[] | undefined;
}

export interface SdkAgentShakedownObservation {
  terminalType: string;
  outputStatus?: string | undefined;
  assistantText?: string | null | undefined;
  visibleTodos?: unknown;
  tools: SdkAgentShakedownToolObservation[];
}

export const SDK_AGENT_SHAKEDOWN_DEFAULT_MODEL = "openai/gpt-5.4-mini";

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
      `Unknown SDK shake-down scenario(s): ${unknown.join(", ")}. Expected read, filesystem, or exec.`,
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
