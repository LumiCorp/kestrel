import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import type {
  ModelToolSpec,
  ToolGateway,
  ToolGatewayCallOptions,
  ToolGatewayPreRunContext,
  ToolRunContext,
  ToolRuntimeStatus,
} from "../../src/kestrel/contracts/model-io.js";
import type {
  McpServerConfig,
  McpStatusSnapshot,
} from "../../src/mcp/contracts.js";
import {
  parseHostedMcpContext,
  parseHostedMcpRuntimeConnection,
} from "../../src/mcp/hosted-contracts.js";
import { McpClientManager } from "../../src/mcp/McpClientManager.js";
import {
  createRuntimeFailure,
  RunCancelledError,
  RuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";
import { defaultToolCatalog } from "../catalog.js";
import type {
  RuntimeToolRunContext,
  SharedToolContext,
  ToolCapabilityMetadata,
  ToolRegistry,
  ToolRegistryListOptions,
} from "../contracts.js";
import { withDefaultFileSystemPolicy } from "../filesystem/shared.js";
import { createToolInputError } from "../helpers.js";
import {
  buildAgentToolFailureResult,
  buildAgentToolSuccessResult,
} from "../toolResult.js";
import { validateBuiltInToolInputContract } from "./builtInToolInputContracts.js";
import {
  normalizeToolActionInput,
  sanitizeToolInputForSchema,
} from "./normalizeToolInput.js";

type CapabilityManifestItem = ToolCapabilityMetadata & {
  name: string;
  description: string;
  displayName: string;
  aliases: string[];
  keywords: string[];
  provider: string;
  toolFamily: string;
};

export interface UnifiedToolRegistryOptions {
  allowlist: string[];
  context?: SharedToolContext | undefined;
  mcpServers?: McpServerConfig[] | undefined;
  mcpManager?: McpToolProvider | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface McpToolProvider {
  refresh(): Promise<McpStatusSnapshot>;
  assertHealthy(): Promise<void>;
  callTool<T>(namespacedToolName: string, input: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface HostedMcpRuntimeTurnInput {
  mcpContext?: unknown;
  mcpAuthorization?: unknown;
}

type HostedMcpScope = {
  manager: McpClientManager;
  snapshot: McpStatusSnapshot;
  executionTicket: string;
  lastUsedAt: number;
};

const MCP_DEFAULT_CAPABILITY: ToolCapabilityMetadata = {
  freshnessClass: "volatile",
  latencyClass: "medium",
  costClass: "metered",
  executionClass: "external_side_effect",
  capabilityClasses: [],
  approvalCapabilities: ["mcp.invoke"],
};

const MODEL_VISIBLE_RUNTIME_TOOL_NAMES = new Set(["agent.spawn"]);
const INTERNAL_ONLY_RUNTIME_TOOL_NAMES = new Set([
  "delegate.spawn_child",
  "delegate.list_children",
  "delegate.get_child_result",
]);

export class UnifiedToolRegistry implements ToolGateway, ToolRegistry {
  private readonly ajv = new Ajv({
    allErrors: true,
    strict: false,
  });
  private readonly builtInToolSpecs: Map<string, ModelToolSpec>;
  private readonly builtInCapabilities: Map<string, CapabilityManifestItem>;
  private readonly validatorCache = new Map<string, ValidateFunction>();
  private readonly builtInContext: SharedToolContext;
  private readonly mcpManager: McpToolProvider;
  private readonly hostedMcpScopes = new Map<string, HostedMcpScope>();

  private defaultAllowlist: Set<string>;
  private mcpStatus: McpStatusSnapshot = {
    healthy: true,
    checkedAt: new Date(0).toISOString(),
    servers: [],
    tools: [],
  };
  private initialized = false;

  constructor(options: UnifiedToolRegistryOptions) {
    this.defaultAllowlist = new Set(options.allowlist);
    this.builtInContext = withDefaultFileSystemPolicy(options.context);

    const builtInNames = defaultToolCatalog.list().map((tool) => tool.name);
    this.builtInToolSpecs = new Map(
      defaultToolCatalog
        .toModelTools(builtInNames)
        .map((tool) => [tool.name, tool] as const)
    );

    this.builtInCapabilities = new Map(
      defaultToolCatalog
        .toCapabilityManifest(builtInNames)
        .map((capability) => [capability.name, capability] as const)
    );

    if (options.mcpManager !== undefined) {
      this.mcpManager = options.mcpManager;
    } else {
      this.mcpManager = new McpClientManager({
        servers: options.mcpServers ?? [],
        env: options.env,
        fetchImpl: options.fetchImpl,
      });
    }
  }

  updateAllowlist(names: string[]): void {
    this.defaultAllowlist = new Set(names);
  }

  async refresh(): Promise<McpStatusSnapshot> {
    this.mcpStatus = await this.mcpManager.refresh();
    this.initialized = true;
    return this.getMcpStatus();
  }

  async refreshForRuntimeTurn(
    input: HostedMcpRuntimeTurnInput
  ): Promise<ToolRuntimeStatus> {
    if (this.initialized === false) {
      await this.refresh();
    }
    if (input.mcpContext === undefined) {
      return toToolRuntimeStatus(this.getMcpStatus());
    }
    const context = parseHostedMcpContext(input.mcpContext);
    const grantId = context.grantId;
    const existing = this.hostedMcpScopes.get(grantId);
    if (existing && input.mcpAuthorization === undefined) {
      existing.lastUsedAt = Date.now();
      return toToolRuntimeStatus(
        combineMcpSnapshots(this.mcpStatus, existing.snapshot)
      );
    }
    const connection = parseHostedMcpRuntimeConnection({
      mcpContext: context,
      mcpAuthorization: input.mcpAuthorization,
    });
    if (existing?.executionTicket === connection.executionTicket) {
      existing.lastUsedAt = Date.now();
      return toToolRuntimeStatus(
        combineMcpSnapshots(this.mcpStatus, existing.snapshot)
      );
    }
    const manager = new McpClientManager({
      servers: [],
      hostedGateway: connection,
    });
    const snapshot = await manager.refresh();
    this.assertHostedToolNamesSafe(snapshot);
    this.hostedMcpScopes.set(grantId, {
      manager,
      snapshot,
      executionTicket: connection.executionTicket,
      lastUsedAt: Date.now(),
    });
    await existing?.manager.close().catch(() => {});
    await this.pruneHostedMcpScopes(grantId);
    return toToolRuntimeStatus(combineMcpSnapshots(this.mcpStatus, snapshot));
  }

  resolveAvailableAllowlistForRuntimeTurn(
    names: string[],
    input: HostedMcpRuntimeTurnInput,
    options: { includeGrantedMcpTools: boolean }
  ): string[] {
    const snapshot = this.resolveMcpSnapshotFromTurnInput(input);
    const available = new Set(this.listAvailableToolNames(snapshot));
    const requested = options.includeGrantedMcpTools
      ? [...names, ...snapshot.tools.map((tool) => tool.namespacedToolName)]
      : names;
    return [...new Set(requested)].filter(
      (name) => available.has(name) || this.isRuntimeBuiltInToolName(name)
    );
  }

  async preRun(context: ToolGatewayPreRunContext): Promise<void> {
    if (this.initialized === false) {
      await this.refreshRuntime();
    }
    const payload = asRecord(context.event.payload);
    if (payload?.mcpContext !== undefined) {
      const turnInput = {
        mcpContext: payload.mcpContext,
      };
      await this.refreshForRuntimeTurn(turnInput);
      await this.resolveMcpManager({
        runId: context.runId,
        sessionId: context.session.sessionId,
        payload: context.event.payload,
        sessionState: context.session.state,
      }).assertHealthy();
    }
  }

  async getRuntimeStatus(): Promise<ToolRuntimeStatus> {
    if (this.initialized === false) {
      await this.refresh();
    }
    return toToolRuntimeStatus(this.getMcpStatus());
  }

  async refreshRuntime(): Promise<ToolRuntimeStatus> {
    const status = await this.refresh();
    return toToolRuntimeStatus(status);
  }

  async ensureReadyForRun(): Promise<void> {
    if (this.initialized === false) {
      await this.refreshRuntime();
    }
    await this.mcpManager.assertHealthy();
  }

  getModelTools(options: ToolRegistryListOptions = {}): ModelToolSpec[] {
    const tools: ModelToolSpec[] = [];
    const scopedContext = this.resolveScopedContext(options.runContext);
    const allowlist = scopedContext.allowlist;
    const activeBuiltInContext = scopedContext.builtInContext;
    const mcpStatus = this.resolveMcpSnapshot(options.runContext);

    for (const name of allowlist) {
      const builtIn = this.builtInToolSpecs.get(name);
      if (builtIn !== undefined) {
        if (
          isRuntimeBuiltInTool(name, this.builtInCapabilities) &&
          MODEL_VISIBLE_RUNTIME_TOOL_NAMES.has(name) === false
        ) {
          continue;
        }
        if (isBuiltInToolDisabledByContext(name, activeBuiltInContext)) {
          continue;
        }
        tools.push({
          ...builtIn,
        });
        continue;
      }

      const mcpTool = mcpStatus.tools.find(
        (tool) => tool.namespacedToolName === name
      );
      if (mcpTool === undefined || mcpTool.presentation === undefined) {
        continue;
      }
      tools.push({
        name: mcpTool.namespacedToolName,
        description: mcpTool.description,
        inputSchema: mcpTool.inputSchema,
      });
    }

    return tools;
  }

  getCapabilityManifest(
    options: ToolRegistryListOptions = {}
  ): CapabilityManifestItem[] {
    const manifest: CapabilityManifestItem[] = [];
    const scopedContext = this.resolveScopedContext(options.runContext);
    const allowlist = scopedContext.allowlist;
    const activeBuiltInContext = scopedContext.builtInContext;
    const mcpStatus = this.resolveMcpSnapshot(options.runContext);

    for (const name of allowlist) {
      const builtIn = this.builtInCapabilities.get(name);
      if (builtIn !== undefined) {
        if (
          builtIn.freshnessClass === "runtime" &&
          MODEL_VISIBLE_RUNTIME_TOOL_NAMES.has(name) === false
        ) {
          continue;
        }
        if (isBuiltInToolDisabledByContext(name, activeBuiltInContext)) {
          continue;
        }
        manifest.push({
          ...builtIn,
        });
        continue;
      }

      const mcpTool = mcpStatus.tools.find(
        (tool) => tool.namespacedToolName === name
      );
      if (mcpTool === undefined || mcpTool.presentation === undefined) {
        continue;
      }
      manifest.push({
        name: mcpTool.namespacedToolName,
        description: mcpTool.description,
        freshnessClass: MCP_DEFAULT_CAPABILITY.freshnessClass,
        latencyClass: MCP_DEFAULT_CAPABILITY.latencyClass,
        costClass: MCP_DEFAULT_CAPABILITY.costClass,
        executionClass: MCP_DEFAULT_CAPABILITY.executionClass,
        capabilityClasses: [...mcpTool.presentation.capabilityClasses],
        approvalCapabilities:
          mcpTool.presentation.approvalMode === "auto"
            ? []
            : [...(MCP_DEFAULT_CAPABILITY.approvalCapabilities ?? [])],
        displayName: mcpTool.presentation.displayName,
        aliases: [...mcpTool.presentation.aliases],
        keywords: [...mcpTool.presentation.keywords],
        provider: mcpTool.presentation.provider,
        toolFamily: mcpTool.presentation.toolFamily,
      });
    }

    return manifest;
  }

  getMcpStatus(): McpStatusSnapshot {
    const allowlist = this.defaultAllowlist;
    return {
      healthy: this.mcpStatus.healthy,
      checkedAt: this.mcpStatus.checkedAt,
      servers: this.mcpStatus.servers.map((server) => ({ ...server })),
      tools: this.mcpStatus.tools.map((tool) => ({
        ...tool,
        allowlisted: allowlist.has(tool.namespacedToolName),
      })),
    };
  }

  resolveAvailableAllowlist(names: string[]): string[] {
    const available = new Set(this.listAvailableToolNames(this.mcpStatus));
    return [...new Set(names)].filter(
      (name) => available.has(name) || this.isRuntimeBuiltInToolName(name)
    );
  }

  async validateInput(
    name: string,
    input: unknown,
    options: ToolGatewayCallOptions = {}
  ): Promise<unknown> {
    const scopedContext = this.resolveScopedContext(options.runContext);
    if (scopedContext.allowlist.has(name) === false) {
      throw createRuntimeFailure(
        "TOOL_LOOKUP_FAILED",
        `Tool '${name}' is not allowlisted.`,
        {
          subsystem: "tooling",
          toolName: name,
          classification: "configuration",
          recoverable: false,
        }
      );
    }
    if (INTERNAL_ONLY_RUNTIME_TOOL_NAMES.has(name)) {
      throw createRuntimeFailure(
        "TOOL_INTERNAL_ONLY",
        `Tool '${name}' is an internal-only runtime tool. Use 'agent.spawn' for model-facing delegation.`,
        {
          subsystem: "tooling",
          toolName: name,
          classification: "policy",
          recoverable: false,
        }
      );
    }
    if (
      this.builtInToolSpecs.has(name) &&
      isBuiltInToolDisabledByContext(name, scopedContext.builtInContext)
    ) {
      throw createRuntimeFailure(
        "TOOL_DISABLED_FOR_PROFILE",
        `Tool '${name}' is disabled for this profile.`,
        {
          subsystem: "tooling",
          toolName: name,
          classification: "policy",
          recoverable: true,
        }
      );
    }

    const recordInput = asRecord(input);
    const activeContext = scopedContext.builtInContext;
    const normalizedInput =
      recordInput !== undefined
        ? normalizeToolActionInput(
            name,
            recordInput,
            activeContext.fileSystem?.workspaceRoot
          )
        : input;
    const schema = this.resolveInputSchema(name, options.runContext);
    const schemaSanitizedInput = MODEL_VISIBLE_RUNTIME_TOOL_NAMES.has(name)
      ? normalizedInput
      : sanitizeToolInputForSchema(schema, normalizedInput);
    if (this.builtInToolSpecs.has(name)) {
      validateBuiltInToolInputContract(name, schemaSanitizedInput);
    }
    const validator = this.getValidator(name, schema);
    const valid = validator(schemaSanitizedInput);
    if (valid !== true) {
      if (this.builtInToolSpecs.has(name)) {
        throw createBuiltInSchemaValidationError(
          name,
          schemaSanitizedInput,
          validator.errors ?? []
        );
      }
      throw new RuntimeFailure(
        "TOOL_INPUT_SCHEMA_FAILED",
        `Tool '${name}' input failed schema validation.`,
        {
          toolName: name,
          validationErrors: (validator.errors ?? []).map((error) => ({
            instancePath: error.instancePath,
            schemaPath: error.schemaPath,
            keyword: error.keyword,
            message: error.message,
          })),
        }
      );
    }

    return schemaSanitizedInput;
  }

  async call(
    name: string,
    input: unknown,
    options: ToolGatewayCallOptions = {}
  ) {
    this.throwIfAborted(options.signal);
    const scopedContext = this.resolveScopedContext(options.runContext);
    const validatedInput = await this.validateInput(name, input, options);
    this.throwIfAborted(options.signal);

    if (this.builtInToolSpecs.has(name)) {
      if (isBuiltInToolDisabledByContext(name, scopedContext.builtInContext)) {
        throw createRuntimeFailure(
          "TOOL_DISABLED_FOR_PROFILE",
          `Tool '${name}' is disabled for this profile.`,
          {
            subsystem: "tooling",
            toolName: name,
            classification: "policy",
            recoverable: true,
          }
        );
      }

      const activeContext = scopedContext.builtInContext;
      const handlers = defaultToolCatalog.createHandlers(
        [name],
        options.console === undefined
          ? activeContext
          : {
              ...activeContext,
              toolConsole: options.console,
            }
      );
      const builtIn = handlers[name];

      if (builtIn === undefined) {
        throw createRuntimeFailure(
          "TOOL_LOOKUP_FAILED",
          `Tool '${name}' is not available.`,
          {
            subsystem: "tooling",
            toolName: name,
            classification: "configuration",
            recoverable: false,
          }
        );
      }

      const output = await builtIn(validatedInput);
      this.throwIfAborted(options.signal);
      return output;
    }

    const mcpTool = this.resolveExposedMcpTool(name, options.runContext);
    if (mcpTool !== undefined) {
      const startedAt = new Date().toISOString();
      try {
        const output = await this.resolveMcpManager(
          options.runContext
        ).callTool(name, validatedInput);
        this.throwIfAborted(options.signal);
        return buildAgentToolSuccessResult({
          toolName: name,
          input: validatedInput,
          output,
          startedAt,
        });
      } catch (error) {
        this.throwIfAborted(options.signal);
        if (error instanceof RunCancelledError) {
          throw error;
        }
        if (
          error instanceof RuntimeFailure &&
          error.details?.recoverable === false
        ) {
          throw error;
        }
        return buildAgentToolFailureResult({
          toolName: name,
          input: validatedInput,
          error,
          startedAt,
        });
      }
    }

    throw createRuntimeFailure(
      "TOOL_LOOKUP_FAILED",
      `Tool '${name}' is not available.`,
      {
        subsystem: "tooling",
        toolName: name,
        classification: "configuration",
        recoverable: false,
      }
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      this.mcpManager.close(),
      ...[...this.hostedMcpScopes.values()].map((scope) =>
        scope.manager.close()
      ),
    ]);
    this.hostedMcpScopes.clear();
  }

  private resolveInputSchema(
    name: string,
    runContext: ToolRunContext | undefined
  ): Record<string, unknown> {
    const builtIn = this.builtInToolSpecs.get(name);
    if (builtIn !== undefined) {
      return builtIn.inputSchema;
    }

    const mcpTool = this.resolveExposedMcpTool(name, runContext);
    if (mcpTool !== undefined) {
      return mcpTool.inputSchema;
    }

    throw createRuntimeFailure(
      "TOOL_LOOKUP_FAILED",
      `Tool '${name}' is not available.`,
      {
        subsystem: "tooling",
        toolName: name,
        classification: "configuration",
        recoverable: false,
      }
    );
  }

  private getValidator(
    name: string,
    schema: Record<string, unknown>
  ): ValidateFunction {
    const schemaKey = `${name}:${stringifySchema(schema)}`;
    const cached = this.validatorCache.get(schemaKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const compiled = this.ajv.compile(schema);
      this.validatorCache.set(schemaKey, compiled);
      return compiled;
    } catch (error) {
      throw new RuntimeFailure(
        "TOOL_INPUT_SCHEMA_FAILED",
        `Tool '${name}' schema could not be compiled for validation.`,
        {
          toolName: name,
          reason: toSchemaError(error).message,
        }
      );
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new RunCancelledError();
    }
  }

  private isRuntimeBuiltInToolName(name: string): boolean {
    if (this.builtInToolSpecs.has(name) === false) {
      return false;
    }
    return isRuntimeBuiltInTool(name, this.builtInCapabilities);
  }

  private listAvailableToolNames(mcpStatus: McpStatusSnapshot): string[] {
    const available = new Set<string>();
    for (const [name] of this.builtInToolSpecs) {
      if (
        isRuntimeBuiltInTool(name, this.builtInCapabilities) &&
        MODEL_VISIBLE_RUNTIME_TOOL_NAMES.has(name) === false
      ) {
        continue;
      }
      if (isBuiltInToolDisabledByContext(name, this.builtInContext)) {
        continue;
      }
      available.add(name);
    }
    for (const tool of mcpStatus.tools) {
      if (tool.presentation === undefined) {
        continue;
      }
      available.add(tool.namespacedToolName);
    }
    return [...available];
  }

  private resolveExposedMcpTool(
    name: string,
    runContext: ToolRunContext | undefined
  ) {
    const tool = this.resolveMcpSnapshot(runContext).tools.find(
      (candidate) => candidate.namespacedToolName === name
    );
    return tool?.presentation !== undefined ? tool : undefined;
  }

  private resolveMcpManager(
    runContext: ToolRunContext | undefined
  ): McpToolProvider {
    const grantId = readHostedMcpGrantId(runContext?.payload);
    if (!grantId) {
      return this.mcpManager;
    }
    const scope = this.hostedMcpScopes.get(grantId);
    if (!scope) {
      throw createRuntimeFailure(
        "MCP_HOSTED_SCOPE_UNAVAILABLE",
        "The hosted MCP grant is not connected for this run.",
        { grantId, recoverable: false }
      );
    }
    scope.lastUsedAt = Date.now();
    return scope.manager;
  }

  private resolveMcpSnapshot(
    runContext: ToolRunContext | undefined
  ): McpStatusSnapshot {
    const grantId = readHostedMcpGrantId(runContext?.payload);
    if (!grantId) {
      return this.mcpStatus;
    }
    const hosted = this.hostedMcpScopes.get(grantId)?.snapshot;
    return hosted
      ? combineMcpSnapshots(this.mcpStatus, hosted)
      : this.mcpStatus;
  }

  private resolveMcpSnapshotFromTurnInput(
    input: HostedMcpRuntimeTurnInput
  ): McpStatusSnapshot {
    if (input.mcpContext === undefined) {
      return this.mcpStatus;
    }
    const context = parseHostedMcpContext(input.mcpContext);
    const hosted = this.hostedMcpScopes.get(
      context.grantId
    )?.snapshot;
    return hosted
      ? combineMcpSnapshots(this.mcpStatus, hosted)
      : this.mcpStatus;
  }

  private async pruneHostedMcpScopes(activeGrantId: string): Promise<void> {
    const maximumScopes = 128;
    if (this.hostedMcpScopes.size <= maximumScopes) {
      return;
    }
    const stale = [...this.hostedMcpScopes.entries()]
      .filter(([grantId]) => grantId !== activeGrantId)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
      .slice(0, this.hostedMcpScopes.size - maximumScopes);
    await Promise.all(stale.map(([, scope]) => scope.manager.close()));
    for (const [grantId] of stale) {
      this.hostedMcpScopes.delete(grantId);
    }
  }

  private assertHostedToolNamesSafe(snapshot: McpStatusSnapshot): void {
    const staticNames = new Set(
      this.mcpStatus.tools.map((tool) => tool.namespacedToolName)
    );
    for (const tool of snapshot.tools) {
      if (
        this.builtInToolSpecs.has(tool.namespacedToolName) ||
        staticNames.has(tool.namespacedToolName)
      ) {
        throw createRuntimeFailure(
          "MCP_TOOL_NAME_COLLISION",
          `Hosted MCP tool '${tool.namespacedToolName}' conflicts with an existing runtime tool.`,
          { toolName: tool.namespacedToolName, recoverable: false }
        );
      }
    }
  }

  private resolveScopedContext(runContext: ToolRunContext | undefined): {
    allowlist: ReadonlySet<string>;
    builtInContext: SharedToolContext;
  } {
    if (runContext === undefined) {
      return {
        allowlist: this.defaultAllowlist,
        builtInContext: this.builtInContext,
      };
    }
    return resolveScopedRunContext(
      runContext.payload,
      this.defaultAllowlist,
      this.builtInContext,
      resolveRuntimeToolRunContext(
        runContext.runId,
        runContext.sessionId,
        runContext.payload
      ),
      hasTrustedManagedWorktreeBinding(
        runContext.runId,
        runContext.sessionState,
        runContext.payload,
        runContext.sessionId
      ),
      this.hostedMcpScopes.get(readHostedMcpGrantId(runContext.payload) ?? "")
        ?.executionTicket,
    );
  }
}

function createBuiltInSchemaValidationError(
  toolName: string,
  input: unknown,
  errors: ErrorObject[]
): RuntimeFailure {
  const firstError = errors[0];
  const field =
    firstError === undefined ? "input" : readAjvErrorField(firstError);
  const expected =
    firstError === undefined
      ? "input satisfying tool schema"
      : readAjvErrorExpectation(firstError);
  const invalidValues =
    firstError === undefined
      ? []
      : readAjvErrorInvalidValues(input, firstError);
  const location = field === "input" ? "input" : `input.${field}`;

  return createToolInputError(
    toolName,
    `Invalid ${toolName} ${location}. Expected ${expected}.`,
    {
      field,
      expected,
      ...(invalidValues.length > 0 ? { invalidValues } : {}),
      validationErrors: errors.map((error) => ({
        instancePath: error.instancePath,
        schemaPath: error.schemaPath,
        keyword: error.keyword,
        message: error.message,
      })),
    }
  );
}

function readAjvErrorField(error: ErrorObject): string {
  if (
    error.keyword === "required" &&
    typeof error.params.missingProperty === "string"
  ) {
    return error.params.missingProperty;
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
  ) {
    return error.params.additionalProperty;
  }
  return jsonPointerToField(error.instancePath);
}

function readAjvErrorExpectation(error: ErrorObject): string {
  switch (error.keyword) {
    case "minimum":
      return `value >= ${String(error.params.limit)}`;
    case "maximum":
      return `value <= ${String(error.params.limit)}`;
    case "minLength":
      return `string length >= ${String(error.params.limit)}`;
    case "maxLength":
      return `string length <= ${String(error.params.limit)}`;
    case "minItems":
      return `array length >= ${String(error.params.limit)}`;
    case "maxItems":
      return `array length <= ${String(error.params.limit)}`;
    case "enum":
      return Array.isArray(error.params.allowedValues)
        ? `one of ${error.params.allowedValues.map(String).join(", ")}`
        : "one of the allowed values";
    case "type":
      return typeof error.params.type === "string"
        ? `type ${error.params.type}`
        : "the expected JSON type";
    case "required":
      return "required field";
    case "additionalProperties":
      return "no unknown fields";
    default:
      return error.message ?? `input satisfying ${error.keyword}`;
  }
}

function readAjvErrorInvalidValues(
  input: unknown,
  error: ErrorObject
): unknown[] {
  if (error.keyword === "required") {
    return [];
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
  ) {
    const value = readFieldValue(input, error.params.additionalProperty);
    return value === undefined ? [] : [value];
  }
  const value = readValueAtJsonPointer(input, error.instancePath);
  return value === undefined ? [] : [value];
}

function jsonPointerToField(pointer: string): string {
  if (pointer.length === 0) {
    return "input";
  }
  return pointer.slice(1).split("/").map(decodeJsonPointerSegment).join(".");
}

function readValueAtJsonPointer(input: unknown, pointer: string): unknown {
  if (pointer.length === 0) {
    return input;
  }

  let current: unknown = input;
  for (const segment of pointer
    .slice(1)
    .split("/")
    .map(decodeJsonPointerSegment)) {
    if (typeof current !== "object" || current === null) {
      return;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (Number.isInteger(index) === false || index < 0) {
        return;
      }
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readFieldValue(input: unknown, field: string): unknown {
  return typeof input === "object" &&
    input !== null &&
    Array.isArray(input) === false
    ? (input as Record<string, unknown>)[field]
    : undefined;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveScopedRunContext(
  payload: unknown,
  fallback: ReadonlySet<string>,
  baseContext: SharedToolContext,
  runtime: RuntimeToolRunContext,
  trustedManagedWorktree: boolean,
  ephemeralExecutionTicket?: string | undefined,
): {
  allowlist: ReadonlySet<string>;
  builtInContext: SharedToolContext;
} {
  const orchestration = asRecord(asRecord(payload)?.orchestration);
  const runtimeAssembly = asRecord(orchestration?.runtimeAssembly);
  const toolAllowlist = Array.isArray(runtimeAssembly?.toolAllowlist)
    ? runtimeAssembly.toolAllowlist.filter(
        (value): value is string => typeof value === "string"
      )
    : undefined;
  const workspace = asRecord(asRecord(payload)?.workspace);
  const workspaceRoot =
    typeof workspace?.workspaceRoot === "string" &&
    workspace.workspaceRoot.trim().length > 0
      ? workspace.workspaceRoot
      : undefined;
  const workspaceToolContext = {
    ...(typeof workspace?.appRoot === "string" &&
    workspace.appRoot.trim().length > 0
      ? { appRoot: workspace.appRoot.trim() }
      : {}),
    ...(typeof workspace?.packageManager === "string" &&
    workspace.packageManager.trim().length > 0
      ? { packageManager: workspace.packageManager.trim() }
      : {}),
    ...(asRecord(workspace?.commands) !== undefined
      ? {
          commands: asRecord(workspace?.commands) as Record<
            string,
            string | undefined
          >,
        }
      : {}),
  };
  const tenantId = readKestrelOneTenantId(payload);
  const contextGrantId = readKestrelOneContextGrantId(payload);
  const executionTicket = ephemeralExecutionTicket;
  const interactionMode = readInteractionMode(payload);
  const devShellSourceWriteApprovalGrants =
    readDevShellSourceWriteApprovalGrants(payload);
  const sourceWriteAuthority = resolveDevShellSourceWriteAuthority(
    workspace,
    trustedManagedWorktree
  );
  const sourceWriteGuardAllowedWriteRoots =
    resolveDevShellSourceWriteAllowedWriteRoots(
      workspaceRoot,
      sourceWriteAuthority,
      trustedManagedWorktree
    );
  const scopedBaseContext: SharedToolContext = {
    ...baseContext,
    runtime,
    ...(interactionMode !== undefined ? { interactionMode } : {}),
    ...(tenantId !== undefined ||
    contextGrantId !== undefined ||
    executionTicket !== undefined
      ? {
          kestrelOne: {
            ...(baseContext.kestrelOne ?? {}),
            ...(tenantId !== undefined ? { tenantId } : {}),
            ...(contextGrantId !== undefined ? { contextGrantId } : {}),
            ...(executionTicket !== undefined ? { executionTicket } : {}),
          },
        }
      : {}),
    ...(Object.keys(workspaceToolContext).length > 0
      ? { workspace: workspaceToolContext }
      : {}),
    ...(devShellSourceWriteApprovalGrants.length > 0 ||
    trustedManagedWorktree ||
    sourceWriteAuthority !== undefined
      ? {
          devShell: {
            ...(baseContext.devShell ?? { enabled: false }),
            ...(sourceWriteAuthority !== undefined
              ? { sourceWriteAuthority }
              : {}),
            sourceWriteGuard: {
              ...(baseContext.devShell?.sourceWriteGuard ?? {}),
              ...(trustedManagedWorktree ? { managedWorktree: true } : {}),
              ...(sourceWriteGuardAllowedWriteRoots !== undefined
                ? { allowedWriteRoots: sourceWriteGuardAllowedWriteRoots }
                : {}),
              approvalGrants: [
                ...(baseContext.devShell?.sourceWriteGuard?.approvalGrants ??
                  []),
                ...devShellSourceWriteApprovalGrants,
              ],
            },
          },
        }
      : {}),
  };
  return {
    allowlist: toolAllowlist === undefined ? fallback : new Set(toolAllowlist),
    builtInContext:
      workspaceRoot === undefined
        ? scopedBaseContext
        : withDefaultFileSystemPolicy({
            ...scopedBaseContext,
            fileSystem: {
              workspaceRoot,
              tempRoots: scopedBaseContext.fileSystem?.tempRoots ?? [],
            },
          }),
  };
}

function readInteractionMode(
  payload: unknown
): "chat" | "plan" | "build" | undefined {
  const direct = asRecord(payload)?.interactionMode;
  if (direct === "chat" || direct === "plan" || direct === "build") {
    return direct;
  }
  const metadata = asRecord(asRecord(payload)?.metadata);
  const fromMetadata = metadata?.interactionMode;
  if (
    fromMetadata === "chat" ||
    fromMetadata === "plan" ||
    fromMetadata === "build"
  ) {
    return fromMetadata;
  }
  const orchestration = asRecord(asRecord(payload)?.orchestration);
  const fromOrchestration = orchestration?.interactionMode;
  return fromOrchestration === "chat" ||
    fromOrchestration === "plan" ||
    fromOrchestration === "build"
    ? fromOrchestration
    : undefined;
}

function resolveDevShellSourceWriteAuthority(
  workspace: Record<string, unknown> | undefined,
  trustedManagedWorktree: boolean
): "source_write" | undefined {
  if (trustedManagedWorktree) {
    return "source_write";
  }
  if (workspace?.managedWorktreeRequired === false) {
    return "source_write";
  }
  return;
}

function resolveDevShellSourceWriteAllowedWriteRoots(
  workspaceRoot: string | undefined,
  sourceWriteAuthority: "source_write" | undefined,
  trustedManagedWorktree: boolean
): string[] | undefined {
  if (
    sourceWriteAuthority !== "source_write" ||
    trustedManagedWorktree ||
    workspaceRoot === undefined
  ) {
    return;
  }
  return [workspaceRoot];
}

function resolveRuntimeToolRunContext(
  runId: string,
  sessionId: string,
  payload: unknown
): RuntimeToolRunContext {
  const payloadRecord = asRecord(payload);
  const orchestration = asRecord(payloadRecord?.orchestration);
  const metadata = asRecord(payloadRecord?.metadata);
  const threadId =
    asNonEmptyString(orchestration?.threadId) ??
    asNonEmptyString(metadata?.threadId);
  const activeTaskId =
    asNonEmptyString(orchestration?.activeTaskId) ??
    asNonEmptyString(orchestration?.taskId) ??
    asNonEmptyString(metadata?.activeTaskId) ??
    asNonEmptyString(metadata?.taskId);
  const delegationId =
    asNonEmptyString(orchestration?.delegationId) ??
    asNonEmptyString(metadata?.delegationId);
  const rootDelegationId =
    asNonEmptyString(orchestration?.rootDelegationId) ??
    asNonEmptyString(metadata?.rootDelegationId);
  const delegationDepth =
    asFiniteNumber(orchestration?.delegationDepth) ??
    asFiniteNumber(metadata?.delegationDepth);
  return {
    runId,
    sessionId,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(activeTaskId !== undefined ? { activeTaskId } : {}),
    ...(delegationId !== undefined ? { delegationId } : {}),
    ...(delegationDepth !== undefined ? { delegationDepth } : {}),
    ...(rootDelegationId !== undefined ? { rootDelegationId } : {}),
  };
}

function hasTrustedManagedWorktreeBinding(
  runId: string,
  state: unknown,
  payload: unknown,
  sessionId: string
): boolean {
  const stateRecord = asRecord(state);
  const binding =
    asRecord(
      asRecord(asRecord(stateRecord?.agent)?.exec)?.managedWorktreeBinding
    ) ??
    asRecord(
      asRecord(asRecord(stateRecord?.react)?.exec)?.managedWorktreeBinding
    );
  if (binding?.status !== "bound") {
    return false;
  }
  const bindingSessionId = asNonEmptyString(binding.sessionId);
  if (bindingSessionId !== undefined && bindingSessionId !== sessionId) {
    return false;
  }
  const bindingRunId = asNonEmptyString(binding.runId);
  if (bindingRunId !== undefined && bindingRunId !== runId) {
    return false;
  }
  const leaseId = asNonEmptyString(binding.leaseId);
  if (leaseId === undefined) {
    return false;
  }
  const workspace = asRecord(asRecord(payload)?.workspace);
  return (
    workspace?.managedWorktree === true &&
    asNonEmptyString(workspace.workspaceRoot) ===
      asNonEmptyString(binding.worktreeRoot) &&
    asNonEmptyString(workspace.leaseId) === leaseId
  );
}

function readDevShellSourceWriteApprovalGrants(payload: unknown) {
  const orchestration = asRecord(asRecord(payload)?.orchestration);
  const grants = Array.isArray(orchestration?.devShellSourceWriteApprovalGrants)
    ? orchestration.devShellSourceWriteApprovalGrants
    : [];
  return grants.flatMap((item) => {
    const record = asRecord(item);
    const grantId = asNonEmptyString(record?.grantId);
    const command = asNonEmptyString(record?.command);
    const writablePaths = Array.isArray(record?.writablePaths)
      ? record.writablePaths.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0
        )
      : [];
    if (
      grantId === undefined ||
      command === undefined ||
      writablePaths.length === 0
    ) {
      return [];
    }
    return [
      {
        grantId,
        command,
        writablePaths,
        ...(asNonEmptyString(record?.cwd) !== undefined
          ? { cwd: asNonEmptyString(record?.cwd) }
          : {}),
        ...(asNonEmptyString(record?.expiresAt) !== undefined
          ? { expiresAt: asNonEmptyString(record?.expiresAt) }
          : {}),
      },
    ];
  });
}

function readKestrelOneTenantId(payload: unknown): string | undefined {
  const clientCapabilities = asRecord(asRecord(payload)?.clientCapabilities);
  const kestrelOne = asRecord(clientCapabilities?.kestrelOne);
  return (
    asNonEmptyString(kestrelOne?.tenantId) ??
    asNonEmptyString(kestrelOne?.organizationId)
  );
}

function readKestrelOneContextGrantId(payload: unknown): string | undefined {
  const clientCapabilities = asRecord(asRecord(payload)?.clientCapabilities);
  const kestrelOne = asRecord(clientCapabilities?.kestrelOne);
  return asNonEmptyString(kestrelOne?.contextGrantId);
}

function readHostedMcpGrantId(payload: unknown): string | undefined {
  return asNonEmptyString(asRecord(asRecord(payload)?.mcpContext)?.grantId);
}

function combineMcpSnapshots(
  base: McpStatusSnapshot,
  hosted: McpStatusSnapshot
): McpStatusSnapshot {
  return {
    healthy: base.healthy && hosted.healthy,
    checkedAt:
      Date.parse(base.checkedAt) > Date.parse(hosted.checkedAt)
        ? base.checkedAt
        : hosted.checkedAt,
    servers: [
      ...base.servers.map((server) => ({ ...server })),
      ...hosted.servers.map((server) => ({ ...server })),
    ],
    tools: [
      ...base.tools.map((tool) => ({ ...tool })),
      ...hosted.tools.map((tool) => ({ ...tool })),
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringifySchema(schema: Record<string, unknown>): string {
  return JSON.stringify(schema);
}

function toSchemaError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRuntimeBuiltInTool(
  name: string,
  capabilities: Map<string, CapabilityManifestItem>
): boolean {
  const capability = capabilities.get(name);
  return capability?.freshnessClass === "runtime";
}

function isBuiltInToolDisabledByContext(
  name: string,
  context: SharedToolContext
): boolean {
  if (name === "code.execute") {
    return context.codeMode?.enabled !== true;
  }
  if (name.startsWith("dev.shell.")) {
    return context.devShell?.enabled !== true;
  }

  return false;
}

function toToolRuntimeStatus(status: McpStatusSnapshot): ToolRuntimeStatus {
  return {
    healthy: status.healthy,
    checkedAt: status.checkedAt,
    providers: {
      mcp: status,
    },
  };
}
