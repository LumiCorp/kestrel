import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ModelToolSpec } from "../src/kestrel/contracts/model-io.js";
import {
  buildKestrelAgentContext,
  buildKestrelAgentToolModelContext,
  buildKestrelAgentToolSurface,
  buildKestrelAgentValidationFeedbackMessage,
  type KestrelAgentContextBuildInput,
} from "../src/runtime/KestrelAgentContextBuilder.js";
import type { ModelTranscript } from "../src/runtime/modelTranscript.js";
import { defaultToolCatalog } from "../tools/catalog.js";

const CAPTURE_ROOT = path.join(
  process.cwd(),
  "docs/plans/context-captures/2026-07-03-agent-context",
);
const GENERATION_COMMAND = "node --import tsx scripts/context-capture-pack.ts";
const FIXED_CREATED_AT = "2026-07-03T00:00:00.000Z";
const TERMINAL_BENCH_WORKSPACE_TOOL_NAMES = [
  "effect_result_lookup",
  "fs.list",
  "fs.read_text",
  "fs.write_text",
  "fs.replace_text",
  "fs.search_text",
  "fs.mkdir",
  "exec_command",
] as const;
const SWE_VERIFIED_WORKSPACE_TOOL_NAMES = [
  "effect_result_lookup",
  "fs.read_text",
  "repo.trace",
  "fs.write_text",
  "fs.replace_text",
  "dev.shell.run",
] as const;

type CaptureScenarioKind = "real-profile" | "synthetic";

interface CaptureScenario {
  slug: string;
  title: string;
  description: string;
  scenarioKind: CaptureScenarioKind;
  sourceBuilder: string;
  toolSurfaceSource: string;
  knownLimitations: string[];
  input: KestrelAgentContextBuildInput;
  workspaceToolNames: string[];
  controlToolNames: string[];
  diagnosisFocus: string[];
  benchmarkSource?: "swe-verified" | "terminal-bench" | undefined;
}

interface CaptureSummary {
  slug: string;
  title: string;
  mode: string;
  submode?: string | undefined;
  promptVariant?: string | undefined;
  benchmarkSource?: string | undefined;
  scenarioKind: CaptureScenarioKind;
  sourceBuilder: string;
  sectionCount: number;
  renderedSections: string[];
  toolCount: number;
  transcriptItemKinds: string[];
}

async function main(): Promise<void> {
  const validationFeedback = buildKestrelAgentValidationFeedbackMessage({
    code: "DECISION_SCHEMA_FAILED",
    message: "Model chose prose instead of a required tool action.",
    schemaCategory: "tool_call",
    loopAttempt: 2,
    maxLoopAttempts: 4,
  });

  const scenarios = buildScenarios(validationFeedback);
  await mkdir(CAPTURE_ROOT, { recursive: true });

  const summaries: CaptureSummary[] = [];
  for (const scenario of scenarios) {
    summaries.push(await writeScenarioCapture(scenario));
  }

  await writeFile(path.join(CAPTURE_ROOT, "README.md"), renderReadme(summaries), "utf8");
  await writeFile(path.join(CAPTURE_ROOT, "diagnosis.md"), renderDiagnosis(scenarios), "utf8");

  process.stdout.write(`wrote ${scenarios.length} context capture(s) to ${path.relative(process.cwd(), CAPTURE_ROOT)}\n`);
}

function buildScenarios(validationFeedback: string): CaptureScenario[] {
  return [
    {
      slug: "normal-build",
      title: "Normal Build Task",
      description: "Build-mode software change with workspace metadata and ordinary filesystem/dev-shell tools.",
      scenarioKind: "synthetic",
      sourceBuilder: "synthetic fixture in scripts/context-capture-pack.ts",
      toolSurfaceSource: "scenario-specific synthetic workspace tools plus semantic Kestrel control tools",
      knownLimitations: [
        "Not tied to a persisted profile or benchmark job-input builder.",
        "Intended to exercise ordinary assembled build-mode context.",
      ],
      workspaceToolNames: ["fs.list", "fs.read_text", "fs.search_text", "fs.replace_text", "fs.write_text", "dev.shell.run", "repo.trace"],
      controlToolNames: ["kestrel.finalize", "kestrel.ask_user", "kestrel.cannot_satisfy", "kestrel.todo_update"],
      diagnosisFocus: [
        "Check whether validation guidance appears in both the system prompt and finalize tool in ways that compete.",
        "Check whether todo_update carries completion policy beyond narrow checklist state.",
      ],
      input: baseInput({
        goal: "Implement CSV export for the report view and verify the downloaded file includes the selected columns.",
        eventType: "job.run",
        interactionMode: "build",
        promptVariant: "reference-react:build",
        activeWorkspace: workspaceContext("/repo/kestrel-app", "Kestrel app"),
      }),
    },
    {
      slug: "plan-handoff",
      title: "Plan-Mode Handoff",
      description: "Planning turn that has enough context to produce a handoff into build mode.",
      scenarioKind: "synthetic",
      sourceBuilder: "synthetic fixture in scripts/context-capture-pack.ts",
      toolSurfaceSource: "scenario-specific synthetic planning tools plus semantic Kestrel plan control tools",
      knownLimitations: [
        "Not tied to a persisted profile or benchmark job-input builder.",
        "Intended to exercise assembled plan-mode handoff context.",
      ],
      workspaceToolNames: ["fs.list", "fs.read_text", "fs.search_text", "planning.write_document"],
      controlToolNames: ["kestrel.finalize", "kestrel.ask_user", "kestrel.handoff_to_build"],
      diagnosisFocus: [
        "Check whether the plan system prompt clearly separates planning artifacts from live execution progress.",
        "Check whether handoff tool wording duplicates the plan-mode prompt contract.",
      ],
      input: baseInput({
        goal: "Create a short implementation plan for consolidating duplicated settings validation.",
        eventType: "user.message",
        interactionMode: "plan",
        promptVariant: "reference-react:plan",
        activeWorkspace: workspaceContext("/repo/kestrel-app", "Kestrel app"),
      }),
    },
    {
      slug: "retry-rejected-action",
      title: "Retry After Rejected Action",
      description: "Build-mode retry after a schema/tool-call rejection has already been persisted in transcript state.",
      scenarioKind: "synthetic",
      sourceBuilder: "synthetic fixture in scripts/context-capture-pack.ts",
      toolSurfaceSource: "scenario-specific synthetic workspace tools plus semantic Kestrel control tools",
      knownLimitations: [
        "Not tied to a persisted profile or benchmark job-input builder.",
        "Uses a fixed synthetic retry feedback object to exercise active-correction rendering.",
      ],
      workspaceToolNames: ["fs.read_text", "fs.search_text", "dev.shell.run"],
      controlToolNames: ["kestrel.finalize", "kestrel.ask_user", "kestrel.cannot_satisfy", "kestrel.todo_update"],
      diagnosisFocus: [
        "Check whether rejected-action guidance is actionable enough at the next turn.",
        "Check whether retry fallback wording is too generic or duplicates validation language.",
      ],
      input: baseInput({
        goal: "Continue the failing build task and choose a valid next tool action.",
        eventType: "job.run",
        interactionMode: "build",
        promptVariant: "reference-react:build",
        retryContext: {
          failure: {
            code: "DECISION_SCHEMA_FAILED",
            message: "Model chose prose instead of a required tool action.",
            details: {
              modelFeedback: validationFeedback,
            },
            schemaCategory: "tool_call",
          },
        },
        reactState: {
          modelTranscript: transcript([
            userItem("mt_1_0001_user", "Continue the build task."),
            assistantItem("mt_1_0002_assistant_text", "I will inspect the file next."),
            correctionItem("mt_1_0003_correction", validationFeedback),
          ]),
        },
      }),
    },
    {
      slug: "visible-todo-flow",
      title: "Visible Todo Flow",
      description: "Build-mode turn with visible checklist state and a prior todo update in transcript.",
      scenarioKind: "synthetic",
      sourceBuilder: "synthetic fixture in scripts/context-capture-pack.ts",
      toolSurfaceSource: "scenario-specific synthetic workspace tools plus semantic Kestrel control tools",
      knownLimitations: [
        "Not tied to a persisted profile or benchmark job-input builder.",
        "Uses fixed visible todo state to exercise runtime todo rendering.",
      ],
      workspaceToolNames: ["fs.read_text", "fs.search_text", "fs.replace_text", "dev.shell.run"],
      controlToolNames: ["kestrel.finalize", "kestrel.ask_user", "kestrel.cannot_satisfy", "kestrel.todo_update"],
      diagnosisFocus: [
        "Check whether runtime context shows todo state without restating todo policy.",
        "Check whether completion requirements leak into todo_update instead of finalize/system prompt surfaces.",
      ],
      input: baseInput({
        goal: "Finish the error-boundary fix and verify the existing regression test still passes.",
        eventType: "job.run",
        interactionMode: "build",
        promptVariant: "reference-react:build",
        reactState: {
          visibleTodos: {
            objective: "Fix error boundary regression.",
            items: [
              { id: "inspect", text: "Inspect failing error-boundary path", status: "done", note: "Found ErrorBoundary.tsx and regression test." },
              { id: "patch", text: "Patch fallback rendering", status: "in_progress" },
              { id: "verify", text: "Run targeted regression test after patch", status: "pending" },
            ],
          },
          modelTranscript: transcript([
            userItem("mt_1_0001_user", "Finish the error-boundary fix."),
            assistantItem("mt_1_0002_todo_update", "Updated visible todos: inspect done, patch in progress, verify pending.", "todo_update"),
          ]),
        },
      }),
    },
    {
      slug: "swe-verified",
      title: "SWE Verified Task",
      description: "Benchmark task with issue text, hints, and Kestrel-added SWE Verified runner guidance.",
      scenarioKind: "real-profile",
      sourceBuilder: "scripts/swe-verified-bench.ts buildSweVerifiedJobInput",
      toolSurfaceSource: "SWE Verified profile toolAllowlist mirrored as workspace tools plus semantic Kestrel control tools",
      knownLimitations: [
        "Raw profile tool FinalizeAnswer is represented by semantic kestrel.finalize in the provider tool surface.",
        "The capture mirrors the current builder allowlist; rerun fidelity audit if buildSweVerifiedJobInput changes.",
      ],
      benchmarkSource: "swe-verified",
      workspaceToolNames: [...SWE_VERIFIED_WORKSPACE_TOOL_NAMES],
      controlToolNames: ["kestrel.finalize", "kestrel.cannot_satisfy", "kestrel.todo_update"],
      diagnosisFocus: [
        "Check whether SWE Verified reporter-hypothesis and emitted-semantics guidance is scoped to benchmark context.",
        "Check whether task-specific evidence requirements are present without bloating general build context.",
      ],
      input: baseInput({
        goal: "Resolve SWE-bench Verified instance sphinx-doc__sphinx-10466 in this checked-out repository.",
        eventType: "job.run",
        interactionMode: "build",
        promptVariant: "reference-react:build",
        activeWorkspace: workspaceContext("/testbed", "SWE-bench testbed"),
        eventPayload: {
          message: "Resolve SWE-bench Verified instance sphinx-doc__sphinx-10466 in this checked-out repository.",
          metadata: {
            benchmark: {
              name: "swe-verified",
              instanceId: "sphinx-doc__sphinx-10466",
              context: {
                source: "swe-verified",
                instanceId: "sphinx-doc__sphinx-10466",
                problemStatement: "Duplicate gettext catalog entries should be merged without changing emitted source location strings.",
                hintsText: "Reporter suggests path normalization may be involved; treat that as a hypothesis until confirmed.",
                workspaceRoot: "/testbed",
              },
            },
          },
        },
      }),
    },
    {
      slug: "terminal-bench",
      title: "Terminal-Bench Task",
      description: "Terminal-Bench task with raw adapter message and structured benchmark metadata.",
      scenarioKind: "real-profile",
      sourceBuilder: "benchmarks/terminal_bench/job_input.py build_terminal_bench_job_input",
      toolSurfaceSource: "Terminal-Bench profile toolAllowlist mirrored as workspace tools plus semantic Kestrel control tools",
      knownLimitations: [
        "Raw profile tool FinalizeAnswer is represented by semantic kestrel.finalize in the provider tool surface.",
        "The Python builder allowlist is mirrored by a TypeScript constant in this capture generator.",
      ],
      benchmarkSource: "terminal-bench",
      workspaceToolNames: [...TERMINAL_BENCH_WORKSPACE_TOOL_NAMES],
      controlToolNames: ["kestrel.finalize", "kestrel.cannot_satisfy", "kestrel.todo_update"],
      diagnosisFocus: [
        "Check whether the Terminal-Bench contract is specific enough without bleeding into general build tasks.",
        "Check whether noninteractive constraints conflict with generic ask_user guidance.",
      ],
      input: baseInput({
        goal: "Create /app/result.txt containing exactly the checksum printed by the public helper.",
        eventType: "job.run",
        interactionMode: "build",
        promptVariant: "reference-react:build",
        activeWorkspace: workspaceContext("/app", "Terminal-Bench task container"),
        eventPayload: {
          message: "Create /app/result.txt containing exactly the checksum printed by the public helper.",
          metadata: {
            benchmark: {
              name: "terminal-bench",
              taskId: "checksum-public-helper",
              context: {
                source: "terminal-bench",
                taskId: "checksum-public-helper",
                workspaceRoot: "/app",
              },
            },
          },
        },
      }),
    },
    {
      slug: "tool-result-heavy",
      title: "Tool-Result-Heavy Run",
      description: "Build-mode continuation after multiple tool calls and compact model-visible tool result summaries.",
      scenarioKind: "synthetic",
      sourceBuilder: "synthetic fixture in scripts/context-capture-pack.ts",
      toolSurfaceSource: "scenario-specific synthetic workspace tools plus semantic Kestrel control tools",
      knownLimitations: [
        "Not tied to a persisted profile or benchmark job-input builder.",
        "Uses fixed transcript tool results to exercise compact failed-tool evidence rendering.",
      ],
      workspaceToolNames: ["fs.list", "fs.read_text", "fs.search_text", "fs.replace_text", "dev.shell.run", "repo.trace"],
      controlToolNames: ["kestrel.finalize", "kestrel.ask_user", "kestrel.cannot_satisfy", "kestrel.todo_update"],
      diagnosisFocus: [
        "Check whether tool result summaries preserve enough observed evidence for the next action.",
        "Check whether transcript repair/tool result formatting belongs in modelTranscript or a semantic owner.",
      ],
      input: baseInput({
        goal: "Continue from the gathered evidence and patch the failing route test.",
        eventType: "job.run",
        interactionMode: "build",
        promptVariant: "reference-react:build",
        reactState: {
          modelTranscript: transcript([
            userItem("mt_1_0001_user", "Patch the failing route test."),
            toolCallItem("mt_1_0002_tool_call", "fs.search_text", { path: "src", query: "route handler" }, "call_search"),
            toolResultItem(
              "mt_1_0003_tool_result",
              "fs.search_text",
              { path: "src", query: "route handler" },
              {
                path: "src",
                query: "route handler",
                matches: [
                  { path: "src/app/api/report/route.ts", line: 42, preview: "export async function GET(request: Request)" },
                ],
              },
              "tool-output:search",
              "call_search",
            ),
            toolCallItem("mt_1_0004_tool_call", "fs.read_text", { path: "src/app/api/report/route.ts" }, "call_read"),
            toolResultItem(
              "mt_1_0005_tool_result",
              "fs.read_text",
              { path: "src/app/api/report/route.ts" },
              { path: "src/app/api/report/route.ts", content: "export async function GET() { return Response.json({ ok: true }); }\n" },
              "tool-output:read",
              "call_read",
            ),
            toolCallItem("mt_1_0006_tool_call", "dev.shell.run", { command: "pnpm test report-route", cwd: "/repo/kestrel-app" }, "call_test"),
            toolResultItem(
              "mt_1_0007_tool_result",
              "dev.shell.run",
              { command: "pnpm test report-route", cwd: "/repo/kestrel-app" },
              { command: "pnpm test report-route", cwd: "/repo/kestrel-app", exitCode: 1, stdout: "", stderr: "expected 200 received 500" },
              "tool-output:test",
              "call_test",
              "FAILED",
            ),
          ]),
        },
      }),
    },
  ];
}

async function writeScenarioCapture(scenario: CaptureScenario): Promise<CaptureSummary> {
  const output = buildKestrelAgentContext(scenario.input);
  const workspaceTools = defaultToolCatalog.toModelTools(scenario.workspaceToolNames);
  const toolSurface = buildKestrelAgentToolSurface({
    workspaceTools,
    controlToolNames: scenario.controlToolNames,
  });
  const dir = path.join(CAPTURE_ROOT, scenario.slug);
  await mkdir(dir, { recursive: true });

  const transcriptState = output.transcript;
  const metadata = {
    capture: {
      scenario: scenario.slug,
      title: scenario.title,
      description: scenario.description,
      scenarioKind: scenario.scenarioKind,
      sourceBuilder: scenario.sourceBuilder,
      toolSurfaceSource: scenario.toolSurfaceSource,
      knownLimitations: scenario.knownLimitations,
      generationCommand: GENERATION_COMMAND,
      mode: scenario.input.interactionMode,
      submode: scenario.input.actSubmode ?? null,
      promptVariant: scenario.input.promptVariant ?? null,
      benchmarkSource: scenario.benchmarkSource ?? null,
      toolCount: toolSurface.requestTools.length,
      canonicalToolNames: toolSurface.entries.map((entry) => entry.canonicalName),
      providerToolNames: toolSurface.entries.map((entry) => entry.providerName),
      transcriptItemKinds: transcriptState.items.map((item) => item.kind),
    },
    context: output.metadata,
  };

  await writeJson(path.join(dir, "model-input.json"), output.modelInput);
  await writeJson(path.join(dir, "messages.json"), output.messages);
  await writeJson(path.join(dir, "tools.json"), {
    requestTools: toolSurface.requestTools,
    aliases: toolSurface.entries.map((entry) => ({
      providerName: entry.providerName,
      canonicalName: entry.canonicalName,
      kind: entry.kind,
      description: entry.description,
    })),
  });
  await writeJson(path.join(dir, "metadata.json"), metadata);
  await writeJson(path.join(dir, "transcript-state.json"), transcriptState);
  await writeFile(path.join(dir, "notes.md"), renderScenarioNotes(scenario, metadata.capture), "utf8");

  return {
    slug: scenario.slug,
    title: scenario.title,
    mode: scenario.input.interactionMode,
    ...(scenario.input.actSubmode !== undefined ? { submode: scenario.input.actSubmode } : {}),
    ...(scenario.input.promptVariant !== undefined ? { promptVariant: scenario.input.promptVariant } : {}),
    ...(scenario.benchmarkSource !== undefined ? { benchmarkSource: scenario.benchmarkSource } : {}),
    scenarioKind: scenario.scenarioKind,
    sourceBuilder: scenario.sourceBuilder,
    sectionCount: output.metadata.sections.length,
    renderedSections: output.metadata.sections.filter((section) => section.rendered).map((section) => section.id),
    toolCount: toolSurface.requestTools.length,
    transcriptItemKinds: transcriptState.items.map((item) => item.kind),
  };
}

function baseInput(input: {
  goal: string;
  eventType: string;
  interactionMode: "chat" | "plan" | "build";
  promptVariant: string;
  actSubmode?: string | undefined;
  activeWorkspace?: unknown;
  eventPayload?: Record<string, unknown> | undefined;
  reactState?: Record<string, unknown> | undefined;
  retryContext?: Record<string, unknown> | undefined;
}): KestrelAgentContextBuildInput {
  return {
    reactState: input.reactState ?? {},
    eventPayload: input.eventPayload ?? { message: input.goal },
    eventType: input.eventType,
    goal: input.goal,
    interactionMode: input.interactionMode,
    ...(input.actSubmode !== undefined ? { actSubmode: input.actSubmode } : {}),
    promptVariant: input.promptVariant,
    ...(input.activeWorkspace !== undefined ? { activeWorkspace: input.activeWorkspace } : {}),
    ...(input.retryContext !== undefined ? { retryContext: input.retryContext } : {}),
    systemPrompt: {
      kind: "reference-react-deliberator",
      interactionMode: input.interactionMode,
      promptVariant: input.promptVariant,
    },
  };
}

function workspaceContext(workspaceRoot: string, label: string): Record<string, unknown> {
  return {
    workspaceId: label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""),
    workspaceRoot,
    appRoot: ".",
    packageManager: "pnpm",
    commands: {
      test: "pnpm run test",
      build: "pnpm run build",
    },
    label,
  };
}

function transcript(items: ModelTranscript["items"]): ModelTranscript {
  return {
    version: 1,
    windowId: 1,
    items,
  };
}

function userItem(id: string, content: string): ModelTranscript["items"][number] {
  return {
    id,
    createdAt: FIXED_CREATED_AT,
    kind: "user",
    content,
  };
}

function assistantItem(
  id: string,
  content: string,
  kind: "assistant_text" | "todo_update" = "assistant_text",
): ModelTranscript["items"][number] {
  return {
    id,
    createdAt: FIXED_CREATED_AT,
    kind,
    content,
  };
}

function correctionItem(id: string, content: string): ModelTranscript["items"][number] {
  return {
    id,
    createdAt: FIXED_CREATED_AT,
    kind: "correction",
    content,
  };
}

function toolCallItem(
  id: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolCallId: string,
): ModelTranscript["items"][number] {
  return {
    id,
    createdAt: FIXED_CREATED_AT,
    kind: "tool_call",
    toolName,
    toolInput,
    toolCallId,
  };
}

function toolResultItem(
  id: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: unknown,
  rawOutputRef: string,
  toolCallId: string,
  status: "OK" | "FAILED" = "OK",
): ModelTranscript["items"][number] {
  const modelContext = buildKestrelAgentToolModelContext({
    toolName,
    toolInput,
    toolOutput,
    rawOutputRef,
    status,
  });
  return {
    id,
    createdAt: FIXED_CREATED_AT,
    kind: "tool_result",
    toolName,
    toolInput,
    toolOutput: modelContext,
    toolCallId,
    rawOutputRef,
    truncated: modelContext.truncated,
  };
}

function renderReadme(summaries: CaptureSummary[]): string {
  return [
    "---",
    "id: kestrel-agent-context-capture-pack-2026-07-03",
    "domain: runtime",
    "status: active",
    "owner: kestrel-runtime",
    "last_verified_at: 2026-07-03",
    "---",
    "",
    "# Kestrel Agent Context Capture Pack",
    "",
    "This pack captures representative provider-facing model inputs after the semantic context refactor.",
    "It is intentionally non-behavioral: the generator calls the public context assembly path and the public tool-surface builder, then writes review artifacts for prompt-quality diagnosis.",
    "",
    `Generation command: \`${GENERATION_COMMAND}\``,
    "",
    "Each scenario directory contains:",
    "",
    "- `model-input.json`: structured model input object returned by `buildKestrelAgentContext`.",
    "- `messages.json`: provider-facing message array returned by `buildKestrelAgentContext`.",
    "- `tools.json`: provider-facing tool specs and canonical/provider alias map from `buildKestrelAgentToolSurface`.",
    "- `metadata.json`: capture metadata, rendered context sections, tool counts, aliases, and transcript item kinds.",
    "- `transcript-state.json`: normalized transcript state returned by the context builder.",
    "- `notes.md`: scenario purpose and diagnosis focus.",
    "",
    "## Scenarios",
    "",
    "| capture | kind | source builder | mode | benchmark | rendered sections | tools | transcript item kinds |",
    "| --- | --- | --- | --- | --- | --- | ---: | --- |",
    ...summaries.map((summary) =>
      [
        `| [${summary.slug}](./${summary.slug}/notes.md)`,
        summary.scenarioKind,
        summary.sourceBuilder,
        summary.mode,
        summary.benchmarkSource ?? "",
        summary.renderedSections.join(", "),
        String(summary.toolCount),
        summary.transcriptItemKinds.join(", "),
      ].join(" | ") + " |"
    ),
    "",
    "## Review Rule",
    "",
    "Diagnose from these assembled artifacts first. Source ownership is relevant only after a finding is tied to an exact message, tool description, runtime section, or transcript item in the capture.",
    "",
  ].join("\n");
}

function renderScenarioNotes(
  scenario: CaptureScenario,
  capture: {
    generationCommand: string;
    mode: string;
    submode: string | null;
    promptVariant: string | null;
    benchmarkSource: string | null;
    scenarioKind: CaptureScenarioKind;
    sourceBuilder: string;
    toolSurfaceSource: string;
    knownLimitations: string[];
    toolCount: number;
    canonicalToolNames: string[];
    providerToolNames: string[];
    transcriptItemKinds: string[];
  },
): string {
  return [
    "---",
    `id: kestrel-agent-context-capture-${scenario.slug}-2026-07-03`,
    "domain: runtime",
    "status: active",
    "owner: kestrel-runtime",
    "last_verified_at: 2026-07-03",
    "---",
    "",
    `# ${scenario.title}`,
    "",
    scenario.description,
    "",
    "## Capture Metadata",
    "",
    `- scenario: \`${scenario.slug}\``,
    `- scenarioKind: \`${capture.scenarioKind}\``,
    `- sourceBuilder: \`${capture.sourceBuilder}\``,
    `- toolSurfaceSource: \`${capture.toolSurfaceSource}\``,
    `- mode: \`${capture.mode}\``,
    `- submode: ${capture.submode === null ? "`none`" : `\`${capture.submode}\``}`,
    `- promptVariant: ${capture.promptVariant === null ? "`none`" : `\`${capture.promptVariant}\``}`,
    `- benchmarkSource: ${capture.benchmarkSource === null ? "`none`" : `\`${capture.benchmarkSource}\``}`,
    `- toolCount: ${capture.toolCount}`,
    `- transcriptItemKinds: ${capture.transcriptItemKinds.length === 0 ? "`none`" : capture.transcriptItemKinds.map((kind) => `\`${kind}\``).join(", ")}`,
    `- generationCommand: \`${capture.generationCommand}\``,
    "",
    "## Known Limitations",
    "",
    ...capture.knownLimitations.map((item) => `- ${item}`),
    "",
    "## Diagnosis Focus",
    "",
    ...scenario.diagnosisFocus.map((item) => `- ${item}`),
    "",
    "## Artifact Pointers",
    "",
    "- [messages.json](./messages.json) is the primary provider-facing prompt/context artifact.",
    "- [tools.json](./tools.json) is the primary provider-facing tool-description artifact.",
    "- [metadata.json](./metadata.json) records rendered sections, tool aliases, and transcript item kinds for before/after diffs.",
    "- [model-input.json](./model-input.json) preserves the structured context request returned by the builder.",
    "- [transcript-state.json](./transcript-state.json) preserves the normalized transcript returned by the builder.",
    "",
  ].join("\n");
}

function renderDiagnosis(scenarios: CaptureScenario[]): string {
  const rows = [
    {
      capture: "normal-build",
      finding: "Completion/validation concepts appear in both system prompt and finalize tool description.",
      evidence: "`normal-build/messages.json` system message; `normal-build/tools.json` alias `kestrel_finalize`.",
      owner: "systemPrompts/toolContext",
      severity: "medium",
      hypothesis: "Keep general workflow in system prompt and make finalize only the closeout truth contract.",
    },
    {
      capture: "visible-todo-flow",
      finding: "Todo surface should be checked for remaining completion-policy wording.",
      evidence: "`visible-todo-flow/messages.json` runtime context; `visible-todo-flow/tools.json` alias `kestrel_todo_update`.",
      owner: "runtimeContext/toolContext",
      severity: "medium",
      hypothesis: "Keep todo_update limited to checklist mutation semantics and keep completion policy out of the todo tool.",
    },
    {
      capture: "swe-verified",
      finding: "SWE Verified reporter-hypothesis and emitted-semantics guidance needs review.",
      evidence: "`swe-verified/model-input.json` taskInstruction and `swe-verified/messages.json` runtime context.",
      owner: "benchmarkContext",
      severity: "high",
      hypothesis: "Keep general validation policy outside benchmark context, and add only SWE Verified-specific risk framing for reporter hypotheses and emitted semantics.",
    },
    {
      capture: "terminal-bench",
      finding: "Noninteractive benchmark constraint may conflict with generic ask-user guidance if ask_user is unavailable but system prompt remains generic.",
      evidence: "`terminal-bench/model-input.json` taskInstruction; `terminal-bench/tools.json` control aliases.",
      owner: "benchmarkContext/systemPrompts",
      severity: "medium",
      hypothesis: "Let Terminal-Bench context override clarification behavior only for benchmark turns, without changing general build wording.",
    },
    {
      capture: "retry-rejected-action",
      finding: "Retry feedback should be reviewed for specificity and timing.",
      evidence: "`retry-rejected-action/messages.json` correction message and runtime `Correction needed` section.",
      owner: "retryContext/runtimeContext",
      severity: "medium",
      hypothesis: "Prefer structured correction facts and reduce fallback prose when the next valid action is already explicit.",
    },
    {
      capture: "tool-result-heavy",
      finding: "Tool result summaries and transcript repair language need an ownership decision before wording changes.",
      evidence: "`tool-result-heavy/messages.json` tool messages; `tool-result-heavy/transcript-state.json` tool_result items.",
      owner: "toolContext/modelTranscript",
      severity: "low",
      hypothesis: "Keep mechanical transcript repair in modelTranscript, but route semantic tool-result summaries through toolContext.",
    },
  ];

  return [
    "---",
    "id: kestrel-agent-context-capture-diagnosis-2026-07-03",
    "domain: runtime",
    "status: active",
    "owner: kestrel-runtime",
    "last_verified_at: 2026-07-03",
    "---",
    "",
    "# Context Quality Diagnosis",
    "",
    "This table is an initial review queue for prompt optimization. Each row points to assembled capture artifacts, not source files, unless source ownership is part of the suspected fix.",
    "",
    "| capture | finding | evidence | suspected owner | severity | proposed hypothesis | status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      `| ${row.capture} | ${row.finding} | ${row.evidence} | ${row.owner} | ${row.severity} | ${row.hypothesis} | open |`
    ),
    "",
    "## Capture Set",
    "",
    ...scenarios.map((scenario) => `- [${scenario.slug}](./${scenario.slug}/notes.md): ${scenario.description}`),
    "",
  ].join("\n");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(sortJson(value), null, 2)}\n`, "utf8");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    output[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return output;
}

main().catch((error) => {
  process.stderr.write(`context capture pack failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
