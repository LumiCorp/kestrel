import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import type { ModelToolSpec } from "../../src/kestrel/contracts/model-io.js";

import { validateToolActionSchemas } from "../../agents/reference-react/src/decision/compileIntent.js";
import {
  normalizeToolActionInput,
  sanitizeToolInputForSchema,
} from "../../agents/reference-react/src/toolInputNormalization.js";
import { execCommandTool } from "../../tools/devshell/execCommand.js";
import { devShellRunTool } from "../../tools/devshell/run.js";

const CODE_EXECUTE_TOOLS: ModelToolSpec[] = [
  {
    name: "code.execute",
    description: "Execute code in a sandbox",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        language: {
          type: "string",
          enum: ["javascript", "python", "bash"],
        },
        code: {
          type: "string",
          minLength: 1,
        },
        files: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", minLength: 1 },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        dependencies: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        args: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["language", "code"],
    },
  },
];

const FILESYSTEM_TOOLS: ModelToolSpec[] = [
  {
    name: "fs.list",
    description: "List files and directories within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        maxDepth: { type: "number" },
        includeHidden: { type: "boolean" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs.read_text",
    description: "Read a UTF-8 text file from the workspace or temp roots.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs.search_text",
    description: "Search UTF-8 text files within the workspace or temp roots.",
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
  },
  {
    name: "fs.write_text",
    description: "Write or append UTF-8 text within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append"] },
        createParents: { type: "boolean" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "fs.replace_text",
    description: "Replace literal UTF-8 text in a file within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        all: { type: "boolean" },
      },
      required: ["path", "find", "replace"],
    },
  },
  {
    name: "fs.mkdir",
    description: "Create a directory within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs.delete",
    description: "Delete a file or directory within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
    },
  },
  {
    name: "fs.copy",
    description: "Copy a file or directory within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sourcePath: { type: "string" },
        destinationPath: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["sourcePath", "destinationPath"],
    },
  },
  {
    name: "fs.move",
    description: "Move a file or directory within the workspace or temp roots.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sourcePath: { type: "string" },
        destinationPath: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["sourcePath", "destinationPath"],
    },
  },
];

const DEV_SHELL_TOOLS: ModelToolSpec[] = [
  {
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
        sourceMutation: {
          type: "string",
          enum: ["reject", "capture"],
        },
        yieldTimeMs: { type: "number" },
        timeoutMs: { type: "number" },
        maxOutputBytes: { type: "number" },
      },
    },
  },
  {
    name: "dev.shell.run",
    description: "Run a shell command as a process.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceRoot: { type: "string", minLength: 1 },
        command: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
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
      required: ["command"],
    },
  },
  {
    name: "dev.process.write",
    description: "Write stdin to a live shell process.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        data: { type: "string" },
      },
      required: ["processId", "data"],
    },
  },
  {
    name: "dev.process.read",
    description: "Read new output from a live or recently completed shell process.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        cursor: { type: "number" },
        waitMs: { type: "number" },
        maxBytes: { type: "number" },
      },
      required: ["processId"],
    },
  },
  {
    name: "dev.process.write_and_read",
    description: "Write stdin to a live shell process and read resulting output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        data: { type: "string" },
        cursor: { type: "number" },
        waitMs: { type: "number" },
        maxBytes: { type: "number" },
      },
      required: ["processId", "data"],
    },
  },
  {
    name: "dev.process.stop",
    description: "Stop a live shell process.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        signal: { type: "string" },
        cursor: { type: "number" },
        waitMs: { type: "number" },
        maxBytes: { type: "number" },
      },
      required: ["processId"],
    },
  },
];

function assertToolSchemaValid(name: string, input: Record<string, unknown>) {
  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name,
        input,
      },
      FILESYSTEM_TOOLS,
    ),
  );
}

test("normalizeToolActionInput wraps scalar code.execute array fields without heuristic guessing", () => {
  const normalized = normalizeToolActionInput("code.execute", {
    language: "bash",
    code: "echo hi",
    args: "--flag",
    dependencies: "requests",
    files: {
      path: "facts.md",
      content: "Reds notes",
    },
  });

  assert.deepEqual(normalized.args, ["--flag"]);
  assert.deepEqual(normalized.dependencies, ["requests"]);
  assert.deepEqual(normalized.files, [
    {
      path: "facts.md",
      content: "Reds notes",
    },
  ]);

  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "code.execute",
        input: normalized,
      },
      CODE_EXECUTE_TOOLS,
    ),
  );
});

test("normalizeToolActionInput preserves existing code.execute arrays for schema validation", () => {
  const normalized = normalizeToolActionInput("code.execute", {
    language: "bash",
    code: "echo hi",
    args: [1],
  });

  assert.deepEqual(normalized.args, [1]);

  assert.throws(
    () =>
      validateToolActionSchemas(
        {
          kind: "tool",
          name: "code.execute",
          input: normalized,
        },
        CODE_EXECUTE_TOOLS,
      ),
    /must be string/,
  );
});

test("validateToolActionSchemas returns compact expected and received details for runtime feedback", () => {
  let error: (Error & { diagnostics?: Record<string, unknown> }) | undefined;
  try {
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "fs.copy",
        input: {
          overwrite: true,
        },
      },
      FILESYSTEM_TOOLS,
    );
  } catch (caught) {
    error = caught as Error & { diagnostics?: Record<string, unknown> };
  }

  assert.ok(error);
  assert.match(error.message, /must have required property/);
  assert.equal(error.diagnostics?.toolName, "fs.copy");
  assert.equal(error.diagnostics?.path, "nextAction.input");
  assert.equal(error.diagnostics?.expected, "required property 'sourcePath'");
  assert.equal(error.diagnostics?.received, "missing");
  assert.equal(error.diagnostics?.validationPath, "");
  assert.equal(typeof error.diagnostics?.schemaPath, "string");
});

test("normalizeToolActionInput canonicalizes internet.research topic aliases", () => {
  const normalized = normalizeToolActionInput("internet.research", {
    query: "Cults of Cincinnati, OH",
    depth: "deep",
    maxSources: "8",
    includeNews: "false",
    includeImages: "true",
    region: "global",
  });

  assert.deepEqual(normalized, {
    input: "Cults of Cincinnati, OH",
    query: "Cults of Cincinnati, OH",
  });
});

test("normalizeToolActionInput omits empty internet.research outputSchema", () => {
  const normalized = normalizeToolActionInput("internet.research", {
    query: "Cults of Cincinnati, OH",
    outputSchema: {},
  });

  assert.deepEqual(normalized, {
    input: "Cults of Cincinnati, OH",
    query: "Cults of Cincinnati, OH",
  });
});

test("normalizeToolActionInput canonicalizes evidence.extract content aliases", () => {
  const normalized = normalizeToolActionInput("evidence.extract", {
    content: "Deterministic validation reduced manual rework by 18 percent.",
    claim: "Validation reduces manual rework",
    source: "report-1",
    limit: "3",
    unexpected: true,
  });

  assert.deepEqual(normalized, {
    text: "Deterministic validation reduced manual rework by 18 percent.",
    claim: "Validation reduces manual rework",
    sourceId: "report-1",
    maxItems: 3,
  });
});

test("normalizeToolActionInput strips unsupported fields from strict tool schemas", () => {
  const codeExecute = normalizeToolActionInput("code.execute", {
    language: "python",
    code: "print('ok')",
    timeoutMs: "1000",
    extra: "ignored",
  });
  const internetSearch = normalizeToolActionInput("internet.search", {
    query: "latest tariffs",
    freshness: "day",
    extra: "ignored",
  });
  const internetNews = normalizeToolActionInput("internet.news", {
    query: "latest tariffs",
    region: "us",
    extra: "ignored",
  });
  const internetImages = normalizeToolActionInput("internet.images", {
    query: "cargo ships",
    safeSearch: "strict",
    extra: "ignored",
  });
  const getUrl = normalizeToolActionInput("internet.extract", {
    url: "https://example.com",
    maxChars: "500",
    extra: "ignored",
  });
  const scrape = normalizeToolActionInput("internet.extract", {
    url: "https://example.com",
    selectors: "article, .summary",
    extra: "ignored",
  });
  const headlines = normalizeToolActionInput("internet.news", {
    scope: "global",
    limit: "5",
    extra: "ignored",
  });

  assert.deepEqual(codeExecute, {
    language: "python",
    code: "print('ok')",
    timeoutMs: 1000,
  });
  assert.deepEqual(internetSearch, {
    query: "latest tariffs",
    freshness: "day",
  });
  assert.deepEqual(internetNews, {
    query: "latest tariffs",
  });
  assert.deepEqual(internetImages, {
    query: "cargo ships",
  });
  assert.deepEqual(getUrl, {
    url: "https://example.com",
    maxChars: 500,
  });
  assert.deepEqual(scrape, {
    url: "https://example.com",
  });
  assert.deepEqual(headlines, {
    limit: 5,
  });
});

test("sanitizeToolInputForSchema strips unknown strict-schema fields recursively", () => {
  const sanitized = sanitizeToolInputForSchema(CODE_EXECUTE_TOOLS[0]!.inputSchema, {
    language: "javascript",
    code: "console.log('ok')",
    files: [
      {
        path: "index.js",
        content: "console.log('nested')",
        extra: "ignored",
      },
    ],
    extra: "ignored",
  });

  assert.deepEqual(sanitized, {
    language: "javascript",
    code: "console.log('ok')",
    files: [
      {
        path: "index.js",
        content: "console.log('nested')",
      },
    ],
  });
});

test("normalizeToolActionInput strips unadvertised internet.news domain filters", () => {
  const normalized = normalizeToolActionInput("internet.news", {
    query: "latest U.S. business headlines",
    freshness: "day",
    region: "us",
    limit: "5",
    domainAllow: "reuters.com, apnews.com",
    domainDeny: "facebook.com",
  });

  assert.deepEqual(normalized, {
    query: "latest U.S. business headlines",
    freshness: "day",
    limit: 5,
  });
});

test("normalizeToolActionInput strips internet.search_advanced freshness and days when explicit dates are present", () => {
  const normalized = normalizeToolActionInput("internet.search_advanced", {
    query: "TCS latest revenue and headcount",
    freshness: "year",
    days: 7,
    startDate: "2026-01-01",
    endDate: "2026-05-15",
  });

  assert.deepEqual(normalized, {
    query: "TCS latest revenue and headcount",
    startDate: "2026-01-01",
    endDate: "2026-05-15",
  });
});

test("normalizeToolActionInput strips Tavily-conditional search_advanced fields without prerequisites", () => {
  const normalized = normalizeToolActionInput("internet.search_advanced", {
    query: "TCS latest revenue and headcount",
    topic: "general",
    searchDepth: "basic",
    chunksPerSource: 3,
    days: 7,
  });

  assert.deepEqual(normalized, {
    query: "TCS latest revenue and headcount",
    topic: "general",
    searchDepth: "basic",
  });
});

test("normalizeToolActionInput preserves Tavily-conditional search_advanced fields with prerequisites", () => {
  const normalized = normalizeToolActionInput("internet.search_advanced", {
    query: "TCS latest revenue and headcount",
    topic: "news",
    searchDepth: "advanced",
    chunksPerSource: 2,
    days: 7,
  });

  assert.deepEqual(normalized, {
    query: "TCS latest revenue and headcount",
    topic: "news",
    searchDepth: "advanced",
    chunksPerSource: 2,
    days: 7,
  });
});

test("normalizeToolActionInput strips extract and crawl chunksPerSource without Tavily prerequisites", () => {
  const extract = normalizeToolActionInput("internet.extract", {
    url: "https://example.com/page",
    chunksPerSource: 5,
  });
  const crawl = normalizeToolActionInput("internet.crawl", {
    url: "https://example.com",
    chunksPerSource: 5,
  });

  assert.deepEqual(extract, {
    url: "https://example.com/page",
  });
  assert.deepEqual(crawl, {
    url: "https://example.com",
  });
});

test("normalizeToolActionInput strips incompatible internet.search_advanced country hints", () => {
  const normalized = normalizeToolActionInput("internet.search_advanced", {
    query: "TCS latest revenue and headcount",
    topic: "news",
    country: "india",
    includeRawContent: true,
  });

  assert.deepEqual(normalized, {
    query: "TCS latest revenue and headcount",
    topic: "news",
    includeRawContent: "markdown",
  });
});

test("normalizeToolActionInput strips unsupported internet.search_advanced country hints for fast search depth", () => {
  const normalized = normalizeToolActionInput("internet.search_advanced", {
    query: "current U.S. business and technology news",
    topic: "general",
    searchDepth: "fast",
    country: "united states",
  });

  assert.deepEqual(normalized, {
    query: "current U.S. business and technology news",
    topic: "general",
    searchDepth: "fast",
  });
});

test("normalizeToolActionInput defaults missing fs.list path to dot", () => {
  const normalized = normalizeToolActionInput("fs.list", {});

  assert.deepEqual(normalized, {
    path: ".",
  });

  assertToolSchemaValid("fs.list", normalized);
});

test("normalizeToolActionInput defaults blank fs.list path to dot", () => {
  const normalized = normalizeToolActionInput("fs.list", {
    path: "   ",
    recursive: true,
  });

  assert.deepEqual(normalized, {
    path: ".",
    recursive: true,
  });

  assertToolSchemaValid("fs.list", normalized);
});

test("normalizeToolActionInput strips unsupported fs.list fields and preserves supported ones", () => {
  const normalized = normalizeToolActionInput("fs.list", {
    path: "src",
    recursive: "true",
    maxDepth: "2",
    includeHidden: "false",
    query: "list files",
    url: "https://example.com",
  });

  assert.deepEqual(normalized, {
    path: "src",
    recursive: true,
    maxDepth: 2,
    includeHidden: false,
  });

  assertToolSchemaValid("fs.list", normalized);
});

test("normalizeToolActionInput defaults read and edit filesystem tools to dot", () => {
  const readText = normalizeToolActionInput("fs.read_text", {});
  const searchText = normalizeToolActionInput("fs.search_text", {
    pattern: "TODO",
  });
  const writeText = normalizeToolActionInput("fs.write_text", {
    text: "hello",
  });
  const replaceText = normalizeToolActionInput("fs.replace_text", {
    find: "a",
    replace: "b",
  });

  assert.deepEqual(readText, { path: "." });
  assert.deepEqual(searchText, { path: ".", query: "TODO" });
  assert.deepEqual(writeText, { path: ".", content: "hello" });
  assert.deepEqual(replaceText, { path: ".", find: "a", replace: "b" });

  assertToolSchemaValid("fs.read_text", readText);
  assertToolSchemaValid("fs.search_text", searchText);
  assertToolSchemaValid("fs.write_text", writeText);
  assertToolSchemaValid("fs.replace_text", replaceText);
});

test("normalizeToolActionInput keeps fs.mkdir and fs.delete pathless when the model omitted a target", () => {
  const mkdir = normalizeToolActionInput("fs.mkdir", {});
  const del = normalizeToolActionInput("fs.delete", {});

  assert.deepEqual(mkdir, {});
  assert.deepEqual(del, {});
});

test("normalizeToolActionInput applies filesystem aliases and type coercions", () => {
  const readText = normalizeToolActionInput("fs.read_text", {
    filePath: "README.md",
    maxBytes: "1024",
    extra: "ignored",
  });
  const searchText = normalizeToolActionInput("fs.search_text", {
    targetPath: "src",
    pattern: "TODO",
    caseSensitive: "true",
    maxResults: "3",
    maxPreviewChars: "120",
    maxTotalPreviewChars: "4096",
    noise: "ignored",
  });
  const writeText = normalizeToolActionInput("fs.write_text", {
    filePath: "notes.txt",
    text: "hello",
    createParents: "true",
    extra: "ignored",
  });
  const copy = normalizeToolActionInput("fs.copy", {
    from: "src/a.txt",
    to: "src/b.txt",
    overwrite: "true",
    extra: "ignored",
  });
  const move = normalizeToolActionInput("fs.move", {
    from: "src/a.txt",
    to: "src/b.txt",
    overwrite: "false",
    extra: "ignored",
  });

  assert.deepEqual(readText, {
    path: "README.md",
    maxBytes: 1024,
  });
  assert.deepEqual(searchText, {
    path: "src",
    query: "TODO",
    caseSensitive: true,
    maxResults: 3,
    maxPreviewChars: 120,
    maxTotalPreviewChars: 4096,
  });
  assert.deepEqual(writeText, {
    path: "notes.txt",
    content: "hello",
    createParents: true,
  });
  assert.deepEqual(copy, {
    sourcePath: "src/a.txt",
    destinationPath: "src/b.txt",
    overwrite: true,
  });
  assert.deepEqual(move, {
    sourcePath: "src/a.txt",
    destinationPath: "src/b.txt",
    overwrite: false,
  });

  assertToolSchemaValid("fs.read_text", readText);
  assertToolSchemaValid("fs.search_text", searchText);
  assertToolSchemaValid("fs.write_text", writeText);
  assertToolSchemaValid("fs.copy", copy);
  assertToolSchemaValid("fs.move", move);
});

test("normalizeToolActionInput keeps exact filesystem fields over aliases", () => {
  const normalized = normalizeToolActionInput("fs.write_text", {
    path: "exact.txt",
    filePath: "alias.txt",
    content: "exact",
    text: "alias",
  });

  assert.deepEqual(normalized, {
    path: "exact.txt",
    content: "exact",
  });

  assertToolSchemaValid("fs.write_text", normalized);
});

test("normalizeToolActionInput does not invent copy or move paths", () => {
  const copy = normalizeToolActionInput("fs.copy", {
    overwrite: "true",
  });
  const move = normalizeToolActionInput("fs.move", {
    from: "src/a.txt",
  });

  assert.deepEqual(copy, {
    overwrite: true,
  });
  assert.deepEqual(move, {
    sourcePath: "src/a.txt",
  });

  assert.throws(
    () =>
      validateToolActionSchemas(
        {
          kind: "tool",
          name: "fs.copy",
          input: copy,
        },
        FILESYSTEM_TOOLS,
      ),
    /must have required property/,
  );
  assert.throws(
    () =>
      validateToolActionSchemas(
        {
          kind: "tool",
          name: "fs.move",
          input: move,
        },
        FILESYSTEM_TOOLS,
      ),
    /must have required property/,
  );
});

test("normalizeToolActionInput defaults dev.shell.run workspaceRoot and keeps explicit command fields", () => {
  const normalized = normalizeToolActionInput("dev.shell.run", {
    workspaceRoot: "   ",
    command: "pnpm dev",
    cwd: " ./apps/web ",
    requiredTools: "pnpm,node",
    envNames: ["OPENAI_API_KEY", "  "],
    envMode: "inherit",
    yieldTimeMs: "250",
    timeoutMs: "3000",
    maxOutputBytes: "4096",
    extra: "drop-me",
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command: "pnpm dev",
    cwd: "./apps/web",
    requiredTools: ["pnpm", "node"],
    envNames: ["OPENAI_API_KEY"],
    envMode: "inherit",
    yieldTimeMs: 250,
    timeoutMs: 3000,
    maxOutputBytes: 4096,
  });

  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "dev.shell.run",
        input: normalized,
      },
      DEV_SHELL_TOOLS,
    ),
  );
});

test("normalizeToolActionInput clamps dev.shell.run workspaceRoot and cwd to the active workspace root", () => {
  const activeWorkspaceRoot = "/home/sandbox/workspace";
  const normalized = normalizeToolActionInput("dev.shell.run", {
    workspaceRoot: "../outside-workspace",
    cwd: "../outside-workspace/tmp",
    command: "echo ok",
  }, activeWorkspaceRoot);
  assert.equal(normalized.workspaceRoot, activeWorkspaceRoot);
  assert.equal(normalized.cwd, path.resolve(activeWorkspaceRoot));
});

test("normalizeToolActionInput clamps dev.shell.run cwd to workspace root even with absolute requests", () => {
  const activeWorkspaceRoot = "/home/sandbox/workspace";
  const normalized = normalizeToolActionInput("dev.shell.run", {
    workspaceRoot: activeWorkspaceRoot,
    cwd: "/var/tmp",
    command: "echo ok",
  }, activeWorkspaceRoot);
  assert.equal(normalized.workspaceRoot, activeWorkspaceRoot);
  assert.equal(normalized.cwd, path.resolve(activeWorkspaceRoot));
});

test("normalizeToolActionInput clamps dev.process.start workspaceRoot and cwd to the active workspace root", () => {
  const activeWorkspaceRoot = "/home/sandbox/workspace";
  const normalized = normalizeToolActionInput("dev.process.start", {
    workspaceRoot: "../outside-workspace",
    cwd: "../outside-workspace/tmp",
    command: "echo ok",
  }, activeWorkspaceRoot);
  assert.equal(normalized.workspaceRoot, activeWorkspaceRoot);
  assert.equal(normalized.cwd, path.resolve(activeWorkspaceRoot));
});

test("normalizeToolActionInput keeps exec_command lifecycle fields visible for validation", () => {
  const start = normalizeToolActionInput("exec_command", {
    workspaceRoot: "../outside-workspace",
    cwd: "coding-fixture",
    command: "```bash\n./maze_game.sh\n```",
    requiredTools: "bash,python3",
    envNames: ["OPENROUTER_API_KEY", "  "],
    envMode: "inherit",
    sourceMutation: "capture",
    yieldTimeMs: "100",
    timeoutMs: "1000",
    maxOutputBytes: "4096",
  }, "/home/sandbox/workspace");
  const session = normalizeToolActionInput("exec_command", {
    sessionId: " proc-123 ",
    stdin: "move N\n",
    yieldTimeMs: "50",
    maxOutputBytes: "1024",
    command: "   ",
    extra: "drop-me",
  });

  assert.deepEqual(start, {
    command: "./maze_game.sh",
    cwd: "coding-fixture",
    requiredTools: ["bash", "python3"],
    envNames: ["OPENROUTER_API_KEY"],
    envMode: "inherit",
    sourceMutation: "capture",
    yieldTimeMs: 100,
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  });
  assert.deepEqual(session, {
    sessionId: "proc-123",
    stdin: "move N\n",
    yieldTimeMs: 50,
    maxOutputBytes: 1024,
  });

  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "exec_command",
        input: start,
      },
      DEV_SHELL_TOOLS,
    ),
  );
  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "exec_command",
        input: session,
      },
      DEV_SHELL_TOOLS,
    ),
  );
});

test("normalizeToolActionInput preserves every advertised dev-shell command field", () => {
  const activeWorkspaceRoot = path.resolve(".");
  const runInput = {
    workspaceRoot: activeWorkspaceRoot,
    command: "pnpm test",
    cwd: "apps/desktop",
    requiredTools: ["pnpm"],
    envNames: ["CI"],
    envMode: "allowlist",
    yieldTimeMs: 250,
    timeoutMs: 5_000,
    maxOutputBytes: 8_192,
  };
  const execInput = {
    command: "pnpm test",
    cwd: "apps/desktop",
    requiredTools: ["pnpm"],
    envNames: ["CI"],
    envMode: "allowlist",
    sourceMutation: "capture",
    yieldTimeMs: 250,
    timeoutMs: 5_000,
    maxOutputBytes: 8_192,
  };

  assert.deepEqual(normalizeToolActionInput("dev.shell.run", runInput), runInput);
  assert.deepEqual(normalizeToolActionInput("exec_command", execInput), execInput);

  const runSchemaFields = Object.keys(devShellRunTool.definition.inputSchema.properties ?? {}).sort();
  const execSchemaFields = Object.keys(execCommandTool.definition.inputSchema.properties ?? {}).sort();
  assert.deepEqual(Object.keys(normalizeToolActionInput("dev.shell.run", runInput)).sort(), runSchemaFields);
  assert.deepEqual(Object.keys(normalizeToolActionInput("exec_command", execInput)).sort(), execSchemaFields.filter(
    (field) => field !== "sessionId" && field !== "stdin" && field !== "stop",
  ));
});

test("normalizeToolActionInput keeps typed desktop host-open fields and drops extras", () => {
  assert.deepEqual(normalizeToolActionInput("desktop.host.open", {
    kind: " workspace_path ",
    path: " reports/result.html ",
    application: " Safari ",
    extra: "drop-me",
  }), {
    kind: "workspace_path",
    path: "reports/result.html",
    application: "Safari",
  });
});

test("normalizeToolActionInput preserves invalid exec_command cwd for explicit boundary rejection", () => {
  assert.deepEqual(
    normalizeToolActionInput("exec_command", {
      command: "pwd",
      cwd: "../outside-workspace",
      workspaceRoot: "/host-only/worktree",
    }, "/home/sandbox/workspace"),
    {
      command: "pwd",
      cwd: "../outside-workspace",
    },
  );
});

test("normalizeToolActionInput keeps explicit dev.process.write input", () => {
  const normalized = normalizeToolActionInput("dev.process.write", {
    processId: " proc-123 ",
    data: " move N\nmove E\n",
    yieldTimeMs: "100",
    command: "drop-me",
  });

  assert.deepEqual(normalized, {
    processId: "proc-123",
    data: " move N\nmove E\n",
  });

  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "dev.process.write",
        input: normalized,
      },
      DEV_SHELL_TOOLS,
    ),
  );
});

test("normalizeToolActionInput normalizes dev.process.read and dev.process.stop process ids", () => {
  const read = normalizeToolActionInput("dev.process.read", {
    processId: " proc-123 ",
    maxBytes: "2048",
    extra: "drop-me",
  });
  const stop = normalizeToolActionInput("dev.process.stop", {
    processId: " proc-123 ",
    signal: "SIGTERM",
    waitMs: "100",
    extra: "drop-me",
  });

  assert.deepEqual(read, {
    processId: "proc-123",
    maxBytes: 2048,
  });
  assert.deepEqual(stop, {
    processId: "proc-123",
    signal: "SIGTERM",
    waitMs: 100,
  });
});

test("normalizeToolActionInput keeps explicit dev.process.write_and_read input", () => {
  const normalized = normalizeToolActionInput("dev.process.write_and_read", {
    processId: " proc-123 ",
    data: " move N\n",
    cursor: "7",
    waitMs: "250",
    maxBytes: "2048",
    command: "drop-me",
  });

  assert.deepEqual(normalized, {
    processId: "proc-123",
    data: " move N\n",
    cursor: 7,
    waitMs: 250,
    maxBytes: 2048,
  });

  assert.doesNotThrow(() =>
    validateToolActionSchemas(
      {
        kind: "tool",
        name: "dev.process.write_and_read",
        input: normalized,
      },
      DEV_SHELL_TOOLS,
    ),
  );
});

test("normalizeToolActionInput unwraps whole-command quotes for dev.shell.run", () => {
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command: "'mkdir -p data && cat <<'\\''EOF'\\'' > data/workflow.json\n{\"ok\":true}\nEOF'",
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command: "mkdir -p data && cat <<'EOF' > data/workflow.json\n{\"ok\":true}\nEOF",
  });
});

test("normalizeToolActionInput unwraps fenced shell commands for dev.shell.run", () => {
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command: "```bash\ncat <<'EOF' > app/page.tsx\nexport default function Page() { return null; }\nEOF\n```",
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command: "cat <<'EOF' > app/page.tsx\nexport default function Page() { return null; }\nEOF",
  });
});

test("normalizeToolActionInput converts escaped multiline python -c payloads to heredoc", () => {
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command:
      "python3 -c \"import pathlib\\npath = pathlib.Path('/tmp/example.txt')\\npath.write_text('line\\\\n')\\nprint(path.read_text())\"",
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command:
      "python3 <<'PY'\nimport pathlib\npath = pathlib.Path('/tmp/example.txt')\npath.write_text('line\\\\n')\nprint(path.read_text())\nPY",
  });
});

test("normalizeToolActionInput repairs physical newlines inside python heredoc string literals", () => {
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command:
      "python3 <<'PY'\nproc.stdin.write(b'exit\n')\\nproc.stdin.flush()\\nprint('done')\nPY",
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command:
      "python3 <<'PY'\nproc.stdin.write(b'exit\\n')\nproc.stdin.flush()\nprint('done')\nPY",
  });
});

test("normalizeToolActionInput does not rewrite multiline echo redirects into shell writes", () => {
  const command =
    "echo \"print('start')\\nprint(\\\"done\\\")\" > /app/explore.py && python3 /app/explore.py";
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command,
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command,
  });
});

test("normalizeToolActionInput does not rewrite single-quoted multiline echo redirects", () => {
  const command =
    "echo 'print('\"'\"'start'\"'\"')\\nprint(\"done\")' > /app/explore.py && python3 /app/explore.py";
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command,
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command,
  });
});

test("normalizeToolActionInput does not recover malformed single-quoted echo file writes", () => {
  const command =
    "echo '#!/usr/bin/env python3\\nprint(\\'start\\')\\nprint(\\\"done\\\") > /app/explore.py && python3 /app/explore.py";
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command,
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command,
  });
});

test("normalizeToolActionInput leaves single-line python -c payloads unchanged", () => {
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command: "python3 -c \"print('ok')\"",
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
    command: "python3 -c \"print('ok')\"",
  });
});

test("normalizeToolActionInput drops quote-only dev.shell.run commands", () => {
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command: "\"\"",
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
  });

  assert.throws(
    () =>
      validateToolActionSchemas(
        {
          kind: "tool",
          name: "dev.shell.run",
          input: normalized,
        },
        DEV_SHELL_TOOLS,
      ),
    /must have required property/,
  );
});

test("normalizeToolActionInput drops fence-only dev.shell.run commands", () => {
  const normalized = normalizeToolActionInput("dev.shell.run", {
    command: "```bash\n\n```",
  });

  assert.deepEqual(normalized, {
    workspaceRoot: ".",
  });
});
