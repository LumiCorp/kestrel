import assert from "node:assert/strict";
import test from "node:test";

import {
  compileAgentAction,
  DecisionCompileError,
  type CompileAgentActionInput,
} from "../../agents/reference-react/src/decision/compileIntent.js";
import { buildInternalDecisionContext } from "../../agents/reference-react/src/context/InternalDecisionContext.js";
import { hashToolInput } from "../../agents/reference-react/src/memory/workingMemory.js";

const readTextTool = {
  name: "fs.read_text",
  description: "Read a text file.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      maxBytes: { type: "number" },
    },
    required: ["path"],
  },
};

const searchTextTool = {
  name: "fs.search_text",
  description: "Search text files.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      query: { type: "string" },
    },
    required: ["path", "query"],
  },
};

const internetExtractTool = {
  name: "internet.extract",
  description: "Extract public URLs.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string" },
      urls: {
        type: "array",
        items: { type: "string" },
      },
      maxChars: { type: "number" },
    },
  },
};

const execCommandTool = {
  name: "exec_command",
  description: "Run or continue terminal work.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspaceRoot: { type: "string", minLength: 1 },
      command: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      sessionId: { type: "string", minLength: 1 },
      stdin: { type: "string" },
      stop: { type: "boolean" },
      requiredTools: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      envNames: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      envMode: {
        type: "string",
        enum: ["inherit", "allowlist"],
      },
      yieldTimeMs: { type: "number" },
      timeoutMs: { type: "number" },
      maxOutputBytes: { type: "number" },
    },
  },
};

test("internal decision context exposes existing exact-repeat evidence honestly", () => {
  const input = {
    path: "newsletter.html",
  };
  const inputHash = hashToolInput("fs.read_text", input);
  const context = buildInternalDecisionContext({
    reactState: {
      lastActionResult: {
        kind: "tool",
        name: "fs.read_text",
        toolName: "fs.read_text",
        input,
        inputHash,
        status: "ok",
      },
      latestEvidenceDelta: {
        kind: "duplicate_executed_result",
        toolName: "fs.read_text",
      },
      postToolVerification: {
        duplicateResult: {
          kind: "duplicate_executed_result",
          family: "command_result",
          toolName: "fs.read_text",
          fingerprint: "exec-command-validation",
          duplicateCount: 2,
          matchedPriorStep: 12,
        },
      },
    },
    eventPayload: {},
  });

  assert.equal(context.repetitionSignals?.lastToolName, "fs.read_text");
  assert.equal(context.repetitionSignals?.lastToolInputHash, inputHash);
  assert.equal(context.repetitionSignals?.lastResultReused, true);
  assert.equal(context.repetitionSignals?.latestDuplicateResult?.duplicateCount, 2);

  const compiled = compileAgentAction({
    phase: "deliberator",
    action: {
      kind: "tool",
      name: "fs.read_text",
      input,
    },
    observedCapabilities: ["filesystem.read"],
    capabilityManifest: [
      {
        name: "fs.read_text",
        description: "Read a text file.",
        capabilityClasses: ["filesystem.read"],
      },
    ],
    availableTools: [readTextTool],
    repetitionSignals: context.repetitionSignals,
  });

  assert.deepEqual(compiled.verification, {
    missingCapabilities: [],
    actionNovelty: false,
    expectedEvidenceDelta: "low",
  });
});

type LegacyCompileIntentFixtureInput = Omit<CompileAgentActionInput, "action"> & {
  output?: unknown;
  modelText?: string | undefined;
};

function compileIntent(input: LegacyCompileIntentFixtureInput) {
  const output = input.output as Record<string, unknown> | undefined;
  const action = normalizeLegacyNextActionForFixture(output?.nextAction);
  if (action === undefined) {
    throw new DecisionCompileError(
      "DECISION_PARSE_FAILED",
      "Test fixture must provide output.nextAction for action compilation.",
      "parse",
    );
  }
  const outputRecord = output as Record<string, unknown>;
  const {
    output: _output,
    modelText: _modelText,
    ...rest
  } = input;
  return compileAgentAction({
    ...rest,
    action,
    visibleTodosPatch: outputRecord.visibleTodos as CompileAgentActionInput["visibleTodosPatch"],
    reason: typeof outputRecord.reason === "string" ? outputRecord.reason : undefined,
  });
}

function normalizeLegacyNextActionForFixture(value: unknown): CompileAgentActionInput["action"] | undefined {
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  const action = value as Record<string, unknown>;
  if (action.kind === "finalize" && typeof action.status === "string") {
    return {
      kind: "finalize",
      finalizeReason: action.status,
      input: {
        message: typeof action.message === "string" ? action.message : "",
        ...(action.data !== undefined ? { data: action.data } : {}),
      },
    } as CompileAgentActionInput["action"];
  }
  return action as CompileAgentActionInput["action"];
}

function fsReadDecision(path: string, input: Record<string, unknown> = {}) {
  return {
    version: "v2",
    reason: "Read the file.",
    plan: {
      intent: "Ground the next action in file contents.",
      successCriteria: ["Read the target file."],
    },
    requiredCapabilities: ["filesystem.read"],
    confidence: 0.9,
    verification: {
      missingCapabilities: [],
      actionNovelty: false,
      expectedEvidenceDelta: "medium",
      retryRationale: "The file needs another read.",
      expectedNewEvidence: ["target:file"],
    },
    nextAction: {
      kind: "tool",
      name: "fs.read_text",
      input: {
        path,
        ...input,
      },
    },
  };
}

function priorReadEvidence(path = "src/app/page.tsx", options: Record<string, unknown> = {}) {
  return {
    id: "ev_read_page",
    version: "v1",
    createdAt: "2026-05-29T12:44:00.000Z",
    stepIndex: 12,
    source: "tool",
    kind: "file_content",
    status: "passed",
    summary: "Read src/app/page.tsx.",
    target: {
      type: "path",
      value: path,
      normalizedValue: path,
    },
    facts: {
      toolName: "fs.read_text",
      inputPath: path,
      outputPath: path,
    },
    raw: {
      hash: "content-hash-page",
      bytes: 128,
      ...options,
    },
  };
}

function writeEvidence(path = "src/app/page.tsx") {
  return {
    id: "ev_write_page",
    version: "v1",
    createdAt: "2026-05-29T12:45:00.000Z",
    stepIndex: 13,
    source: "tool",
    kind: "tool_result",
    status: "passed",
    summary: "Wrote src/app/page.tsx.",
    target: {
      type: "path",
      value: path,
      normalizedValue: path,
    },
    facts: {
      toolName: "fs.write_text",
      inputPath: path,
      outputPath: path,
    },
  };
}

test("compileIntent rejects unknown executable effect actions before runtime dispatch", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        output: {
          plan: [],
          requiredCapabilities: [],
          confidence: 0.9,
          verification: {
            needsReview: false,
          },
          nextAction: {
            kind: "effect",
            type: "notify_user",
            payload: {
              message: "hello",
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DecisionCompileError);
      assert.equal(error.code, "DECISION_SCHEMA_FAILED");
      assert.match(error.message, /must not emit raw effect actions/u);
      assert.equal(error.diagnostics?.received, "effect");
      return true;
    },
  );
});

test("compileIntent rejects mixed exec_command start and continuation input before dispatch", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Send a maze movement to the running process.",
          plan: {
            intent: "Continue the active maze session.",
            successCriteria: ["Observe the movement response."],
          },
          requiredCapabilities: ["dev.shell", "terminal.input"],
          confidence: 0.8,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "exec_command",
            input: {
              workspaceRoot: "/app",
              command: "move N",
              cwd: "/app",
              sessionId: "tb-proc-123",
              stdin: "move N\n",
              maxOutputBytes: 1_000_000,
            },
          },
        },
        observedCapabilities: ["dev.shell", "terminal.input"],
        capabilityManifest: [{
          name: "exec_command",
          description: "Run or continue terminal work.",
          capabilityClasses: ["dev.shell", "terminal.input"],
        }],
        availableTools: [execCommandTool],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DecisionCompileError);
      assert.equal(error.code, "DECISION_SCHEMA_FAILED");
      assert.equal(error.diagnostics?.reason, "exec_command_ambiguous_lifecycle_input");
      assert.match(String(error.diagnostics?.requiredCorrection), /sessionId with stdin/u);
      return true;
    },
  );
});

test("compileIntent rejects duplicate fresh exec_command start while matching live session exists", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Restart the same shell.",
          plan: {
            intent: "Start another shell.",
            successCriteria: ["Observe the shell."],
          },
          requiredCapabilities: ["dev.shell"],
          confidence: 0.8,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "exec_command",
            input: {
              command: "bash",
              cwd: ".",
            },
          },
        },
        observedCapabilities: ["dev.shell"],
        capabilityManifest: [{
          name: "exec_command",
          description: "Run or continue terminal work.",
          capabilityClasses: ["dev.shell"],
        }],
        availableTools: [execCommandTool],
        devShellProcesses: [{
          processId: "tb-proc-123",
          command: "bash",
          cwd: "/app",
          workspaceRoot: "/app",
          status: "RUNNING",
          live: true,
        }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DecisionCompileError);
      assert.equal(error.code, "DECISION_POLICY_FAILED");
      assert.equal(error.diagnostics?.reason, "live_dev_process_start_replay_requires_process_continuation");
      assert.equal(error.diagnostics?.toolName, "exec_command");
      assert.equal(error.diagnostics?.processId, "tb-proc-123");
      assert.match(String(error.diagnostics?.requiredCorrection), /Continue the live session with exec_command sessionId \+ stdin\/read/u);
      return true;
    },
  );
});

test("compileIntent allows fresh exec_command when no matching live session exists", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Run a bounded validation command.",
      plan: {
        intent: "Inspect the artifact.",
        successCriteria: ["Observe file output."],
      },
      requiredCapabilities: ["dev.shell"],
      confidence: 0.8,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "exec_command",
        input: {
          command: "cat /app/maze_map.txt",
          cwd: "/app",
        },
      },
    },
    observedCapabilities: ["dev.shell"],
    capabilityManifest: [{
      name: "exec_command",
      description: "Run or continue terminal work.",
      capabilityClasses: ["dev.shell"],
    }],
    availableTools: [execCommandTool],
    devShellProcesses: [{
      processId: "tb-proc-123",
      command: "bash",
      cwd: "/app",
      status: "RUNNING",
      live: true,
    }],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "exec_command");
});

test("compileIntent allows repeated same-path fs.read_text when cached contents are unchanged", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: fsReadDecision("./src/app/page.tsx", { maxBytes: 20_000 }),
    observedCapabilities: ["filesystem.read"],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read a text file.",
      capabilityClasses: ["filesystem.read"],
    }],
    availableTools: [readTextTool],
    evidenceLedger: [priorReadEvidence()],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.read_text");
});

test("compileIntent rejects internet.extract for localhost app URLs before provider dispatch", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Inspect the locally running app.",
          plan: {
            intent: "Verify the generated page.",
            successCriteria: ["Inspect the local app."],
          },
          requiredCapabilities: ["web.fetch"],
          confidence: 0.8,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "internet.extract",
            input: {
              url: "http://127.0.0.1:8000/index.html",
            },
          },
        },
        observedCapabilities: ["web.fetch"],
        capabilityManifest: [{
          name: "internet.extract",
          description: "Extract public URLs.",
          capabilityClasses: ["web.fetch", "web.extract"],
        }],
        availableTools: [internetExtractTool],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DecisionCompileError);
      assert.equal(error.code, "DECISION_SCHEMA_FAILED");
      assert.equal(error.diagnostics?.reason, "internet_tool_local_url_rejected");
      assert.equal(error.diagnostics?.toolName, "internet.extract");
      assert.deepEqual(error.diagnostics?.invalidValues, ["http://127.0.0.1:8000/index.html"]);
      assert.match(String(error.diagnostics?.requiredCorrection), /local filesystem, dev shell, or browser/u);
      return true;
    },
  );
});

test("compileIntent allows same-path fs.read_text after an exact-path filesystem mutation", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: fsReadDecision("src/app/page.tsx"),
    observedCapabilities: ["filesystem.read"],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read a text file.",
      capabilityClasses: ["filesystem.read"],
    }],
    availableTools: [readTextTool],
    evidenceLedger: [priorReadEvidence(), writeEvidence()],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.read_text");
});

test("compileIntent allows default-t5 style repeated read after post-mutation cache is fresh", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: fsReadDecision("./src/app/page.tsx"),
    observedCapabilities: ["filesystem.read"],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read a text file.",
      capabilityClasses: ["filesystem.read"],
    }],
    availableTools: [readTextTool],
    evidenceLedger: [
      {
        ...priorReadEvidence("src/app/page.tsx", { hash: "pre-edit-hash" }),
        id: "ev_read_page_before_edit",
        stepIndex: 10,
      },
      writeEvidence("src/app/page.tsx"),
      {
        id: "ev_validate_page",
        version: "v1",
        createdAt: "2026-05-29T12:46:00.000Z",
        stepIndex: 14,
        source: "tool",
        kind: "process_result",
        status: "passed",
        summary: "Validation passed.",
        facts: {
          toolName: "dev.shell.run",
          command: "pnpm build",
          exitCode: 0,
        },
      },
      {
        ...priorReadEvidence("src/app/page.tsx", { hash: "post-edit-hash" }),
        id: "ev_read_page_after_edit",
        stepIndex: 15,
      },
    ],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.read_text");
});

test("compileIntent allows fs.read_text for a different normalized path", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: fsReadDecision("src/app/layout.tsx"),
    observedCapabilities: ["filesystem.read"],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read a text file.",
      capabilityClasses: ["filesystem.read"],
    }],
    availableTools: [readTextTool],
    evidenceLedger: [priorReadEvidence("src/app/page.tsx")],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.read_text");
});

test("compileIntent allows same-path fs.read_text when the prior read was truncated", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: fsReadDecision("src/app/page.tsx"),
    observedCapabilities: ["filesystem.read"],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read a text file.",
      capabilityClasses: ["filesystem.read"],
    }],
    availableTools: [readTextTool],
    evidenceLedger: [priorReadEvidence("src/app/page.tsx", { toolOutputTruncated: true })],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.read_text");
});

test("compileIntent allows repeated fs.search_text actions", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Search the file.",
      plan: {
        intent: "Find a symbol.",
        successCriteria: ["Search returns matches."],
      },
      requiredCapabilities: ["filesystem.read"],
      confidence: 0.9,
      verification: {
        missingCapabilities: [],
        actionNovelty: false,
        expectedEvidenceDelta: "medium",
        retryRationale: "Search can find a narrower section.",
        expectedNewEvidence: ["target:symbol"],
      },
      nextAction: {
        kind: "tool",
        name: "fs.search_text",
        input: {
          path: "src/app/page.tsx",
          query: "Page",
        },
      },
    },
    observedCapabilities: ["filesystem.read"],
    capabilityManifest: [{
      name: "fs.search_text",
      description: "Search files.",
      capabilityClasses: ["filesystem.read"],
    }],
    availableTools: [searchTextTool],
    evidenceLedger: [priorReadEvidence("src/app/page.tsx")],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.search_text");
});

test("compileIntent accepts repo.trace for inspect_repo operation intent", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Trace references before editing shared output.",
      plan: {
        intent: "Inspect repo references.",
        successCriteria: ["References are found."],
      },
      requiredCapabilities: ["fs.read"],
      confidence: 0.9,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "repo.trace",
        input: {
          seeds: ["format_error"],
          path: ".",
        },
      },
    },
    observedCapabilities: ["fs.read"],
    capabilityManifest: [{
      name: "repo.trace",
      description: "Trace repository references.",
      capabilityClasses: ["fs.read", "repo.trace"],
    }],
    availableTools: [repoTraceTool()],
    toolIntent: {
      objective: "Inspect repository references.",
      confidence: 0.9,
      candidateTools: ["repo.trace"],
      allowlistedCandidates: ["repo.trace"],
      derivedRequiredCapabilities: ["fs.read"],
      operationIntent: { kind: "inspect_repo" },
    },
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "repo.trace");
});

test("compileIntent normalizes dev.shell.run cwd against active devShell process workspace root", () => {
  const action = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Run shell command to inspect repository.",
      plan: {
        intent: "Inspect repo state.",
        successCriteria: ["Command executes successfully."],
      },
      requiredCapabilities: ["dev.shell"],
      confidence: 0.92,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "tool",
        name: "dev.shell.run",
        input: {
          command: "ls",
          cwd: "../outside-workspace",
          workspaceRoot: ".",
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "dev.shell.run",
      description: "Run a shell command.",
      capabilityClasses: [],
    }],
    availableTools: [
      {
        name: "dev.shell.run",
        description: "Run a shell command as a process.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string", minLength: 1 },
            cwd: { type: "string", minLength: 1 },
            workspaceRoot: { type: "string", minLength: 1 },
          },
          required: ["command"],
        },
      },
    ],
    devShellProcesses: [{ workspaceRoot: "/tmp/project-root" }],
  });

  assert.equal(action.action?.kind, "tool");
  assert.equal(action.action?.name, "dev.shell.run");
  assert.equal(action.action?.input.workspaceRoot, "/tmp/project-root");
  assert.equal(action.action?.input.cwd, "/tmp/project-root");
});

test("compileIntent allows nested create-next-app scaffold targets", () => {
  for (const command of [
    "CI=1 pnpm create next-app@15.4.5 app --ts --eslint --app --use-pnpm --yes",
    "npm create next-app@latest app -- --ts",
    "yarn create next-app app --ts",
    "pnpm dlx create-next-app@latest app --ts",
  ]) {
    const compiled = compileIntent({
      phase: "deliberator",
      output: {
        version: "v2",
        reason: "Scaffold the app.",
        plan: {
          intent: "Create a root-mounted Next app.",
          successCriteria: ["package.json exists at the workspace root."],
        },
        requiredCapabilities: ["dev.shell"],
        confidence: 0.92,
        verification: {
          missingCapabilities: [],
          actionNovelty: true,
          expectedEvidenceDelta: "medium",
        },
        nextAction: {
          kind: "tool",
          name: "dev.shell.run",
          input: {
            command,
            cwd: "/tmp/project-root",
            workspaceRoot: "/tmp/project-root",
          },
        },
      },
      observedCapabilities: [],
      capabilityManifest: [{
        name: "dev.shell.run",
        description: "Run a shell command.",
        capabilityClasses: [],
      }],
      availableTools: [devShellRunTool()],
    });

    assert.equal(compiled.action?.kind, "tool");
    assert.equal(compiled.action?.name, "dev.shell.run");
  }
});

test("compileIntent allows root create-next-app scaffold target", () => {
  const action = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Scaffold the app.",
      plan: {
        intent: "Create a root-mounted Next app.",
        successCriteria: ["package.json exists at the workspace root."],
      },
      requiredCapabilities: ["dev.shell"],
      confidence: 0.92,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "dev.shell.run",
        input: {
          command: "CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes",
          cwd: "/tmp/project-root",
          workspaceRoot: "/tmp/project-root",
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "dev.shell.run",
      description: "Run a shell command.",
      capabilityClasses: [],
    }],
    availableTools: [devShellRunTool()],
  });

  assert.equal(action.action?.kind, "tool");
  assert.equal(action.action?.name, "dev.shell.run");
});

test("compileIntent allows direct file creation after empty-root evidence", () => {
  const action = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    executionIntent: {
      objective: "Create a simple page in the empty workspace.",
      candidateTools: ["dev.shell.run", "fs.write_text"],
      operationIntent: { kind: "scaffold_app" },
    },
    output: {
      version: "v2",
      reason: "Create the requested static page directly.",
      plan: {
        intent: "Create the requested static page directly.",
        successCriteria: ["index.html exists at the workspace root."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "tool",
        name: "fs.write_text",
        input: {
          path: "index.html",
          content: "<!doctype html><title>Newsletter</title>",
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [
      {
        name: "dev.shell.run",
        description: "Run a shell command.",
        capabilityClasses: ["workspace.write", "shell.exec"],
        executionClass: "external_side_effect",
      },
      {
        name: "fs.write_text",
        description: "Write text.",
        capabilityClasses: ["fs.write"],
        executionClass: "sandboxed_only",
      },
    ],
    availableTools: [devShellRunTool(), fsWriteTextTool()],
    evidenceLedger: [
      {
        id: "ev_root_empty",
        version: "v1",
        createdAt: "2026-05-20T00:00:00.000Z",
        stepIndex: 2,
        source: "tool",
        kind: "file_listing",
        status: "passed",
        summary: "This directory is empty.",
        target: { type: "path", value: ".", normalizedValue: "." },
        facts: {
          toolName: "fs.list",
          inputPath: ".",
          outputPath: ".",
          entryCount: 0,
          empty: true,
          entries: [],
          message: "This directory is empty.",
          inputIncludeHidden: true,
        },
      },
    ],
  });

  assert.equal(action.action?.kind, "tool");
  assert.equal(action.action?.name, "fs.write_text");
});

test("compileIntent allows shell commands for coding work even when extracted operation intent is write_file", () => {
  const action = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    executionIntent: {
      objective: "Generate project files with the package manager.",
      candidateTools: ["dev.shell.run", "fs.write_text"],
      operationIntent: { kind: "write_file" },
    },
    output: {
      version: "v2",
      reason: "Use the project generator so package files and source files stay consistent.",
      plan: {
        intent: "Generate the project files with the package manager.",
        successCriteria: ["The scaffold command creates the project source files."],
      },
      requiredCapabilities: [],
      confidence: 0.91,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "dev.shell.run",
        input: {
          command: "npm create vite@latest . -- --template react-ts",
          cwd: "/tmp/project-root",
          workspaceRoot: "/tmp/project-root",
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [
      {
        name: "dev.shell.run",
        description: "Run a shell command.",
        capabilityClasses: ["dev.shell", "host.shell"],
        executionClass: "external_side_effect",
      },
      {
        name: "fs.write_text",
        description: "Write text.",
        capabilityClasses: ["fs.write"],
        executionClass: "sandboxed_only",
      },
    ],
    availableTools: [devShellRunTool(), fsWriteTextTool()],
  });

  assert.equal(action.action?.kind, "tool");
  assert.equal(action.action?.name, "dev.shell.run");
});

test("compileIntent allows static file closeout with file-backed evidence", () => {
  const action = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    intentMetadata: {
      workflowIntent: { kind: "coding_change" },
      verificationIntent: { requested: false },
    },
    output: {
      version: "v2",
      reason: "The static newsletter page exists.",
      plan: {
        intent: "Create the static newsletter page.",
        successCriteria: ["index.html exists with newsletter content."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: false,
        expectedEvidenceDelta: "low",
        expectedRepoDelta: ["index.html"],
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Created index.html with a simple newsletter page and three sample stories.",
        data: {
          completionState: "implemented_and_verified",
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
    evidenceLedger: [writeEvidence("index.html")],
  });

  assert.equal(action.action?.kind, "finalize");
  assert.equal(action.verification.expectedRepoDelta, undefined);
});

test("compileIntent rejects contradictory passed artifact verification with failures", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          reason: "The page is complete.",
          plan: {
            intent: "Create the static newsletter page.",
            successCriteria: ["index.html exists with newsletter content."],
          },
          requiredCapabilities: [],
          confidence: 1,
          verification: {
            missingCapabilities: [],
            actionNovelty: false,
            expectedEvidenceDelta: "low",
          },
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "Created index.html.",
            data: {
              completionState: "implemented_and_verified",
              artifactVerification: {
                target: "index.html",
                status: "passed",
                evidence: {
                  kind: "tool_result",
                  toolName: "dev.shell.run",
                  summary: "HAS_AT_LEAST_FIVE_DISHES False",
                },
                requirements: [
                  {
                    id: "five-dishes",
                    expectation: "At least five dishes are visible.",
                    observed: "HAS_AT_LEAST_FIVE_DISHES False",
                    status: "failed",
                  },
                ],
                failures: ["The five-dish check failed."],
              },
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [],
        availableTools: [],
      }),
    (error) => error instanceof DecisionCompileError && error.code === "DECISION_SCHEMA_FAILED",
  );
});

test("compileIntent allows static file closeout without completionState when file evidence exists", () => {
  const action = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    intentMetadata: {
      workflowIntent: { kind: "coding_change" },
      verificationIntent: { requested: false },
    },
    output: {
      version: "v2",
      reason: "The static newsletter page exists.",
      plan: {
        intent: "Create the static newsletter page.",
        successCriteria: ["index.html exists with newsletter content."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: false,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Created index.html with a simple newsletter page and three sample stories.",
      },
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
    evidenceLedger: [writeEvidence("index.html")],
  });

  assert.equal(action.action?.kind, "finalize");
  assert.equal(action.verification.expectedRepoDelta, undefined);
});

test("compileIntent drops non-file expectedRepoDelta prose without evidence backfill", () => {
  const action = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    intentMetadata: {
      workflowIntent: { kind: "coding_change" },
      verificationIntent: { requested: false },
    },
    output: {
      version: "v2",
      reason: "The static newsletter page exists.",
      plan: {
        intent: "Create the static newsletter page.",
        successCriteria: ["index.html exists with newsletter content."],
      },
      requiredCapabilities: [],
      confidence: 1,
      verification: {
        missingCapabilities: [],
        actionNovelty: false,
        expectedEvidenceDelta: "low",
        expectedRepoDelta: ["the newsletter page works locally"],
      },
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Created index.html with a simple newsletter page and three sample stories.",
      },
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
    evidenceLedger: [writeEvidence("index.html")],
  });

  assert.equal(action.action?.kind, "finalize");
  assert.equal(action.verification.expectedRepoDelta, undefined);
});

test("compileIntent allows overwriting a verified artifact", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    output: buildWriteTextDecision("newsletter-report.json"),
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.write_text",
      description: "Write text.",
      capabilityClasses: ["fs.write"],
      executionClass: "sandboxed_only",
    }],
    availableTools: [fsWriteTextTool()],
    evidenceLedger: [
      artifactVerificationEntry({
        id: "ev_verify_passed",
        status: "passed",
        stepIndex: 4,
      }),
    ],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.write_text");
});

test("compileIntent allows unrelated source writes after artifact verification passed", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    output: buildWriteTextDecision("app/page.tsx"),
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.write_text",
      description: "Write text.",
      capabilityClasses: ["fs.write"],
      executionClass: "sandboxed_only",
    }],
    availableTools: [fsWriteTextTool()],
    evidenceLedger: [
      artifactVerificationEntry({
        id: "ev_verify_passed",
        status: "passed",
        stepIndex: 4,
      }),
    ],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.write_text");
  assert.equal(compiled.action?.input.path, "app/page.tsx");
});

test("compileIntent allows verified artifact repair after a newer verifier failure exists", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    output: buildWriteTextDecision("newsletter-report.json"),
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.write_text",
      description: "Write text.",
      capabilityClasses: ["fs.write"],
      executionClass: "sandboxed_only",
    }],
    availableTools: [fsWriteTextTool()],
    evidenceLedger: [
      artifactVerificationEntry({
        id: "ev_verify_passed",
        status: "passed",
        stepIndex: 4,
      }),
      artifactVerificationEntry({
        id: "ev_verify_failed",
        status: "failed",
        stepIndex: 7,
      }),
    ],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.write_text");
  assert.equal(compiled.action?.input.path, "newsletter-report.json");
});

test("compileIntent allows ask_user when artifact verification names a repairable failure", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    intentMetadata: {
      workflowIntent: { kind: "coding_change" },
      verificationIntent: { requested: true },
    },
    output: {
      version: "v2",
      reason: "The artifact verifier failed, so ask whether to repair.",
      plan: {
        intent: "Create a simple newsletter page.",
        successCriteria: ["index.html verifies"],
      },
      requiredCapabilities: [],
      confidence: 0.8,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
      nextAction: {
        kind: "ask_user",
        prompt: "The artifact check failed. Should I repair it or keep it as-is?",
        waitFor: { kind: "user", eventType: "user.message" },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [],
    availableTools: [],
    evidenceLedger: [
      artifactVerificationEntry({
        id: "ev_index_verify_failed",
        status: "failed",
        stepIndex: 8,
      }),
    ],
  });

  assert.equal(compiled.action?.kind, "ask_user");
});

test("compileIntent allows rerunning create-next-app after completed bootstrap", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Run bootstrap again.",
      plan: {
        intent: "Create a root-mounted Next app.",
        successCriteria: ["package.json exists at the workspace root."],
      },
      requiredCapabilities: ["dev.shell"],
      confidence: 0.92,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "dev.shell.run",
        input: {
          command: "CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes",
          cwd: "/tmp/project-root",
          workspaceRoot: "/tmp/project-root",
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "dev.shell.run",
      description: "Run a shell command.",
      capabilityClasses: [],
    }],
    availableTools: [devShellRunTool()],
    postToolVerification: {
      devShell: {
        commandLifecycle: "settled_terminal",
        completedExitCode: 0,
        lastCommand: {
          command: "CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes",
          cwd: "/tmp/project-root",
          workspaceRoot: "/tmp/project-root",
        },
      },
    },
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "dev.shell.run");
});

test("compileIntent allows repeated filesystem inventory for runtime reuse", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Inspect the same directory again.",
          plan: {
            intent: "Continue from known filesystem evidence.",
            successCriteria: ["Use prior inventory before repeating reads."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "fs.list",
            input: {
              path: "public",
              includeHidden: true,
              recursive: true,
              maxDepth: 4,
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.list",
          description: "List files.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsListTool()],
        evidenceLedger: [
          {
            id: "ev_public_empty",
            version: "v1",
            createdAt: "2026-05-20T00:00:00.000Z",
            stepIndex: 2,
            source: "tool",
            kind: "file_listing",
            status: "passed",
            summary: "This directory is empty.",
            target: { type: "path", value: "public", normalizedValue: "public" },
            facts: {
              toolName: "fs.list",
              inputPath: "public",
              outputPath: "public",
              entryCount: 0,
              empty: true,
              entries: [],
              message: "This directory is empty.",
              inputIncludeHidden: true,
              inputRecursive: true,
              inputMaxDepth: 3,
            },
          },
        ],
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.list");
});

test("compileIntent allows retry after failed filesystem inventory evidence", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Retry the failed directory listing.",
      plan: {
        intent: "Recover from failed filesystem evidence.",
        successCriteria: ["Directory listing succeeds."],
      },
      requiredCapabilities: ["fs.read"],
      confidence: 0.9,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "fs.list",
        input: {
          path: "public",
          includeHidden: true,
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.list",
      description: "List files.",
      capabilityClasses: ["fs.read"],
    }],
    availableTools: [fsListTool()],
    evidenceLedger: [
      {
        id: "ev_public_failed",
        version: "v1",
        createdAt: "2026-05-20T00:00:00.000Z",
        stepIndex: 2,
        source: "tool",
        kind: "file_listing",
        status: "failed",
        summary: "Listing failed.",
        target: { type: "path", value: "public", normalizedValue: "public" },
        facts: {
          toolName: "fs.list",
          inputPath: "public",
          outputPath: "public",
          entryCount: 0,
          empty: true,
          entries: [],
          message: "Listing failed.",
        },
      },
    ],
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.list");
});

test("compileIntent allows repeated filesystem inventory inside a mixed batch for runtime reuse", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Read after checking the same directory.",
          plan: {
            intent: "Use known filesystem evidence before reading files.",
            successCriteria: ["Avoid repeated inventory."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool_batch",
            items: [
              {
                name: "fs.list",
                input: {
                  path: "public",
                  includeHidden: true,
                },
              },
              {
                name: "fs.read_text",
                input: {
                  path: "README.md",
                },
              },
            ],
          },
        },
        observedCapabilities: [],
        capabilityManifest: [
          {
            name: "fs.list",
            description: "List files.",
            capabilityClasses: ["fs.read"],
          },
          {
            name: "fs.read_text",
            description: "Read text.",
            capabilityClasses: ["fs.read"],
          },
        ],
        availableTools: [fsListTool(), fsReadTextTool()],
        evidenceLedger: [
          {
            id: "ev_public_empty",
            version: "v1",
            createdAt: "2026-05-20T00:00:00.000Z",
            stepIndex: 2,
            source: "tool",
            kind: "file_listing",
            status: "passed",
            summary: "This directory is empty.",
            target: { type: "path", value: "public", normalizedValue: "public" },
            facts: {
              toolName: "fs.list",
              inputPath: "public",
              outputPath: "public",
              entryCount: 0,
              empty: true,
              entries: [],
              message: "This directory is empty.",
              inputIncludeHidden: true,
            },
          },
        ],
  });

  assert.equal(compiled.action.kind, "tool_batch");
  assert.equal(compiled.action.items[0]?.name, "fs.list");
});

test("compileIntent allows repeated filesystem inventory from immediate last action result", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Repeat the same listing.",
          plan: {
            intent: "Continue from the prior tool result.",
            successCriteria: ["Do not repeat known inventory."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "fs.list",
            input: {
              path: "public",
              includeHidden: true,
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.list",
          description: "List files.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsListTool()],
        lastActionResult: {
          kind: "tool",
          name: "fs.list",
          status: "succeeded",
          input: {
            path: "public",
            includeHidden: true,
          },
          output: {
            path: "public",
            entries: [],
            entryCount: 0,
            empty: true,
            message: "This directory is empty.",
          },
        },
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.list");
});

test("compileIntent allows retry after string-error filesystem inventory last action result", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Retry the failed directory listing.",
      plan: {
        intent: "Recover from failed filesystem evidence.",
        successCriteria: ["Directory listing succeeds."],
      },
      requiredCapabilities: ["fs.read"],
      confidence: 0.9,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "fs.list",
        input: {
          path: "public",
          includeHidden: true,
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.list",
      description: "List files.",
      capabilityClasses: ["fs.read"],
    }],
    availableTools: [fsListTool()],
    lastActionResult: {
      kind: "tool",
      name: "fs.list",
      input: {
        path: "public",
        includeHidden: true,
      },
      output: {
        path: "public",
        entries: [],
        entryCount: 0,
        empty: true,
        error: "EACCES: permission denied, scandir 'public'",
      },
    },
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.list");
});

test("compileIntent allows repeated filesystem file reads when cached contents are unchanged", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Read the same source file again.",
          plan: {
            intent: "Continue from known file evidence.",
            successCriteria: ["Read the requested file."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path: "./src/app/page.tsx",
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsReadTextTool()],
        evidenceLedger: [
          {
            id: "ev_page_content",
            version: "v1",
            createdAt: "2026-05-20T00:00:00.000Z",
            stepIndex: 2,
            source: "tool",
            kind: "file_content",
            status: "passed",
            summary: "Read page source.",
            target: { type: "path", value: "src/app/page.tsx", normalizedValue: "src/app/page.tsx" },
            facts: {
              toolName: "fs.read_text",
              inputPath: "src/app/page.tsx",
              outputPath: "src/app/page.tsx",
            },
            raw: {
              bytes: 128,
              hash: "abc123",
              toolOutputTruncated: false,
            },
          },
        ],
      });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.read_text");
});

test("compileIntent allows repeated filesystem text searches for runtime reuse", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Search the same files for the same token again.",
          plan: {
            intent: "Use known search evidence.",
            successCriteria: ["Run the requested search."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "fs.search_text",
            input: {
              path: "src",
              query: "createRoute",
              glob: "**/*.ts",
              caseSensitive: false,
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.search_text",
          description: "Search text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsSearchTextTool()],
        evidenceLedger: [
          {
            id: "ev_route_search",
            version: "v1",
            createdAt: "2026-05-20T00:00:00.000Z",
            stepIndex: 2,
            source: "tool",
            kind: "file_content",
            status: "passed",
            summary: "Searched route source.",
            target: { type: "path", value: "src", normalizedValue: "src" },
            facts: {
              toolName: "fs.search_text",
              inputPath: "src",
              outputPath: "src",
              query: "createRoute",
              glob: "**/*.ts",
              caseSensitive: false,
            },
          },
        ],
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.search_text");
});

test("compileIntent allows reading a file again after a later same-path mutation", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Read back the edited source file.",
      plan: {
        intent: "Verify the mutation.",
        successCriteria: ["The updated file content is visible."],
      },
      requiredCapabilities: ["fs.read"],
      confidence: 0.9,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: {
          path: "src/app/page.tsx",
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read text.",
      capabilityClasses: ["fs.read"],
    }],
    availableTools: [fsReadTextTool()],
    evidenceLedger: [
      {
        id: "ev_page_content",
        version: "v1",
        createdAt: "2026-05-20T00:00:00.000Z",
        stepIndex: 2,
        source: "tool",
        kind: "file_content",
        status: "passed",
        summary: "Read page source.",
        target: { type: "path", value: "src/app/page.tsx", normalizedValue: "src/app/page.tsx" },
        facts: {
          toolName: "fs.read_text",
          inputPath: "src/app/page.tsx",
          outputPath: "src/app/page.tsx",
        },
      },
      {
        id: "ev_page_write",
        version: "v1",
        createdAt: "2026-05-20T00:01:00.000Z",
        stepIndex: 3,
        source: "tool",
        kind: "tool_result",
        status: "passed",
        summary: "Updated page source.",
        target: { type: "path", value: "src/app/page.tsx", normalizedValue: "src/app/page.tsx" },
        facts: {
          toolName: "fs.write_text",
          inputPath: "src/app/page.tsx",
          outputPath: "src/app/page.tsx",
          changed: true,
        },
      },
    ],
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.read_text");
});

test("compileIntent allows repeated truncated filesystem reads for runtime reuse", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Retry the same truncated read.",
          plan: {
            intent: "Use existing partial file evidence.",
            successCriteria: ["Avoid repeated truncated reads."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path: "src/app/large.ts",
              maxBytes: 1024,
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsReadTextTool()],
        evidenceLedger: [
          {
            id: "ev_large_partial",
            version: "v1",
            createdAt: "2026-05-20T00:00:00.000Z",
            stepIndex: 2,
            source: "tool",
            kind: "file_content",
            status: "passed",
            summary: "Read partial source.",
            target: { type: "path", value: "src/app/large.ts", normalizedValue: "src/app/large.ts" },
            facts: {
              toolName: "fs.read_text",
              inputPath: "src/app/large.ts",
              outputPath: "src/app/large.ts",
              inputMaxBytes: 1024,
            },
            raw: {
              bytes: 1024,
              hash: "partial",
              toolOutputTruncated: true,
            },
          },
        ],
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.read_text");
});

test("compileIntent allows a larger byte budget after a truncated filesystem read", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Read more of the truncated file.",
      plan: {
        intent: "Expand partial file evidence.",
        successCriteria: ["Collect additional file content."],
      },
      requiredCapabilities: ["fs.read"],
      confidence: 0.9,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: {
          path: "src/app/large.ts",
          maxBytes: 4096,
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read text.",
      capabilityClasses: ["fs.read"],
    }],
    availableTools: [fsReadTextTool()],
    evidenceLedger: [
      {
        id: "ev_large_partial",
        version: "v1",
        createdAt: "2026-05-20T00:00:00.000Z",
        stepIndex: 2,
        source: "tool",
        kind: "file_content",
        status: "passed",
        summary: "Read partial source.",
        target: { type: "path", value: "src/app/large.ts", normalizedValue: "src/app/large.ts" },
        facts: {
          toolName: "fs.read_text",
          inputPath: "src/app/large.ts",
          outputPath: "src/app/large.ts",
          inputMaxBytes: 1024,
        },
        raw: {
          bytes: 1024,
          hash: "partial",
          toolOutputTruncated: true,
        },
      },
    ],
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.read_text");
});

test("compileIntent allows repeated reads after no-change replace_text result", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Read after a no-op replace.",
          plan: {
            intent: "Use known file evidence.",
            successCriteria: ["Do not treat no-op edits as fresh file content."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path: "src/app/page.tsx",
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsReadTextTool()],
        evidenceLedger: [
          {
            id: "ev_page_content",
            version: "v1",
            createdAt: "2026-05-20T00:00:00.000Z",
            stepIndex: 2,
            source: "tool",
            kind: "file_content",
            status: "passed",
            summary: "Read page source.",
            target: { type: "path", value: "src/app/page.tsx", normalizedValue: "src/app/page.tsx" },
            facts: {
              toolName: "fs.read_text",
              inputPath: "src/app/page.tsx",
              outputPath: "src/app/page.tsx",
            },
          },
        ],
        lastActionResult: {
          kind: "tool",
          name: "fs.replace_text",
          input: {
            path: "src/app/page.tsx",
            find: "missing",
            replace: "replacement",
          },
          output: {
            path: "src/app/page.tsx",
            replacements: 0,
            changed: false,
            status: "NO_CHANGE",
          },
        },
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.read_text");
});

test("compileIntent allows repeated reads after patch_text touches the same path", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Read after a patch changed the file.",
          plan: {
            intent: "Verify patched file content.",
            successCriteria: ["Read fresh file content after patching."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path: "src/app/page.tsx",
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsReadTextTool()],
        evidenceLedger: [
          {
            id: "ev_page_content",
            version: "v1",
            createdAt: "2026-05-20T00:00:00.000Z",
            stepIndex: 2,
            source: "tool",
            kind: "file_content",
            status: "passed",
            summary: "Read page source.",
            target: { type: "path", value: "src/app/page.tsx", normalizedValue: "src/app/page.tsx" },
            facts: {
              toolName: "fs.read_text",
              inputPath: "src/app/page.tsx",
              outputPath: "src/app/page.tsx",
            },
          },
        ],
        lastActionResult: {
          kind: "tool",
          name: "fs.patch_text",
          input: {
            path: "src/app/page.tsx",
            patch: "@@ old\n-new\n+new\n",
          },
          output: {
            path: "src/app/page.tsx",
            changed: true,
            status: "ok",
          },
        },
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.read_text");
});

test("compileIntent allows repeated reads after copy source evidence", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Read the copied source again.",
          plan: {
            intent: "Use source file evidence.",
            successCriteria: ["Copying a file does not refresh source evidence."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool",
            name: "fs.read_text",
            input: {
              path: "src/app/page.tsx",
            },
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsReadTextTool()],
        evidenceLedger: [
          {
            id: "ev_source_content",
            version: "v1",
            createdAt: "2026-05-20T00:00:00.000Z",
            stepIndex: 2,
            source: "tool",
            kind: "file_content",
            status: "passed",
            summary: "Read source file.",
            target: { type: "path", value: "src/app/page.tsx", normalizedValue: "src/app/page.tsx" },
            facts: {
              toolName: "fs.read_text",
              inputPath: "src/app/page.tsx",
              outputPath: "src/app/page.tsx",
            },
            raw: {
              hash: "source-hash",
              toolOutputTruncated: false,
            },
          },
        ],
        lastActionResult: {
          kind: "tool",
          name: "fs.copy",
          input: {
            sourcePath: "src/app/page.tsx",
            destinationPath: "tmp/page-copy.tsx",
          },
          output: {
            sourcePath: "src/app/page.tsx",
            destinationPath: "tmp/page-copy.tsx",
            overwrite: false,
          },
        },
      });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.read_text");
});

test("compileIntent allows repeated reads from lastActionResult content", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: fsReadDecision("src/app/page.tsx"),
        observedCapabilities: ["filesystem.read"],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["filesystem.read"],
        }],
        availableTools: [fsReadTextTool()],
        lastActionResult: {
          kind: "tool",
          status: "ok",
          name: "fs.read_text",
          input: {
            path: "src/app/page.tsx",
          },
          output: {
            path: "src/app/page.tsx",
            content: "export default function Page() { return null; }\n",
            truncated: false,
            encoding: "utf8",
          },
        },
      });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.read_text");
});

test("compileIntent allows reading a copy destination after the copy mutation", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Read the copied destination.",
      plan: {
        intent: "Verify copied destination content.",
        successCriteria: ["The copied file exists with current content."],
      },
      requiredCapabilities: ["fs.read"],
      confidence: 0.9,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "medium",
      },
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: {
          path: "tmp/page-copy.tsx",
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read text.",
      capabilityClasses: ["fs.read"],
    }],
    availableTools: [fsReadTextTool()],
    evidenceLedger: [
      {
        id: "ev_old_dest_content",
        version: "v1",
        createdAt: "2026-05-20T00:00:00.000Z",
        stepIndex: 2,
        source: "tool",
        kind: "file_content",
        status: "passed",
        summary: "Read old copied file.",
        target: { type: "path", value: "tmp/page-copy.tsx", normalizedValue: "tmp/page-copy.tsx" },
        facts: {
          toolName: "fs.read_text",
          inputPath: "tmp/page-copy.tsx",
          outputPath: "tmp/page-copy.tsx",
        },
      },
    ],
    lastActionResult: {
      kind: "tool",
      name: "fs.copy",
      input: {
        sourcePath: "src/app/page.tsx",
        destinationPath: "tmp/page-copy.tsx",
        overwrite: true,
      },
      output: {
        sourcePath: "src/app/page.tsx",
        destinationPath: "tmp/page-copy.tsx",
        overwrite: true,
      },
    },
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.read_text");
});

test("compileIntent allows repeated filesystem reads inside the same batch for runtime reuse", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Read the same file twice in parallel.",
          plan: {
            intent: "Avoid duplicate batch reads.",
            successCriteria: ["Each batch item collects distinct evidence."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool_batch",
            items: [
              {
                name: "fs.read_text",
                input: {
                  path: "src/app/page.tsx",
                },
              },
              {
                name: "fs.read_text",
                input: {
                  path: "./src/app/page.tsx",
                },
              },
            ],
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsReadTextTool()],
  });

  assert.equal(compiled.action.kind, "tool_batch");
  assert.equal(compiled.action.items[0]?.name, "fs.read_text");
});

test("compileIntent allows repeated cached filesystem reads inside a multi-file batch", () => {
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Read cached source files again.",
          plan: {
            intent: "Inspect files before editing.",
            successCriteria: ["Use current file contents."],
          },
          requiredCapabilities: ["fs.read"],
          confidence: 0.9,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "medium",
          },
          nextAction: {
            kind: "tool_batch",
            items: [
              { name: "fs.read_text", input: { path: "src/App.jsx" } },
              { name: "fs.read_text", input: { path: "src/App.css" } },
              { name: "fs.read_text", input: { path: "src/index.css" } },
            ],
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsReadTextTool()],
        evidenceLedger: [
          priorReadEvidence("src/App.jsx", { hash: "hash-app", contentPreview: "starter app" }),
          priorReadEvidence("src/App.css", { hash: "hash-css", contentPreview: "starter css" }),
          priorReadEvidence("src/index.css", { hash: "hash-index", contentPreview: "starter index css" }),
        ],
      });

  assert.equal(compiled.action.kind, "tool_batch");
  assert.deepEqual(compiled.action.items.map((item) => item.name), [
    "fs.read_text",
    "fs.read_text",
    "fs.read_text",
  ]);
});

test("compileIntent allows repeated cached batch reads when next paths are absolute workspace paths", () => {
  const workspaceRoot = "/private/tmp/kestrel-cli-prompt-smoke/run/workspace";
  const compiled = compileIntent({
        phase: "deliberator",
        output: {
          version: "v2",
          reason: "Read cached source files again.",
          nextAction: {
            kind: "tool_batch",
            items: [
              { name: "fs.read_text", input: { path: `${workspaceRoot}/src/App.jsx`, maxBytes: 20_000 } },
              { name: "fs.read_text", input: { path: `${workspaceRoot}/src/App.css`, maxBytes: 20_000 } },
              { name: "fs.read_text", input: { path: `${workspaceRoot}/src/index.css`, maxBytes: 20_000 } },
              { name: "fs.read_text", input: { path: `${workspaceRoot}/src/main.jsx`, maxBytes: 12_000 } },
            ],
          },
        },
        observedCapabilities: [],
        capabilityManifest: [{
          name: "fs.read_text",
          description: "Read text.",
          capabilityClasses: ["fs.read"],
        }],
        availableTools: [fsReadTextTool()],
        workspaceRoot,
        lastActionResult: {
          kind: "tool_batch",
          status: "ok",
          ok: true,
          items: [
            {
              name: "fs.read_text",
              input: { path: `${workspaceRoot}/src/App.jsx`, maxBytes: 20_000 },
              output: { path: "src/App.jsx", content: "starter app", truncated: false, encoding: "utf8" },
            },
            {
              name: "fs.read_text",
              input: { path: `${workspaceRoot}/src/App.css`, maxBytes: 20_000 },
              output: { path: "src/App.css", content: "starter css", truncated: false, encoding: "utf8" },
            },
            {
              name: "fs.read_text",
              input: { path: `${workspaceRoot}/src/index.css`, maxBytes: 20_000 },
              output: { path: "src/index.css", content: "starter index css", truncated: false, encoding: "utf8" },
            },
            {
              name: "fs.read_text",
              input: { path: `${workspaceRoot}/src/main.jsx`, maxBytes: 12_000 },
              output: { path: "src/main.jsx", content: "starter main", truncated: false, encoding: "utf8" },
            },
          ],
        },
      });

  assert.equal(compiled.action.kind, "tool_batch");
  assert.deepEqual(compiled.action.items.map((item) => item.name), [
    "fs.read_text",
    "fs.read_text",
    "fs.read_text",
    "fs.read_text",
  ]);
});

test("compileIntent allows repeated filesystem inventory when hidden entries were previously omitted", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: {
      version: "v2",
      reason: "Reveal hidden entries that were omitted before.",
      plan: {
        intent: "Inspect hidden workspace metadata.",
        successCriteria: ["Hidden entries are listed."],
      },
      requiredCapabilities: ["fs.read"],
      confidence: 0.9,
      verification: {
        missingCapabilities: [],
        actionNovelty: false,
        expectedEvidenceDelta: "medium",
        retryRationale: "The prior listing omitted hidden entries.",
        expectedNewEvidence: ["Hidden directory entries for public."],
      },
      nextAction: {
        kind: "tool",
        name: "fs.list",
        input: {
          path: "public",
          includeHidden: true,
          recursive: false,
        },
      },
    },
    observedCapabilities: [],
    capabilityManifest: [{
      name: "fs.list",
      description: "List files.",
      capabilityClasses: ["fs.read"],
    }],
    availableTools: [fsListTool()],
    evidenceLedger: [
      {
        id: "ev_public_visible_empty",
        version: "v1",
        createdAt: "2026-05-20T00:00:00.000Z",
        stepIndex: 2,
        source: "tool",
        kind: "file_listing",
        status: "passed",
        summary: "This directory has no visible entries.",
        target: { type: "path", value: "public", normalizedValue: "public" },
        facts: {
          toolName: "fs.list",
          inputPath: "public",
          outputPath: "public",
          entryCount: 0,
          empty: true,
          entries: [],
          omittedHiddenEntryCount: 2,
          message: "This directory has no visible entries. Hidden entries were omitted because includeHidden is false.",
          inputIncludeHidden: false,
          inputRecursive: false,
        },
      },
    ],
  });

  assert.equal(compiled.action.kind, "tool");
  assert.equal(compiled.action.name, "fs.list");
});

function devShellRunTool() {
  return {
    name: "dev.shell.run",
    description: "Run a shell command as a process.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
        workspaceRoot: { type: "string", minLength: 1 },
      },
      required: ["command"],
    },
  };
}

function fsListTool() {
  return {
    name: "fs.list",
    description: "List files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        includeHidden: { type: "boolean" },
        recursive: { type: "boolean" },
        maxDepth: { type: "number" },
      },
      required: ["path"],
    },
  };
}

function fsReadTextTool() {
  return {
    name: "fs.read_text",
    description: "Read text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" },
      },
      required: ["path"],
    },
  };
}

function fsWriteTextTool() {
  return {
    name: "fs.write_text",
    description: "Write text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  };
}

function buildWriteTextDecision(path: string) {
  return {
    version: "v2",
    reason: `Write ${path}.`,
    plan: {
      intent: "Update source files.",
      successCriteria: ["The requested file is updated."],
    },
    requiredCapabilities: ["fs.write"],
    confidence: 0.92,
    verification: {
      missingCapabilities: [],
      actionNovelty: true,
      expectedEvidenceDelta: "medium",
    },
    nextAction: {
      kind: "tool",
      name: "fs.write_text",
      input: {
        path,
        content: "{\"stories\":[]}",
      },
    },
  };
}

function artifactVerificationEntry(input: {
  id: string;
  status: "passed" | "failed";
  stepIndex: number;
}) {
  return {
    id: input.id,
    version: "v1",
    createdAt: `2026-05-27T00:00:0${input.stepIndex}.000Z`,
    stepIndex: input.stepIndex,
    source: "runtime",
    kind: "artifact_verification",
    status: input.status,
    summary: input.status === "passed"
      ? "Verified JSON artifact 'newsletter-report.json::stories'."
      : "JSON artifact verification failed for 'newsletter-report.json::stories'.",
    target: {
      type: "artifact",
      value: "newsletter-report.json::stories",
      normalizedValue: "newsletter-report.json::stories",
    },
    facts: {
      target: "newsletter-report.json::stories",
      status: input.status,
      requirementsSummary: {
        total: 10,
        passed: input.status === "passed" ? 10 : 9,
        failed: input.status === "passed" ? 0 : 1,
        inconclusive: 0,
      },
    },
  };
}

function fsSearchTextTool() {
  return {
    name: "fs.search_text",
    description: "Search text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        query: { type: "string" },
        glob: { type: "string" },
        caseSensitive: { type: "boolean" },
        maxResults: { type: "number" },
        maxPreviewChars: { type: "number" },
        maxTotalPreviewChars: { type: "number" },
      },
      required: ["path", "query"],
    },
  };
}

function repoTraceTool() {
  return {
    name: "repo.trace",
    description: "Trace repository references.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        seeds: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["seeds"],
    },
  };
}

test("compileIntent does not seed hidden progress when goal-satisfied finalization omits it", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    sourceRunId: "model-run-direct-answer",
    output: {
      version: "v2",
      reason: "No external tool evidence is needed for this direct answer.",
      plan: {
        intent: "Answer the greeting.",
        successCriteria: ["The user receives a direct response."],
        rationale: "The user greeted the assistant.",
      },
      requiredCapabilities: [],
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Hi.",
      },
      confidence: 0.95,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
    },
    observedCapabilities: [],
    capabilityManifest: [],
  });

  assert.equal(compiled.action?.kind, "finalize");
});

test("compileIntent rejects build-mode goal_satisfied before execution evidence", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          reason: "The app is complete.",
          plan: {
            intent: "Build the app.",
            successCriteria: ["The app is complete."],
          },
          requiredCapabilities: [],
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "Done.",
          },
          confidence: 0.95,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
        },
        observedCapabilities: [],
        capabilityManifest: [],
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reason, "build_goal_satisfied_without_evidence");
      return true;
    },
  );
});

test("compileIntent rejects build-mode goal_satisfied with only fresh completed visible todos", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          reason: "The app is complete.",
          plan: {
            intent: "Build the app.",
            successCriteria: ["The app is complete."],
          },
          requiredCapabilities: [],
          visibleTodos: {
            objective: "Build the app.",
            items: [
              {
                id: "build-app",
                text: "Build the app",
                status: "done",
              },
            ],
          },
          nextAction: {
            kind: "finalize",
            status: "goal_satisfied",
            message: "Done.",
          },
          confidence: 0.95,
          verification: {
            missingCapabilities: [],
            actionNovelty: true,
            expectedEvidenceDelta: "low",
          },
        },
        observedCapabilities: [],
        capabilityManifest: [],
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reason, "build_goal_satisfied_without_evidence");
      return true;
    },
  );
});

test("compileIntent allows build-mode goal_satisfied after execution evidence", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    output: {
      version: "v2",
      reason: "The app is complete.",
      plan: {
        intent: "Build the app.",
        successCriteria: ["The app is complete."],
      },
      requiredCapabilities: [],
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Done.",
      },
      confidence: 0.95,
      verification: {
        missingCapabilities: [],
        actionNovelty: true,
        expectedEvidenceDelta: "low",
      },
    },
    observedCapabilities: ["fs.write"],
    capabilityManifest: [],
  });

  assert.equal(compiled.action?.kind, "finalize");
});

test("compileIntent rejects build-mode goal_satisfied with stale workspace evidence", () => {
  assert.throws(
    () => compileIntent({
      phase: "deliberator",
      interactionMode: "build",
      output: {
        version: "v2",
        reason: "The edit is complete.",
        plan: { intent: "Edit the app.", successCriteria: ["The edit is complete."] },
        requiredCapabilities: [],
        nextAction: { kind: "finalize", status: "goal_satisfied", message: "Done." },
        confidence: 0.95,
        verification: { missingCapabilities: [], actionNovelty: true, expectedEvidenceDelta: "low" },
      },
      observedCapabilities: ["filesystem.write"],
      capabilityManifest: [],
      evidenceLedger: [{
        id: "mutation",
        version: "v1",
        createdAt: "2026-07-17T00:00:01.000Z",
        stepIndex: 1,
        source: "tool",
        kind: "file_write",
        status: "passed",
        summary: "fs.write_text changed src/app.ts.",
        facts: { toolName: "fs.write_text", changedFiles: ["src/app.ts"] },
      }],
    }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reason, "build_goal_satisfied_with_stale_workspace");
      assert.deepEqual(cast.details?.changedFiles, ["src/app.ts"]);
      return true;
    },
  );
});

test("compileIntent rejects build-mode goal_satisfied with a live exec_command session", () => {
  assert.throws(
    () => compileIntent({
      phase: "deliberator",
      interactionMode: "build",
      output: {
        version: "v2",
        reason: "The server is running.",
        plan: { intent: "Start the app.", successCriteria: ["The app starts."] },
        requiredCapabilities: [],
        nextAction: { kind: "finalize", status: "goal_satisfied", message: "Done." },
        confidence: 0.95,
        verification: { missingCapabilities: [], actionNovelty: true, expectedEvidenceDelta: "low" },
      },
      observedCapabilities: ["dev.shell"],
      capabilityManifest: [],
      devShellProcesses: [{ processId: "proc-live", status: "RUNNING", workspaceRoot: "/tmp/project" }],
    }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.match(cast.message, /exec_command with \{"sessionId":"proc-live","assistantProgress":"I am checking the running process\."\} and no command/u);
      assert.equal(cast.details?.reason, "build_goal_satisfied_with_live_exec_command");
      assert.deepEqual(cast.details?.sessionIds, ["proc-live"]);
      return true;
    },
  );
});

test("compileIntent allows explicitly warned unresolved validation when no todo remains", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    interactionMode: "build",
    output: {
      version: "v2",
      reason: "The edit is complete but the test runner is unavailable.",
      plan: { intent: "Edit the app.", successCriteria: ["The edit is complete."] },
      requiredCapabilities: [],
      nextAction: {
        kind: "finalize",
        status: "goal_satisfied",
        message: "Implemented; the test runner remained unavailable.",
        data: { knownWarnings: ["pnpm test could not run because the runner was unavailable."] },
      },
      confidence: 0.95,
      verification: { missingCapabilities: [], actionNovelty: true, expectedEvidenceDelta: "low" },
    },
    observedCapabilities: ["filesystem.write", "dev.shell"],
    capabilityManifest: [],
    evidenceLedger: [
      {
        id: "mutation",
        version: "v1",
        createdAt: "2026-07-17T00:00:01.000Z",
        stepIndex: 1,
        source: "tool",
        kind: "file_write",
        status: "passed",
        summary: "fs.write_text changed src/app.ts.",
        facts: { toolName: "fs.write_text", changedFiles: ["src/app.ts"] },
      },
      {
        id: "failed-check",
        version: "v1",
        createdAt: "2026-07-17T00:00:02.000Z",
        stepIndex: 2,
        source: "tool",
        kind: "process_result",
        status: "failed",
        summary: "pnpm test could not run.",
        facts: { toolName: "exec_command", command: "pnpm test" },
      },
    ],
  });

  assert.equal(compiled.action?.kind, "finalize");
});

test("compileIntent allows more tool work without hidden progress gates", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    output: fsReadDecision("newsletter-report.json"),
    observedCapabilities: ["filesystem.read"],
    capabilityManifest: [{
      name: "fs.read_text",
      description: "Read a text file.",
      capabilityClasses: ["filesystem.read"],
    }],
    availableTools: [readTextTool],
  });

  assert.equal(compiled.action?.kind, "tool");
  assert.equal(compiled.action?.name, "fs.read_text");
});

test("compileIntent rejects generic build-mode cannot_satisfy without concrete unavailable evidence", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          reason: "The JSON verification failed.",
          plan: {
            intent: "Build static newsletter artifacts.",
            successCriteria: ["newsletter-report.json verifies"],
          },
          requiredCapabilities: [],
          nextAction: {
            kind: "cannot_satisfy",
            reasonCode: "unsatisfied_by_available_tools",
            message: "The JSON verification is not passing.",
          },
          confidence: 0.7,
          verification: {
            missingCapabilities: [],
            actionNovelty: false,
            expectedEvidenceDelta: "low",
          },
        },
        observedCapabilities: [],
        capabilityManifest: [
          {
            name: "fs.write_text",
            description: "Write a text file.",
            capabilityClasses: [],
          },
          {
            name: "fs.verify_json",
            description: "Verify JSON.",
            capabilityClasses: [],
          },
        ],
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reasonCode, "unsatisfied_by_available_tools");
      assert.equal(cast.details?.interactionMode, "build");
      assert.equal(cast.details?.requiredAction, "choose_available_tool_or_concrete_blocker");
      return true;
    },
  );
});

test("compileIntent rejects build-mode insufficient_horizon cannot_satisfy", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          reason: "The task needs more implementation steps.",
          plan: {
            intent: "Report a terminal blocker.",
            successCriteria: ["The blocker is reported."],
          },
          requiredCapabilities: [],
          nextAction: {
            kind: "cannot_satisfy",
            reasonCode: "insufficient_horizon",
            message: "The requested work is too large to complete here.",
          },
          confidence: 0.7,
          verification: {
            missingCapabilities: [],
            actionNovelty: false,
            expectedEvidenceDelta: "low",
          },
        },
        observedCapabilities: [],
        capabilityManifest: [
          {
            name: "fs.write_text",
            description: "Write a text file.",
            capabilityClasses: ["filesystem.write"],
          },
        ],
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reasonCode, "insufficient_horizon");
      assert.equal(cast.details?.interactionMode, "build");
      assert.equal(cast.details?.requiredAction, "choose_available_tool_or_concrete_blocker");
      return true;
    },
  );
});

test("compileIntent rejects build-mode need_user_choice cannot_satisfy", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          reason: "The model needs a product decision.",
          plan: {
            intent: "Ask for the required product decision.",
            successCriteria: ["The user sees the question."],
          },
          requiredCapabilities: [],
          nextAction: {
            kind: "cannot_satisfy",
            reasonCode: "need_user_choice",
            message: "I need you to choose a design direction.",
          },
          confidence: 0.7,
          verification: {
            missingCapabilities: [],
            actionNovelty: false,
            expectedEvidenceDelta: "low",
          },
        },
        observedCapabilities: [],
        capabilityManifest: [],
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reasonCode, "need_user_choice");
      assert.equal(cast.details?.requiredAction, "ask_user_for_concrete_decision");
      return true;
    },
  );
});

test("compileIntent rejects generic build blocker when executable tools are available", () => {
  assert.throws(
    () =>
      compileIntent({
        phase: "deliberator",
        interactionMode: "build",
        output: {
          version: "v2",
          reason: "The workspace is empty.",
          plan: {
            intent: "Report the scaffold blocker.",
            successCriteria: ["The blocker is reported."],
          },
          requiredCapabilities: [],
          nextAction: {
            kind: "cannot_satisfy",
            reasonCode: "unsatisfied_by_available_tools",
            message: "There is no scaffold command available.",
          },
          confidence: 0.7,
          verification: {
            missingCapabilities: [],
            actionNovelty: false,
            expectedEvidenceDelta: "low",
          },
        },
        observedCapabilities: [],
        capabilityManifest: [
          {
            name: "dev.shell.run",
            description: "Run a shell command.",
            capabilityClasses: ["dev.shell", "host.shell"],
            executionClass: "external_side_effect",
          },
        ],
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.reasonCode, "unsatisfied_by_available_tools");
      assert.equal(cast.details?.requiredAction, "choose_available_tool_or_concrete_blocker");
      assert.deepEqual(cast.details?.availableToolHints, [
        {
          name: "dev.shell.run",
          executionClass: "external_side_effect",
          capabilityClasses: ["dev.shell", "host.shell"],
        },
      ]);
      return true;
    },
  );
});

test("compileAgentAction rejects policy_blocked finalize as a deliberator closeout", () => {
  assert.throws(
    () =>
      compileAgentAction({
        phase: "deliberator",
        interactionMode: "build",
        action: {
          kind: "finalize",
          finalizeReason: "policy_blocked",
          input: {
            message: "The current policy blocks this work.",
          },
          supportEvidence: {
            reason: "claimed_policy_block",
          },
        },
        observedCapabilities: [],
        capabilityManifest: [
          {
            name: "fs.read_text",
            description: "Read a text file.",
            capabilityClasses: ["filesystem.read"],
          },
        ],
        toolIntent: {
          objective: "Verify the requested browser flow.",
          confidence: 1,
          candidateTools: ["browser.open"],
          allowlistedCandidates: [],
          derivedRequiredCapabilities: ["browser.automation"],
        },
      }),
    (error) => {
      const cast = error as Error & { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "DECISION_POLICY_FAILED");
      assert.equal(cast.details?.finalizeReason, "policy_blocked");
      assert.equal(cast.details?.requiredAction, "choose_valid_deliberator_action");
      return true;
    },
  );
});

test("compileIntent keeps non-build insufficient_horizon compatibility", () => {
  const compiled = compileIntent({
    phase: "deliberator",
    interactionMode: "plan",
    output: {
      version: "v2",
      reason: "The request is too large for the current planning pass.",
      plan: {
        intent: "Report the limitation.",
        successCriteria: ["The user sees the limitation."],
      },
      requiredCapabilities: [],
      nextAction: {
        kind: "cannot_satisfy",
        reasonCode: "insufficient_horizon",
        message: "The requested work is too large to complete here.",
      },
      confidence: 0.7,
      verification: {
        missingCapabilities: [],
        actionNovelty: false,
        expectedEvidenceDelta: "low",
      },
    },
    observedCapabilities: [],
    capabilityManifest: [],
  });

  assert.equal(compiled.action?.kind, "cannot_satisfy");
});
