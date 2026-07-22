import { resolve, sep } from "node:path";
import { normalizeDevShellExecCommand } from "../../src/devshell/normalizeCommand.js";
import { asNonEmptyRecord } from "../helpers.js";

export function normalizeToolActionInput(
  name: string,
  input: Record<string, unknown>,
  workspaceRoot: string | undefined = ".",
): Record<string, unknown> {
  if (name === "code.execute") {
    const {
      language: _language,
      code: _code,
      files: _files,
      timeoutMs: _timeoutMs,
      network: _network,
      dependencies: _dependencies,
      args: _args,
    } = input;
    return {
      ...(normalizeOptionalString(_language) !== undefined
        ? { language: normalizeOptionalString(_language) }
        : {}),
      ...(normalizeOptionalRawString(_code) !== undefined
        ? { code: normalizeOptionalRawString(_code) }
        : {}),
      ...(normalizeCodeExecuteFiles(_files) !== undefined
        ? { files: normalizeCodeExecuteFiles(_files) }
        : {}),
      ...(normalizeOptionalInteger(_timeoutMs) !== undefined
        ? { timeoutMs: normalizeOptionalInteger(_timeoutMs) }
        : {}),
      ...(normalizeOptionalString(_network) !== undefined
        ? { network: normalizeOptionalString(_network) }
        : {}),
      ...(normalizeCodeExecuteStringArray(_dependencies) !== undefined
        ? { dependencies: normalizeCodeExecuteStringArray(_dependencies) }
        : {}),
      ...(normalizeCodeExecuteStringArray(_args) !== undefined
        ? { args: normalizeCodeExecuteStringArray(_args) }
        : {}),
    };
  }

  if (name === "internet.search") {
    const {
      query: _query,
      limit: _limit,
      freshness: _freshness,
    } = input;
    return {
      ...(normalizeOptionalString(_query) !== undefined
        ? { query: normalizeOptionalString(_query) }
        : {}),
      ...(normalizeOptionalInteger(_limit) !== undefined
        ? { limit: normalizeOptionalInteger(_limit) }
        : {}),
      ...(normalizeOptionalString(_freshness) !== undefined
        ? { freshness: normalizeOptionalString(_freshness) }
        : {}),
    };
  }

  if (name === "internet.news") {
    const {
      query: _query,
      limit: _limit,
      freshness: _freshness,
    } = input;
    return {
      ...(normalizeOptionalString(_query) !== undefined
        ? { query: normalizeOptionalString(_query) }
        : {}),
      ...(normalizeOptionalInteger(_limit) !== undefined
        ? { limit: normalizeOptionalInteger(_limit) }
        : {}),
      ...(normalizeOptionalString(_freshness) !== undefined
        ? { freshness: normalizeOptionalString(_freshness) }
        : {}),
    };
  }

  if (name === "internet.images") {
    const { query: _query, limit: _limit } = input;
    return {
      ...(normalizeOptionalString(_query) !== undefined
        ? { query: normalizeOptionalString(_query) }
        : {}),
      ...(normalizeOptionalInteger(_limit) !== undefined
        ? { limit: normalizeOptionalInteger(_limit) }
        : {}),
    };
  }

  if (name === "internet.search_advanced") {
    const topic = normalizeOptionalString(input.topic);
    const searchDepth = normalizeOptionalString(input.searchDepth);
    const country = normalizeOptionalString(input.country);
    const startDate = normalizeOptionalString(input.startDate);
    const endDate = normalizeOptionalString(input.endDate);
    const hasExplicitDateRange = startDate !== undefined || endDate !== undefined;
    const allowSearchChunks = searchDepth === "advanced";
    const allowDays = topic === "news" && hasExplicitDateRange === false;
    const allowCountry =
      country !== undefined &&
      (topic === undefined || topic === "general") &&
      searchDepth !== "fast" &&
      searchDepth !== "ultra-fast";
    return {
      ...(normalizeOptionalString(input.query) !== undefined ? { query: normalizeOptionalString(input.query) } : {}),
      ...(normalizeOptionalInteger(input.limit) !== undefined ? { limit: normalizeOptionalInteger(input.limit) } : {}),
      ...(normalizeOptionalString(input.freshness) !== undefined && hasExplicitDateRange === false
        ? { freshness: normalizeOptionalString(input.freshness) }
        : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(searchDepth !== undefined ? { searchDepth } : {}),
      ...(normalizeOptionalInteger(input.chunksPerSource) !== undefined && allowSearchChunks ? { chunksPerSource: normalizeOptionalInteger(input.chunksPerSource) } : {}),
      ...(normalizeOptionalInteger(input.days) !== undefined && allowDays
        ? { days: normalizeOptionalInteger(input.days) }
        : {}),
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      ...(allowCountry ? { country } : {}),
      ...(normalizeIncludeAnswer(input.includeAnswer) !== undefined ? { includeAnswer: normalizeIncludeAnswer(input.includeAnswer) } : {}),
      ...(normalizeIncludeRawContent(input.includeRawContent) !== undefined ? { includeRawContent: normalizeIncludeRawContent(input.includeRawContent) } : {}),
      ...(normalizeOptionalBoolean(input.includeFavicon) !== undefined ? { includeFavicon: normalizeOptionalBoolean(input.includeFavicon) } : {}),
      ...(normalizeOptionalBoolean(input.includeUsage) !== undefined ? { includeUsage: normalizeOptionalBoolean(input.includeUsage) } : {}),
      ...(normalizeOptionalBoolean(input.exactMatch) !== undefined ? { exactMatch: normalizeOptionalBoolean(input.exactMatch) } : {}),
      ...(normalizeOptionalStringArray(input.domainAllow) !== undefined ? { domainAllow: normalizeOptionalStringArray(input.domainAllow) } : {}),
      ...(normalizeOptionalStringArray(input.domainDeny) !== undefined ? { domainDeny: normalizeOptionalStringArray(input.domainDeny) } : {}),
    };
  }

  if (name === "internet.extract") {
    const urls = normalizeOptionalStringArray(input.urls);
    const url = normalizeOptionalString(input.url);
    const query = normalizeOptionalString(input.query);
    return {
      ...(urls !== undefined ? { urls } : url !== undefined ? { url } : {}),
      ...(normalizeOptionalInteger(input.maxChars) !== undefined
        ? { maxChars: normalizeOptionalInteger(input.maxChars) }
        : {}),
      ...(query !== undefined ? { query } : {}),
      ...(normalizeOptionalInteger(input.chunksPerSource) !== undefined && query !== undefined ? { chunksPerSource: normalizeOptionalInteger(input.chunksPerSource) } : {}),
      ...(normalizeOptionalString(input.extractDepth) !== undefined ? { extractDepth: normalizeOptionalString(input.extractDepth) } : {}),
      ...(normalizeOptionalString(input.format) !== undefined ? { format: normalizeOptionalString(input.format) } : {}),
      ...(normalizeOptionalBoolean(input.includeImages) !== undefined ? { includeImages: normalizeOptionalBoolean(input.includeImages) } : {}),
      ...(normalizeOptionalBoolean(input.includeFavicon) !== undefined ? { includeFavicon: normalizeOptionalBoolean(input.includeFavicon) } : {}),
      ...(normalizeOptionalBoolean(input.includeUsage) !== undefined ? { includeUsage: normalizeOptionalBoolean(input.includeUsage) } : {}),
    };
  }

  if (name === "internet.crawl") {
    const instructions = normalizeOptionalString(input.instructions);
    return {
      ...normalizeCrawlMapInput(input),
      ...(normalizeOptionalString(input.extractDepth) !== undefined ? { extractDepth: normalizeOptionalString(input.extractDepth) } : {}),
      ...(normalizeOptionalString(input.format) !== undefined ? { format: normalizeOptionalString(input.format) } : {}),
      ...(normalizeOptionalBoolean(input.includeImages) !== undefined ? { includeImages: normalizeOptionalBoolean(input.includeImages) } : {}),
      ...(normalizeOptionalBoolean(input.includeFavicon) !== undefined ? { includeFavicon: normalizeOptionalBoolean(input.includeFavicon) } : {}),
      ...(normalizeOptionalInteger(input.chunksPerSource) !== undefined && instructions !== undefined ? { chunksPerSource: normalizeOptionalInteger(input.chunksPerSource) } : {}),
      ...(normalizeOptionalInteger(input.maxChars) !== undefined
        ? { maxChars: normalizeOptionalInteger(input.maxChars) }
        : {}),
    };
  }

  if (name === "internet.map") {
    return normalizeCrawlMapInput(input);
  }

  if (name === "internet.research") {
    const researchInput = firstDefinedString(
      normalizeOptionalString(input.input),
      normalizeOptionalString(input.query),
      normalizeOptionalString(input.topic),
    );
    return {
      ...(researchInput !== undefined ? { input: researchInput } : {}),
      ...(normalizeOptionalString(input.query) !== undefined ? { query: normalizeOptionalString(input.query) } : {}),
      ...(normalizeOptionalString(input.topic) !== undefined ? { topic: normalizeOptionalString(input.topic) } : {}),
      ...(normalizeOptionalString(input.model) !== undefined ? { model: normalizeOptionalString(input.model) } : {}),
      ...(asNonEmptyRecord(input.outputSchema) !== undefined ? { outputSchema: asNonEmptyRecord(input.outputSchema) } : {}),
      ...(normalizeOptionalString(input.citationFormat) !== undefined ? { citationFormat: normalizeOptionalString(input.citationFormat) } : {}),
      ...(normalizeOptionalBoolean(input.waitForCompletion) !== undefined ? { waitForCompletion: normalizeOptionalBoolean(input.waitForCompletion) } : {}),
      ...(normalizeOptionalInteger(input.maxWaitMs) !== undefined
        ? { maxWaitMs: normalizeOptionalInteger(input.maxWaitMs) }
        : {}),
      ...(normalizeOptionalInteger(input.pollIntervalMs) !== undefined
        ? { pollIntervalMs: normalizeOptionalInteger(input.pollIntervalMs) }
        : {}),
    };
  }

  if (name === "internet.research_status") {
    return {
      ...(normalizeOptionalString(input.requestId) !== undefined
        ? { requestId: normalizeOptionalString(input.requestId) }
        : {}),
    };
  }

  if (name === "internet.usage") {
    return {};
  }

  if (name === "evidence.extract") {
    const {
      text: _text,
      content: _content,
      claim: _claim,
      sourceId: _sourceId,
      source: _source,
      maxItems: _maxItems,
      limit: _limit,
    } = input;
    const text = firstDefinedString(
      normalizeOptionalRawString(_text),
      normalizeOptionalRawString(_content),
    );
    const sourceId = firstDefinedString(
      normalizeOptionalString(_sourceId),
      normalizeOptionalString(_source),
    );
    const maxItems = firstDefinedInteger(
      normalizeOptionalInteger(_maxItems),
      normalizeOptionalInteger(_limit),
    );
    return {
      ...(text !== undefined ? { text } : {}),
      ...(normalizeOptionalString(_claim) !== undefined
        ? { claim: normalizeOptionalString(_claim) }
        : {}),
      ...(sourceId !== undefined ? { sourceId } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
    };
  }

  if (name === "fs.list") {
    const { recursive: _recursive, maxDepth: _maxDepth, includeHidden: _includeHidden } = input;
    return {
      path: normalizeFilesystemPathField(input, {
        aliases: ["filePath", "targetPath"],
      }),
      ...(normalizeOptionalBoolean(_recursive) !== undefined
        ? { recursive: normalizeOptionalBoolean(_recursive) }
        : {}),
      ...(normalizeOptionalInteger(_maxDepth) !== undefined
        ? { maxDepth: normalizeOptionalInteger(_maxDepth) }
        : {}),
      ...(normalizeOptionalBoolean(_includeHidden) !== undefined
        ? { includeHidden: normalizeOptionalBoolean(_includeHidden) }
        : {}),
    };
  }

  if (name === "fs.read_text") {
    const {
      maxBytes: _maxBytes,
      offsetBytes: _offsetBytes,
      expectedRevision: _expectedRevision,
    } = input;
    return {
      path: normalizeFilesystemPathField(input, {
        aliases: ["filePath", "targetPath"],
      }),
      ...(normalizeOptionalInteger(_maxBytes) !== undefined
        ? { maxBytes: normalizeOptionalInteger(_maxBytes) }
        : {}),
      ...(normalizeOptionalInteger(_offsetBytes) !== undefined
        ? { offsetBytes: normalizeOptionalInteger(_offsetBytes) }
        : {}),
      ...(normalizeOptionalString(_expectedRevision) !== undefined
        ? { expectedRevision: normalizeOptionalString(_expectedRevision) }
        : {}),
    };
  }

  if (name === "fs.verify_json") {
    const {
      arrayPath: _arrayPath,
      minLength: _minLength,
      requiredStringFields: _requiredStringFields,
      requiredAbsoluteUrlFields: _requiredAbsoluteUrlFields,
      forbiddenStringLiterals: _forbiddenStringLiterals,
      maxBytes: _maxBytes,
    } = input;
    return {
      path: normalizeFilesystemPathField(input, {
        aliases: ["filePath", "targetPath"],
      }),
      ...(normalizeOptionalString(_arrayPath) !== undefined
        ? { arrayPath: normalizeOptionalString(_arrayPath) }
        : {}),
      ...(normalizeOptionalInteger(_minLength) !== undefined
        ? { minLength: normalizeOptionalInteger(_minLength) }
        : {}),
      ...(normalizeOptionalStringArray(_requiredStringFields) !== undefined
        ? { requiredStringFields: normalizeOptionalStringArray(_requiredStringFields) }
        : {}),
      ...(normalizeOptionalStringArray(_requiredAbsoluteUrlFields) !== undefined
        ? { requiredAbsoluteUrlFields: normalizeOptionalStringArray(_requiredAbsoluteUrlFields) }
        : {}),
      ...(normalizeOptionalStringArray(_forbiddenStringLiterals) !== undefined
        ? { forbiddenStringLiterals: normalizeOptionalStringArray(_forbiddenStringLiterals) }
        : {}),
      ...(normalizeOptionalInteger(_maxBytes) !== undefined
        ? { maxBytes: normalizeOptionalInteger(_maxBytes) }
        : {}),
    };
  }

  if (name === "fs.search_text") {
    const {
      glob: _glob,
      caseSensitive: _caseSensitive,
      maxResults: _maxResults,
      maxPreviewChars: _maxPreviewChars,
      maxTotalPreviewChars: _maxTotalPreviewChars,
    } = input;
    return {
      path: normalizeFilesystemPathField(input, {
        aliases: ["filePath", "targetPath"],
      }),
      ...(normalizeFilesystemField(input, {
        key: "query",
        aliases: ["pattern"],
      }) !== undefined
        ? {
            query: normalizeFilesystemField(input, {
              key: "query",
              aliases: ["pattern"],
            }),
          }
        : {}),
      ...(normalizeOptionalString(_glob) !== undefined
        ? { glob: normalizeOptionalString(_glob) }
        : {}),
      ...(normalizeOptionalBoolean(_caseSensitive) !== undefined
        ? { caseSensitive: normalizeOptionalBoolean(_caseSensitive) }
        : {}),
      ...(normalizeOptionalInteger(_maxResults) !== undefined
        ? { maxResults: normalizeOptionalInteger(_maxResults) }
        : {}),
      ...(normalizeOptionalInteger(_maxPreviewChars) !== undefined
        ? { maxPreviewChars: normalizeOptionalInteger(_maxPreviewChars) }
        : {}),
      ...(normalizeOptionalInteger(_maxTotalPreviewChars) !== undefined
        ? { maxTotalPreviewChars: normalizeOptionalInteger(_maxTotalPreviewChars) }
        : {}),
    };
  }

  if (name === "repo.trace") {
    const {
      seeds: _seeds,
      includeGlobs: _includeGlobs,
      excludeGlobs: _excludeGlobs,
      maxResults: _maxResults,
      contextLines: _contextLines,
    } = input;
    return {
      path: normalizeFilesystemPathField(input, {
        aliases: ["filePath", "targetPath"],
      }),
      ...(normalizeOptionalStringArray(_seeds) !== undefined
        ? { seeds: normalizeOptionalStringArray(_seeds) }
        : {}),
      ...(normalizeOptionalStringArray(_includeGlobs) !== undefined
        ? { includeGlobs: normalizeOptionalStringArray(_includeGlobs) }
        : {}),
      ...(normalizeOptionalStringArray(_excludeGlobs) !== undefined
        ? { excludeGlobs: normalizeOptionalStringArray(_excludeGlobs) }
        : {}),
      ...(normalizeOptionalInteger(_maxResults) !== undefined
        ? { maxResults: normalizeOptionalInteger(_maxResults) }
        : {}),
      ...(normalizeOptionalInteger(_contextLines) !== undefined
        ? { contextLines: normalizeOptionalInteger(_contextLines) }
        : {}),
    };
  }

  if (name === "fs.write_text") {
    const { mode: _mode, createParents: _createParents } = input;
    return {
      path: normalizeFilesystemPathField(input, {
        aliases: ["filePath", "targetPath"],
      }),
      ...(normalizeFilesystemRawField(input, {
        key: "content",
        aliases: ["text"],
      }) !== undefined
        ? {
            content: normalizeFilesystemRawField(input, {
              key: "content",
              aliases: ["text"],
            }),
          }
        : {}),
      ...(normalizeOptionalString(_mode) !== undefined
        ? { mode: normalizeOptionalString(_mode) }
        : {}),
      ...(normalizeOptionalBoolean(_createParents) !== undefined
        ? { createParents: normalizeOptionalBoolean(_createParents) }
        : {}),
    };
  }

  if (name === "fs.replace_text") {
    const { find: _find, replace: _replace, all: _all } = input;
    return {
      path: normalizeFilesystemPathField(input, {
        aliases: ["filePath", "targetPath"],
      }),
      ...(normalizeOptionalRawString(_find) !== undefined
        ? { find: normalizeOptionalRawString(_find) }
        : {}),
      ...(normalizeOptionalRawString(_replace) !== undefined
        ? { replace: normalizeOptionalRawString(_replace) }
        : {}),
      ...(normalizeOptionalBoolean(_all) !== undefined
        ? { all: normalizeOptionalBoolean(_all) }
        : {}),
    };
  }

  if (name === "fs.mkdir") {
    const { recursive: _recursive } = input;
    const path = normalizeFilesystemPathField(input, {
      aliases: ["filePath", "targetPath"],
      defaultToDot: false,
    });
    return {
      ...(path !== undefined ? { path } : {}),
      ...(normalizeOptionalBoolean(_recursive) !== undefined
        ? { recursive: normalizeOptionalBoolean(_recursive) }
        : {}),
    };
  }

  if (name === "fs.delete") {
    const { recursive: _recursive } = input;
    const path = normalizeFilesystemPathField(input, {
      aliases: ["filePath", "targetPath"],
      defaultToDot: false,
    });
    return {
      ...(path !== undefined ? { path } : {}),
      ...(normalizeOptionalBoolean(_recursive) !== undefined
        ? { recursive: normalizeOptionalBoolean(_recursive) }
        : {}),
    };
  }

  if (name === "fs.copy") {
    const { overwrite: _overwrite } = input;
    return {
      ...(normalizeFilesystemField(input, {
        key: "sourcePath",
        aliases: ["from"],
      }) !== undefined
        ? {
            sourcePath: normalizeFilesystemField(input, {
              key: "sourcePath",
              aliases: ["from"],
            }),
          }
        : {}),
      ...(normalizeFilesystemField(input, {
        key: "destinationPath",
        aliases: ["to"],
      }) !== undefined
        ? {
            destinationPath: normalizeFilesystemField(input, {
              key: "destinationPath",
              aliases: ["to"],
            }),
          }
        : {}),
      ...(normalizeOptionalBoolean(_overwrite) !== undefined
        ? { overwrite: normalizeOptionalBoolean(_overwrite) }
        : {}),
    };
  }

  if (name === "fs.move") {
    const { overwrite: _overwrite } = input;
    return {
      ...(normalizeFilesystemField(input, {
        key: "sourcePath",
        aliases: ["from"],
      }) !== undefined
        ? {
            sourcePath: normalizeFilesystemField(input, {
              key: "sourcePath",
              aliases: ["from"],
            }),
          }
        : {}),
      ...(normalizeFilesystemField(input, {
        key: "destinationPath",
        aliases: ["to"],
      }) !== undefined
        ? {
            destinationPath: normalizeFilesystemField(input, {
              key: "destinationPath",
              aliases: ["to"],
            }),
          }
        : {}),
      ...(normalizeOptionalBoolean(_overwrite) !== undefined
        ? { overwrite: normalizeOptionalBoolean(_overwrite) }
        : {}),
    };
  }

  if (name === "desktop.host.open") {
    return {
      ...(normalizeOptionalString(input.kind) !== undefined
        ? { kind: normalizeOptionalString(input.kind) }
        : {}),
      ...(normalizeOptionalString(input.application) !== undefined
        ? { application: normalizeOptionalString(input.application) }
        : {}),
      ...(normalizeOptionalString(input.path) !== undefined
        ? { path: normalizeOptionalString(input.path) }
        : {}),
      ...(normalizeOptionalString(input.url) !== undefined
        ? { url: normalizeOptionalString(input.url) }
        : {}),
    };
  }

  if (name === "dev.shell.run") {
    const resolvedPaths = resolveDevShellPaths(
      workspaceRoot,
      normalizeOptionalString(input.workspaceRoot),
      normalizeOptionalString(input.cwd),
    );
    return {
      ...(resolvedPaths.workspaceRoot !== undefined ? { workspaceRoot: resolvedPaths.workspaceRoot } : { workspaceRoot }),
      ...(normalizeDevShellExecCommand(input.command) !== undefined
        ? { command: normalizeDevShellExecCommand(input.command) }
        : {}),
      ...(normalizeOptionalString(input.cwd) !== undefined
        ? { cwd: resolvedPaths.cwd }
        : {}),
      ...(normalizeOptionalStringArray(input.requiredTools) !== undefined
        ? { requiredTools: normalizeOptionalStringArray(input.requiredTools) }
        : {}),
      ...(normalizeOptionalStringArray(input.envNames) !== undefined
        ? { envNames: normalizeOptionalStringArray(input.envNames) }
        : {}),
      ...(normalizeOptionalString(input.envMode) !== undefined
        ? { envMode: normalizeOptionalString(input.envMode) }
        : {}),
      ...(normalizeOptionalInteger(input.yieldTimeMs) !== undefined
        ? { yieldTimeMs: normalizeOptionalInteger(input.yieldTimeMs) }
        : {}),
      ...(normalizeOptionalInteger(input.timeoutMs) !== undefined
        ? { timeoutMs: normalizeOptionalInteger(input.timeoutMs) }
        : {}),
      ...(normalizeOptionalInteger(input.maxOutputBytes) !== undefined
        ? { maxOutputBytes: normalizeOptionalInteger(input.maxOutputBytes) }
        : {}),
    };
  }

  if (name === "dev.process.start") {
    const resolvedPaths = resolveDevShellPaths(
      workspaceRoot,
      normalizeOptionalString(input.workspaceRoot),
      normalizeOptionalString(input.cwd),
    );
    return {
      ...(resolvedPaths.workspaceRoot !== undefined ? { workspaceRoot: resolvedPaths.workspaceRoot } : { workspaceRoot }),
      ...(normalizeDevShellExecCommand(input.command) !== undefined
        ? { command: normalizeDevShellExecCommand(input.command) }
        : {}),
      ...(normalizeOptionalString(input.cwd) !== undefined
        ? { cwd: resolvedPaths.cwd }
        : {}),
      ...(normalizeOptionalStringArray(input.requiredTools) !== undefined
        ? { requiredTools: normalizeOptionalStringArray(input.requiredTools) }
        : {}),
      ...(normalizeOptionalStringArray(input.envNames) !== undefined
        ? { envNames: normalizeOptionalStringArray(input.envNames) }
        : {}),
      ...(normalizeOptionalString(input.envMode) !== undefined
        ? { envMode: normalizeOptionalString(input.envMode) }
        : {}),
      ...(normalizeOptionalInteger(input.yieldTimeMs) !== undefined
        ? { yieldTimeMs: normalizeOptionalInteger(input.yieldTimeMs) }
        : {}),
      ...(normalizeOptionalInteger(input.maxOutputBytes) !== undefined
        ? { maxOutputBytes: normalizeOptionalInteger(input.maxOutputBytes) }
        : {}),
    };
  }

  if (name === "exec_command") {
    const command = normalizeDevShellExecCommand(input.command);
    const sessionId = normalizeOptionalString(input.sessionId);
    if (command !== undefined) {
      return {
        command,
        ...(normalizeOptionalString(input.cwd) !== undefined
          ? { cwd: normalizeOptionalString(input.cwd) }
          : {}),
        ...(normalizeOptionalStringArray(input.requiredTools) !== undefined
          ? { requiredTools: normalizeOptionalStringArray(input.requiredTools) }
          : {}),
        ...(normalizeOptionalStringArray(input.envNames) !== undefined
          ? { envNames: normalizeOptionalStringArray(input.envNames) }
          : {}),
        ...(normalizeOptionalString(input.envMode) !== undefined
          ? { envMode: normalizeOptionalString(input.envMode) }
          : {}),
        ...(normalizeOptionalString(input.sourceMutation) !== undefined
          ? { sourceMutation: normalizeOptionalString(input.sourceMutation) }
          : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(typeof input.stdin === "string" ? { stdin: input.stdin } : {}),
        ...(input.stop === true ? { stop: true } : {}),
        ...(normalizeOptionalInteger(input.yieldTimeMs) !== undefined
          ? { yieldTimeMs: normalizeOptionalInteger(input.yieldTimeMs) }
          : {}),
        ...(normalizeOptionalInteger(input.timeoutMs) !== undefined
          ? { timeoutMs: normalizeOptionalInteger(input.timeoutMs) }
          : {}),
        ...(normalizeOptionalInteger(input.maxOutputBytes) !== undefined
          ? { maxOutputBytes: normalizeOptionalInteger(input.maxOutputBytes) }
          : {}),
      };
    }
    return {
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(typeof input.stdin === "string" ? { stdin: input.stdin } : {}),
      ...(input.stop === true ? { stop: true } : {}),
      ...(normalizeOptionalInteger(input.yieldTimeMs) !== undefined
        ? { yieldTimeMs: normalizeOptionalInteger(input.yieldTimeMs) }
        : {}),
      ...(normalizeOptionalInteger(input.maxOutputBytes) !== undefined
        ? { maxOutputBytes: normalizeOptionalInteger(input.maxOutputBytes) }
        : {}),
    };
  }

  if (name === "dev.process.write") {
    return {
      ...(normalizeOptionalString(input.processId) !== undefined
        ? { processId: normalizeOptionalString(input.processId) }
        : {}),
      ...(typeof input.data === "string" ? { data: input.data } : {}),
    };
  }

  if (name === "dev.process.write_and_read") {
    return {
      ...(normalizeOptionalString(input.processId) !== undefined
        ? { processId: normalizeOptionalString(input.processId) }
        : {}),
      ...(typeof input.data === "string" ? { data: input.data } : {}),
      ...(normalizeOptionalInteger(input.cursor) !== undefined
        ? { cursor: normalizeOptionalInteger(input.cursor) }
        : {}),
      ...(normalizeOptionalInteger(input.waitMs) !== undefined
        ? { waitMs: normalizeOptionalInteger(input.waitMs) }
        : {}),
      ...(normalizeOptionalInteger(input.maxBytes) !== undefined
        ? { maxBytes: normalizeOptionalInteger(input.maxBytes) }
        : {}),
    };
  }

  if (name === "dev.process.read") {
    return {
      ...(normalizeOptionalString(input.processId) !== undefined
        ? { processId: normalizeOptionalString(input.processId) }
        : {}),
      ...(normalizeOptionalInteger(input.cursor) !== undefined
        ? { cursor: normalizeOptionalInteger(input.cursor) }
        : {}),
      ...(normalizeOptionalInteger(input.waitMs) !== undefined
        ? { waitMs: normalizeOptionalInteger(input.waitMs) }
        : {}),
      ...(normalizeOptionalInteger(input.maxBytes) !== undefined
        ? { maxBytes: normalizeOptionalInteger(input.maxBytes) }
        : {}),
    };
  }

  if (name === "dev.process.stop") {
    return {
      ...(normalizeOptionalString(input.processId) !== undefined
        ? { processId: normalizeOptionalString(input.processId) }
        : {}),
      ...(normalizeOptionalString(input.signal) !== undefined
        ? { signal: normalizeOptionalString(input.signal) }
        : {}),
      ...(normalizeOptionalInteger(input.cursor) !== undefined
        ? { cursor: normalizeOptionalInteger(input.cursor) }
        : {}),
      ...(normalizeOptionalInteger(input.waitMs) !== undefined
        ? { waitMs: normalizeOptionalInteger(input.waitMs) }
          : {}),
      ...(normalizeOptionalInteger(input.maxBytes) !== undefined
        ? { maxBytes: normalizeOptionalInteger(input.maxBytes) }
        : {}),
    };
  }

  return input;
}

export function sanitizeToolInputForSchema(
  schema: Record<string, unknown>,
  input: unknown,
): unknown {
  return sanitizeSchemaValue(schema, input);
}

function normalizeCodeExecuteFiles(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    return [value];
  }
  return ;
}

function normalizeCodeExecuteStringArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return ;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalRawString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return ;
}

function firstDefinedInteger(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => value !== undefined);
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return ;
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized : [];
  }
  if (typeof value === "string") {
    const normalized = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized : [];
  }
  return ;
}

function resolveDevShellPaths(
  contextWorkspaceRoot: string,
  requestedWorkspaceRoot: string | undefined,
  requestedCwd: string | undefined,
): { workspaceRoot: string; cwd: string } {
  const isDefaultContextRoot = contextWorkspaceRoot === ".";
  const normalizedContextWorkspaceRoot = resolve(contextWorkspaceRoot);
  const normalizedRequestedWorkspaceRoot = resolve(
    normalizedContextWorkspaceRoot,
    requestedWorkspaceRoot ?? contextWorkspaceRoot,
  );
  const workspaceRoot = isPathWithinWorkspace(normalizedContextWorkspaceRoot, normalizedRequestedWorkspaceRoot)
    ? normalizedRequestedWorkspaceRoot
    : normalizedContextWorkspaceRoot;
  const resolvedWorkspaceRoot = isDefaultContextRoot && requestedWorkspaceRoot === undefined
    ? contextWorkspaceRoot
    : workspaceRoot;

  const requestedNormalizedCwd = requestedCwd ?? ".";
  const requestedResolvedCwd = resolve(workspaceRoot, requestedNormalizedCwd);
  const resolvedCwd = isPathWithinWorkspace(workspaceRoot, requestedResolvedCwd)
    ? requestedResolvedCwd
    : workspaceRoot;
  const cwd = isDefaultContextRoot && requestedCwd !== undefined && resolvedCwd !== workspaceRoot
    ? requestedNormalizedCwd
    : resolvedCwd;

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    cwd,
  };
}

function isPathWithinWorkspace(workspaceRoot: string, target: string): boolean {
  if (workspaceRoot === sep) {
    return true;
  }
  const normalizedRoot = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  return target === workspaceRoot || target.startsWith(normalizedRoot);
}

function normalizeFilesystemPathField(
  input: Record<string, unknown>,
  options: {
    aliases: string[];
    defaultToDot?: boolean;
  },
): string | undefined {
  return normalizeFilesystemField(input, {
    key: "path",
    aliases: options.aliases,
  }) ?? (options.defaultToDot === false ? undefined : ".");
}

function normalizeFilesystemField(
  input: Record<string, unknown>,
  options: {
    key: string;
    aliases: string[];
  },
): string | undefined {
  const direct = normalizeOptionalString(input[options.key]);
  if (direct !== undefined) {
    return direct;
  }
  for (const alias of options.aliases) {
    const normalized = normalizeOptionalString(input[alias]);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return ;
}

function normalizeFilesystemRawField(
  input: Record<string, unknown>,
  options: {
    key: string;
    aliases: string[];
  },
): string | undefined {
  const direct = normalizeOptionalRawString(input[options.key]);
  if (direct !== undefined) {
    return direct;
  }
  for (const alias of options.aliases) {
    const normalized = normalizeOptionalRawString(input[alias]);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return ;
}

function firstDefinedString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function normalizeIncludeAnswer(value: unknown): boolean | "basic" | "advanced" | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "basic" || value === "advanced") {
    return value;
  }
  return ;
}

function normalizeIncludeRawContent(value: unknown): false | "markdown" | "text" | undefined {
  if (value === true) {
    return "markdown";
  }
  if (value === false || value === "markdown" || value === "text") {
    return value;
  }
  return ;
}

function normalizeCrawlMapInput(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(normalizeOptionalString(input.url) !== undefined ? { url: normalizeOptionalString(input.url) } : {}),
    ...(normalizeOptionalString(input.instructions) !== undefined ? { instructions: normalizeOptionalString(input.instructions) } : {}),
    ...(normalizeOptionalInteger(input.maxDepth) !== undefined ? { maxDepth: normalizeOptionalInteger(input.maxDepth) } : {}),
    ...(normalizeOptionalInteger(input.maxBreadth) !== undefined ? { maxBreadth: normalizeOptionalInteger(input.maxBreadth) } : {}),
    ...(normalizeOptionalInteger(input.limit) !== undefined ? { limit: normalizeOptionalInteger(input.limit) } : {}),
    ...(normalizeOptionalStringArray(input.selectPaths) !== undefined ? { selectPaths: normalizeOptionalStringArray(input.selectPaths) } : {}),
    ...(normalizeOptionalStringArray(input.selectDomains) !== undefined ? { selectDomains: normalizeOptionalStringArray(input.selectDomains) } : {}),
    ...(normalizeOptionalStringArray(input.excludePaths) !== undefined ? { excludePaths: normalizeOptionalStringArray(input.excludePaths) } : {}),
    ...(normalizeOptionalStringArray(input.excludeDomains) !== undefined ? { excludeDomains: normalizeOptionalStringArray(input.excludeDomains) } : {}),
    ...(normalizeOptionalBoolean(input.allowExternal) !== undefined ? { allowExternal: normalizeOptionalBoolean(input.allowExternal) } : {}),
    ...(normalizeOptionalBoolean(input.includeUsage) !== undefined ? { includeUsage: normalizeOptionalBoolean(input.includeUsage) } : {}),
  };
}

function sanitizeSchemaValue(schema: unknown, value: unknown): unknown {
  const schemaRecord = asRecord(schema);
  if (schemaRecord === undefined) {
    return value;
  }

  if (schemaRecord.type === "array") {
    if (Array.isArray(value) === false) {
      return value;
    }
    return value.map((item) => sanitizeSchemaValue(schemaRecord.items, item));
  }

  if (schemaRecord.type !== "object") {
    return value;
  }

  const valueRecord = asRecord(value);
  const properties = asRecord(schemaRecord.properties);
  if (
    valueRecord === undefined ||
    properties === undefined ||
    schemaRecord.additionalProperties !== false
  ) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(valueRecord, key) === false) {
      continue;
    }
    sanitized[key] = sanitizeSchemaValue(propertySchema, valueRecord[key]);
  }
  return sanitized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
