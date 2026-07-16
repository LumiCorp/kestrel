import test from "node:test";
import assert from "node:assert/strict";

import { createToolCatalog, defaultToolCatalog, DEFAULT_BALANCED_TOOL_ALLOWLIST } from "../../tools/index.js";
import type { SharedToolModule } from "../../tools/contracts.js";
import { finalizeAnswerTool } from "../../tools/runtime/finalizeAnswer.js";
import { isAgentToolResult } from "../../tools/toolResult.js";
import { validateToolActionSchemas } from "../../agents/reference-react/src/decision/compileIntent.js";

test("tool catalog resolves model tool definitions by allowlist", () => {
  const tools = defaultToolCatalog.toModelTools(["free.time.current", "free.hn.top"]);

  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.name, "free.time.current");
  assert.equal(tools[1]?.name, "free.hn.top");
});

test("tool catalog wraps raw handlers in AgentToolResult envelopes", async () => {
  const module: SharedToolModule = {
    definition: {
      name: "demo.raw_tool",
      description: "Demo raw tool",
      inputSchema: {
        type: "object",
        additionalProperties: true,
      },
      capability: {
        freshnessClass: "static",
        latencyClass: "low",
        costClass: "free",
        executionClass: "read_only",
        capabilityClasses: ["demo.raw_tool"],
      },
      presentation: {
        displayName: "Demo Raw Tool",
        aliases: ["demo.raw_tool"],
        keywords: ["demo"],
        provider: "demo",
        toolFamily: "demo",
      },
    },
    createHandler: () => async () => ({ ok: true }),
  };
  const catalog = createToolCatalog([module]);
  const handlers = catalog.createHandlers(["demo.raw_tool"], {});

  const result = await handlers["demo.raw_tool"]?.({ value: "x" });

  assert.equal(isAgentToolResult(result), true);
  assert.equal(result?.toolName, "demo.raw_tool");
  assert.equal(result?.status, "OK");
  assert.deepEqual(result?.auditRecord.output, { ok: true });
  assert.match(result?.modelContext.text ?? "", /Raw output ref: tool-output:[a-f0-9]{16}/u);
});

test("dev shell tool descriptions distinguish bounded exec from live-process input", () => {
  const tools = defaultToolCatalog.toModelTools(["exec_command", "dev.shell.run", "dev.process.write"]);
  const unifiedTool = tools.find((tool) => tool.name === "exec_command");
  const execTool = tools.find((tool) => tool.name === "dev.shell.run");
  const writeTool = tools.find((tool) => tool.name === "dev.process.write");

  assert.match(unifiedTool?.description ?? "", /Run one bounded shell command/u);
  assert.match(unifiedTool?.description ?? "", /Command shape: use command/u);
  assert.match(unifiedTool?.description ?? "", /return its final output and status/u);
  assert.match(unifiedTool?.description ?? "", /do not include sessionId, stdin, or stop/u);
  assert.match(unifiedTool?.description ?? "", /Continue\/read shape: only use sessionId/u);
  assert.match(unifiedTool?.description ?? "", /existing live process session from runtime context/u);
  assert.match(unifiedTool?.description ?? "", /Never invent sessionId/u);
  assert.match(unifiedTool?.description ?? "", /sessionId/i);
  assert.match(unifiedTool?.description ?? "", /raw input/i);
  assert.match(unifiedTool?.description ?? "", /include the newline/i);
  assert.doesNotMatch(unifiedTool?.description ?? "", /guidance/i);
  assert.match(execTool?.description ?? "", /bounded shell command/i);
  assert.match(execTool?.description ?? "", /scaffolding, installs, builds, tests/i);
  assert.match(writeTool?.description ?? "", /create files/i);
  assert.match(writeTool?.description ?? "", /existing managed live process/i);
});

test("exec_command schema exposes exclusive lifecycle branches", () => {
  const [execTool] = defaultToolCatalog.toModelTools(["exec_command"]);
  assert.ok(execTool);
  assert.equal(Array.isArray(execTool.inputSchema.oneOf), true);

  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "exec_command",
        input: {
          workspaceRoot: "/app",
          command: "./maze_game.sh",
          cwd: "/app",
        },
      },
      [execTool],
    ),
  );
  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "exec_command",
        input: {
          sessionId: "tb-proc-123",
          stdin: "move N\n",
        },
      },
      [execTool],
    ),
  );
  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "exec_command",
        input: {
          sessionId: "tb-proc-123",
          stop: true,
        },
      },
      [execTool],
    ),
  );
  assert.throws(
    () =>
      validateToolActionSchemas(
        {
          kind: "tool",
          name: "exec_command",
          input: {
            command: "./maze_game.sh",
            sessionId: "none",
            stdin: "",
          },
        },
        [execTool],
      ),
    /input failed schema validation/u,
  );
});

test("finalize tool description stays a caller-facing payload contract", () => {
  const tools = defaultToolCatalog.toModelTools(["FinalizeAnswer"]);
  const finalizeTool = tools.find((tool) => tool.name === "FinalizeAnswer");

  assert.match(finalizeTool?.description ?? "", /Finalize an agent turn with a caller-facing payload/u);
  assert.match(finalizeTool?.description ?? "", /For code changes, success means the main requested outcome passed after the final edit/u);
  assert.match(finalizeTool?.description ?? "", /every explicit task constraint was checked/u);
  assert.match(finalizeTool?.description ?? "", /include what passed/u);
  assert.doesNotMatch(finalizeTool?.description ?? "", /swe-verified|sweValidation|benchmark|validation proof|edited tests/i);
});

test("tool catalog throws on unknown allowlisted tool", () => {
  assert.throws(
    () => defaultToolCatalog.toModelTools(["not.real.tool"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "TOOL_LOOKUP_FAILED",
  );
  assert.throws(
    () => defaultToolCatalog.createHandlers(["not.real.tool"], {}),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "TOOL_LOOKUP_FAILED",
  );
});

test("tool catalog rejects duplicate tool definition names", () => {
  assert.throws(
    () => createToolCatalog([finalizeAnswerTool, finalizeAnswerTool]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "TOOL_DUPLICATE_DEFINITION",
  );
});

test("tool catalog exposes capability manifest for allowlisted tools", () => {
  const manifest = defaultToolCatalog.toCapabilityManifest([
    "free.time.current",
    "internet.search",
  ]);

  assert.equal(manifest.length, 2);
  assert.equal(manifest[0]?.name, "free.time.current");
  assert.equal(manifest[0]?.freshnessClass, "live");
  assert.deepEqual(manifest[0]?.capabilityClasses, ["time.current"]);
  assert.equal(manifest[0]?.displayName, "Current Time");
  assert.equal(manifest[1]?.name, "internet.search");
  assert.equal(manifest[1]?.costClass, "metered");
  assert.deepEqual(manifest[1]?.capabilityClasses, ["web.search", "reference.search"]);
  assert.equal(manifest[1]?.displayName, "Internet Search");
  assert.equal(Array.isArray(manifest[1]?.aliases), true);
  assert.equal(manifest[1]?.provider, "tavily");
  assert.equal(manifest[1]?.toolFamily, "internet");
});

test("internet retrieval tool descriptions distinguish broad gathering from targeted follow-up", () => {
  const tools = defaultToolCatalog.toModelTools([
    "internet.news",
    "internet.search",
    "internet.search_advanced",
  ]);
  const newsTool = tools.find((tool) => tool.name === "internet.news");
  const searchTool = tools.find((tool) => tool.name === "internet.search");
  const advancedTool = tools.find((tool) => tool.name === "internet.search_advanced");

  assert.match(newsTool?.description ?? "", /use this first/i);
  assert.match(newsTool?.description ?? "", /broad current-news gathering/i);
  assert.match(searchTool?.description ?? "", /broad web retrieval/i);
  assert.match(searchTool?.description ?? "", /prefer this over internet\.search_advanced for initial gathering/i);
  assert.match(advancedTool?.description ?? "", /only after broad internet\.news or internet\.search gathering has already happened/i);
  assert.match(advancedTool?.description ?? "", /do not use this as the default broad story-gathering tool/i);
  assert.match(advancedTool?.description ?? "", /stop using it once the retained evidence set is large enough to synthesize/i);
});

test("tool catalog exposes code.execute capability metadata", () => {
  const manifest = defaultToolCatalog.toCapabilityManifest(["code.execute"]);

  assert.equal(manifest[0]?.name, "code.execute");
  assert.equal(manifest[0]?.freshnessClass, "volatile");
  assert.equal(manifest[0]?.latencyClass, "high");
  assert.deepEqual(manifest[0]?.capabilityClasses, ["code.execute", "code.sandbox"]);
  assert.deepEqual(manifest[0]?.approvalCapabilities, ["code.execute"]);
});

test("tool catalog exposes filesystem tool capability metadata", () => {
  const writeTool = defaultToolCatalog.toModelTools(["fs.write_text"])[0];
  const replaceTool = defaultToolCatalog.toModelTools(["fs.replace_text"])[0];
  const repoTraceTool = defaultToolCatalog.toModelTools(["repo.trace"])[0];
  const manifest = defaultToolCatalog.toCapabilityManifest([
    "fs.read_text",
    "repo.trace",
    "fs.write_text",
    "fs.replace_text",
  ]);

  assert.equal(manifest[0]?.name, "fs.read_text");
  assert.equal(manifest[0]?.freshnessClass, "volatile");
  assert.equal(manifest[0]?.latencyClass, "low");
  assert.equal(manifest[0]?.costClass, "free");
  assert.equal(manifest[0]?.executionClass, "read_only");
  assert.deepEqual(manifest[0]?.capabilityClasses, ["fs.read"]);
  assert.deepEqual(manifest[0]?.approvalCapabilities, ["workspace.read"]);

  assert.equal(manifest[1]?.name, "repo.trace");
  assert.equal(manifest[1]?.freshnessClass, "volatile");
  assert.equal(manifest[1]?.latencyClass, "low");
  assert.equal(manifest[1]?.costClass, "free");
  assert.equal(manifest[1]?.executionClass, "read_only");
  assert.deepEqual(manifest[1]?.capabilityClasses, ["fs.read", "repo.trace"]);
  assert.deepEqual(manifest[1]?.approvalCapabilities, ["workspace.read"]);
  assert.match(repoTraceTool?.description ?? "", /Trace exact strings or symbols across repository text/u);
  assert.deepEqual(repoTraceTool?.inputSchema.required, ["seeds"]);

  assert.equal(manifest[2]?.name, "fs.write_text");
  assert.equal(manifest[2]?.executionClass, "sandboxed_only");
  assert.deepEqual(manifest[2]?.capabilityClasses, ["fs.write"]);
  assert.deepEqual(manifest[2]?.approvalCapabilities, ["workspace.write"]);
  assert.match(writeTool?.description ?? "", /explicit file creation, generated whole-file artifacts/i);
  assert.match(writeTool?.description ?? "", /only when the task calls for whole-file output/i);
  assert.match(writeTool?.description ?? "", /existing files with structure, token, formatting, or allowed-change constraints/i);
  assert.match(writeTool?.description ?? "", /prefer fs\.replace_text or a bounded script/i);
  assert.match(writeTool?.description ?? "", /prefer the normal shell generator command/i);
  assert.match(writeTool?.description ?? "", /preserve existing assertions unless the requested behavior requires changing them/i);

  assert.equal(manifest[3]?.name, "fs.replace_text");
  assert.equal(manifest[3]?.executionClass, "sandboxed_only");
  assert.deepEqual(manifest[3]?.capabilityClasses, ["fs.patch"]);
  assert.deepEqual(manifest[3]?.approvalCapabilities, ["workspace.write"]);
  assert.match(replaceTool?.description ?? "", /targeted edits to existing files/i);
  assert.match(replaceTool?.description ?? "", /preserving surrounding structure, token count, formatting, or other allowed-change constraints/i);
  assert.match(replaceTool?.description ?? "", /NO_CHANGE or changed is false/i);
  assert.match(replaceTool?.description ?? "", /requested replacement did not happen/i);
  assert.match(replaceTool?.description ?? "", /preserve existing assertions unless the requested behavior requires changing them/i);
});

test("default balanced allowlist exposes retained runtime tools only", async () => {
  assert.equal(DEFAULT_BALANCED_TOOL_ALLOWLIST.includes("FinalizeAnswer"), true);
  assert.equal(DEFAULT_BALANCED_TOOL_ALLOWLIST.includes("planning.write_document"), true);
  assert.equal(DEFAULT_BALANCED_TOOL_ALLOWLIST.includes("task.propose"), true);
  assert.equal(DEFAULT_BALANCED_TOOL_ALLOWLIST.includes("project.card.create"), false);
  assert.equal(DEFAULT_BALANCED_TOOL_ALLOWLIST.includes("project.card.move"), false);
  assert.equal(DEFAULT_BALANCED_TOOL_ALLOWLIST.includes("project.card.update"), false);
});

test("planning write document is model-visible planning write tool", () => {
  const [tool] = defaultToolCatalog.toModelTools(["planning.write_document"]);
  const [manifest] = defaultToolCatalog.toCapabilityManifest(["planning.write_document"]);

  assert.equal(tool?.name, "planning.write_document");
  assert.match(tool?.description ?? "", /canonical PLAN\.md/u);
  assert.deepEqual(tool?.inputSchema.required, ["content"]);
  assert.equal(manifest?.executionClass, "planning_write");
  assert.deepEqual(manifest?.capabilityClasses, ["workspace.write.planning"]);
});

test("project board tools are no longer model-visible side-effect tools", async () => {
  assert.throws(() => defaultToolCatalog.toModelTools(["project.card.create"]), /Unknown tool/u);
  assert.throws(() => defaultToolCatalog.toCapabilityManifest(["project.card.move"]), /Unknown tool/u);
  assert.throws(() => defaultToolCatalog.createHandlers(["project.card.update"], {}), /Unknown tool/u);
});

test("mission control task proposal tool is the model-visible project follow-up tool", async () => {
  const [tool] = defaultToolCatalog.toModelTools(["task.propose"]);
  const [manifest] = defaultToolCatalog.toCapabilityManifest(["task.propose"]);

  assert.equal(tool?.name, "task.propose");
  assert.match(tool?.description ?? "", /Propose a Mission Control task/u);
  assert.deepEqual(tool?.inputSchema.required, ["sessionId", "title", "instructions"]);
  assert.equal(manifest?.executionClass, "external_side_effect");
  assert.deepEqual(manifest?.capabilityClasses, ["runtime.project.task_queue"]);
  assert.deepEqual(manifest?.approvalCapabilities, ["project.task_queue.write"]);
  assert.deepEqual(manifest?.allowedInteractionModes, ["chat", "build"]);
});

test("authorized app mutations opt into Chat while agent branch push remains Build-only", () => {
  const manifest = defaultToolCatalog.toCapabilityManifest([
    "kestrel_one.google_calendar_create_event",
    "kestrel_one.github_issue_create",
    "kestrel_one.github_push_agent_branch",
  ]);
  assert.deepEqual(manifest[0]?.allowedInteractionModes, ["chat", "build"]);
  assert.deepEqual(manifest[1]?.allowedInteractionModes, ["chat", "build"]);
  assert.equal(manifest[2]?.allowedInteractionModes, undefined);
  assert.equal(manifest[2]?.executionClass, "external_side_effect");
});

test("fs.mkdir tool description makes the acknowledgment contract explicit", () => {
  const [mkdirTool] = defaultToolCatalog.toModelTools(["fs.mkdir"]);

  assert.equal(mkdirTool?.name, "fs.mkdir");
  assert.match(mkdirTool?.description ?? "", /acknowledgment/i);
  assert.match(mkdirTool?.description ?? "", /visible artifact/i);
});

test("dev shell tool descriptions distinguish exec from stdin writes", () => {
  const [execTool, writeTool] = defaultToolCatalog.toModelTools(["dev.shell.run", "dev.process.write"]);

  assert.equal(execTool?.name, "dev.shell.run");
  assert.match(execTool?.description ?? "", /bounded shell command in the workspace/i);
  assert.match(execTool?.description ?? "", /scaffolding, installs, builds, tests, inspections/i);
  assert.doesNotMatch(execTool?.description ?? "", /managed Kestrel task worktree/i);
  assert.doesNotMatch(execTool?.description ?? "", /source-read-only/i);
  assert.doesNotMatch(execTool?.description ?? "", /workspace checkpoints/i);
  assert.doesNotMatch(execTool?.description ?? "", /heredoc\/redirection/i);
  assert.doesNotMatch(execTool?.description ?? "", /not an OS PID, path, or \/proc target/i);

  assert.equal(writeTool?.name, "dev.process.write");
  assert.match(writeTool?.description ?? "", /Send stdin/i);
  assert.match(writeTool?.description ?? "", /existing managed live process/i);
  assert.doesNotMatch(writeTool?.description ?? "", /source edits.*belong in typed filesystem tools/i);
  assert.doesNotMatch(writeTool?.description ?? "", /file\/source creation/i);
  assert.doesNotMatch(writeTool?.description ?? "", /not an OS PID, path, or \/proc target/i);
});

test("dev shell model tools expose canonical output contracts", () => {
  const tools = defaultToolCatalog.toModelTools([
    "exec_command",
    "dev.shell.run",
    "dev.process.start",
    "dev.process.write",
    "dev.process.write_and_read",
    "dev.process.read",
    "dev.process.stop",
  ]);
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));

  assert.deepEqual(byName.get("exec_command")?.outputContract?.required, ["status", "output", "durationMs", "truncated"]);
  assert.ok(byName.get("exec_command")?.outputContract?.fields.sessionId);
  assert.ok(byName.get("exec_command")?.outputContract?.fields.cursor);
  assert.deepEqual(byName.get("dev.shell.run")?.outputContract?.required, ["status", "text", "truncated"]);
  assert.deepEqual(byName.get("dev.process.write")?.outputContract?.required, ["processId", "status", "bytesWritten"]);
  assert.deepEqual(byName.get("dev.process.start")?.outputContract?.required, ["status", "text", "truncated", "cursor", "nextCursor"]);
  assert.deepEqual(byName.get("dev.process.write_and_read")?.outputContract?.required, ["status", "text", "truncated", "cursor", "nextCursor", "bytesWritten"]);
  assert.deepEqual(byName.get("dev.process.read")?.outputContract?.required, ["status", "text", "truncated", "cursor", "nextCursor"]);
  assert.deepEqual(byName.get("dev.process.stop")?.outputContract?.required, ["status", "text", "truncated", "cursor", "nextCursor"]);
  assert.ok(byName.get("dev.process.read")?.outputContract?.fields.processId);
  assert.ok(byName.get("dev.process.read")?.outputContract?.fields.securityMode);
  assert.ok(byName.get("dev.process.read")?.outputContract?.fields.sourceWriteGuard);
});

test("managed worktree prepare is not a model-visible catalog tool", () => {
  assert.equal(DEFAULT_BALANCED_TOOL_ALLOWLIST.includes("runtime.managed_worktree.prepare"), false);
  assert.throws(
    () => defaultToolCatalog.toModelTools(["runtime.managed_worktree.prepare"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "TOOL_LOOKUP_FAILED",
  );
});

test("tool catalog fails fast when required metadata is missing", () => {
  const invalidModule = {
    definition: {
      name: "broken.tool",
      description: "Broken tool",
      inputSchema: {
        type: "object",
      },
      capability: {
        freshnessClass: "static",
        latencyClass: "low",
        costClass: "free",
        executionClass: "read_only",
        capabilityClasses: ["broken.tool"],
      },
      presentation: {
        displayName: "",
        aliases: [],
        keywords: [],
        provider: "",
        toolFamily: "",
      },
    },
    createHandler: () => async () => ({}),
  } satisfies SharedToolModule;

  assert.throws(
    () => createToolCatalog([invalidModule]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "TOOL_PRESENTATION_METADATA_INVALID",
  );
});
