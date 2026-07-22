import type { ModelToolSpec } from "../src/kestrel/contracts/model-io.js";
import { RUNNER_BUILT_IN_TOOL_NAMES } from "@kestrel-agents/protocol";

import {
  isApprovalCapabilityClass,
  isInteractionMode,
} from "../src/mode/contracts.js";
import type {
  SharedToolContext,
  ToolCapabilityMetadata,
  SharedToolDefinition,
  SharedToolHandler,
  SharedToolModule,
  ToolCatalog,
} from "./contracts.js";
import { createRuntimeFailure } from "../src/runtime/RuntimeFailure.js";
import { resolveToolPresentationMetadata } from "./toolMetadata.js";
import { runAgentTool } from "./toolResult.js";
import { exchangeRateTool } from "./free/exchangeRate.js";
import { geocodeLookupTool } from "./free/geocodeLookup.js";
import { hnTopTool } from "./free/hnTop.js";
import { timeCurrentTool } from "./free/timeCurrent.js";
import { weatherCurrentTool } from "./free/weatherCurrent.js";
import { weatherForecastTool } from "./free/weatherForecast.js";
import { fsCopyTool } from "./filesystem/copy.js";
import { fsDeleteTool } from "./filesystem/delete.js";
import { fsListTool } from "./filesystem/list.js";
import { fsMkdirTool } from "./filesystem/mkdir.js";
import { fsMoveTool } from "./filesystem/move.js";
import { fsReadTextTool } from "./filesystem/readText.js";
import { fsCreateTextTool } from "./filesystem/createText.js";
import { fsEditTextTool } from "./filesystem/editText.js";
import { fsApplyPatchTool } from "./filesystem/applyPatch.js";
import { fsReplaceTextTool } from "./filesystem/replaceText.js";
import { fsSearchTextTool } from "./filesystem/searchText.js";
import { fsVerifyJsonTool } from "./filesystem/verifyJson.js";
import { fsWriteTextTool } from "./filesystem/writeText.js";
import { repoTraceTool } from "./repo/trace.js";
import { evidenceExtractTool } from "./research/evidenceExtract.js";
import { codeExecuteTool } from "./code/execute.js";
import { devProcessReadTool } from "./devshell/processRead.js";
import { devProcessStartTool } from "./devshell/processStart.js";
import { devProcessStopTool } from "./devshell/processStop.js";
import { devProcessWriteAndReadTool } from "./devshell/processWriteAndRead.js";
import { devProcessWriteTool } from "./devshell/processWrite.js";
import { devShellRunTool } from "./devshell/run.js";
import { execCommandTool } from "./devshell/execCommand.js";
import { desktopHostOpenTool } from "./desktop/hostOpen.js";
import { effectResultLookupTool } from "./runtime/effectResultLookup.js";
import { finalizeAnswerTool } from "./runtime/finalizeAnswer.js";
import { planningWriteDocumentTool } from "./runtime/planningWriteDocument.js";
import { artifactReadTool } from "./runtime/artifactRead.js";
import { agentSpawnTool } from "./runtime/agentSpawn.js";
import { dialogOpenTool } from "./runtime/dialogOpen.js";
import { dialogSendTool } from "./runtime/dialogSend.js";
import { dialogCloseTool } from "./runtime/dialogClose.js";
import { delegateSpawnChildTool } from "./runtime/delegateSpawnChild.js";
import { delegateListChildrenTool } from "./runtime/delegateListChildren.js";
import { delegateGetChildResultTool } from "./runtime/delegateGetChildResult.js";
import { projectTaskProposeTool } from "./project/taskPropose.js";
import { internetCrawlTool } from "./internet/crawl.js";
import { internetExtractTool } from "./internet/extract.js";
import { internetImagesTool } from "./internet/images.js";
import { internetMapTool } from "./internet/map.js";
import { internetNewsTool } from "./internet/news.js";
import { internetResearchTool } from "./internet/research.js";
import { internetResearchStatusTool } from "./internet/researchStatus.js";
import { internetSearchTool } from "./internet/search.js";
import { internetSearchAdvancedTool } from "./internet/searchAdvanced.js";
import { internetUsageTool } from "./internet/usage.js";
import { kestrelOneSearchKnowledgeDocumentsTool } from "./kestrelOne/searchKnowledgeDocuments.js";
import {
  kestrelOneGitHubIssueCreateTool,
  kestrelOneGitHubPullRequestCreateTool,
  kestrelOneGitHubPullRequestMergeTool,
  kestrelOneGitHubReleaseCreateTool,
  kestrelOneGitHubRepositoryReadTool,
  kestrelOneGitHubWorkflowDispatchTool,
} from "./kestrelOne/githubActions.js";
import { kestrelOneGitHubPushAgentBranchTool } from "./kestrelOne/githubPushAgentBranch.js";
import { workspacePreviewTools } from "./kestrelOne/workspacePreviews.js";
import {
  kestrelOneGoogleCalendarCheckAvailabilityTool,
  kestrelOneGoogleCalendarCreateEventTool,
  kestrelOneGoogleCalendarDeleteEventTool,
  kestrelOneGoogleCalendarListAvailabilitySubjectsTool,
  kestrelOneGoogleCalendarListEventsTool,
  kestrelOneGoogleCalendarUpdateEventTool,
} from "./kestrelOne/google-calendar.js";
import { kestrelOneEmailSendTool } from "./kestrelOne/email.js";

const DEFAULT_MODULES: SharedToolModule[] = [
  weatherCurrentTool,
  weatherForecastTool,
  timeCurrentTool,
  geocodeLookupTool,
  exchangeRateTool,
  hnTopTool,
  internetSearchTool,
  internetSearchAdvancedTool,
  internetNewsTool,
  internetImagesTool,
  internetExtractTool,
  internetCrawlTool,
  internetMapTool,
  internetResearchTool,
  internetResearchStatusTool,
  internetUsageTool,
  evidenceExtractTool,
  fsListTool,
  fsReadTextTool,
  fsCreateTextTool,
  fsEditTextTool,
  fsApplyPatchTool,
  fsVerifyJsonTool,
  fsSearchTextTool,
  repoTraceTool,
  fsWriteTextTool,
  fsReplaceTextTool,
  fsMkdirTool,
  fsCopyTool,
  fsMoveTool,
  fsDeleteTool,
  codeExecuteTool,
  execCommandTool,
  desktopHostOpenTool,
  devShellRunTool,
  devProcessStartTool,
  devProcessWriteTool,
  devProcessWriteAndReadTool,
  devProcessReadTool,
  devProcessStopTool,
  effectResultLookupTool,
  artifactReadTool,
  finalizeAnswerTool,
  planningWriteDocumentTool,
  agentSpawnTool,
  dialogOpenTool,
  dialogSendTool,
  dialogCloseTool,
  delegateSpawnChildTool,
  delegateListChildrenTool,
  delegateGetChildResultTool,
  projectTaskProposeTool,
  kestrelOneSearchKnowledgeDocumentsTool,
  kestrelOneGitHubRepositoryReadTool,
  kestrelOneGitHubPushAgentBranchTool,
  ...workspacePreviewTools,
  kestrelOneGitHubIssueCreateTool,
  kestrelOneGitHubPullRequestCreateTool,
  kestrelOneGitHubPullRequestMergeTool,
  kestrelOneGitHubReleaseCreateTool,
  kestrelOneGitHubWorkflowDispatchTool,
  kestrelOneGoogleCalendarListEventsTool,
  kestrelOneGoogleCalendarCreateEventTool,
  kestrelOneGoogleCalendarUpdateEventTool,
  kestrelOneGoogleCalendarDeleteEventTool,
  kestrelOneGoogleCalendarListAvailabilitySubjectsTool,
  kestrelOneGoogleCalendarCheckAvailabilityTool,
  kestrelOneEmailSendTool,
];

export const BALANCED_STARTER_TOOL_NAMES = [
  ...RUNNER_BUILT_IN_TOOL_NAMES,
  "internet.search",
  "internet.search_advanced",
  "internet.news",
  "internet.images",
  "internet.extract",
  "internet.crawl",
  "internet.map",
  "internet.research",
  "internet.research_status",
  "evidence.extract",
  "effect_result_lookup",
  "planning.write_document",
  "task.propose",
  "FinalizeAnswer",
] as const;

export function createToolCatalog(modules: SharedToolModule[] = DEFAULT_MODULES): ToolCatalog {
  const map = new Map<string, SharedToolModule>();

  for (const module of modules) {
    if (map.has(module.definition.name)) {
      throw createToolCatalogError(
        "TOOL_DUPLICATE_DEFINITION",
        `Duplicate shared tool definition '${module.definition.name}'.`,
        {
          toolName: module.definition.name,
          contractPath: "definition.name",
          classification: "configuration",
          recoverable: false,
        },
      );
    }

    validateToolDefinition(module.definition);

    map.set(module.definition.name, module);
  }

  const list = (): SharedToolDefinition[] =>
    [...map.values()].map((module) => ({
      ...module.definition,
    }));

  const toModelTools = (names: string[]): ModelToolSpec[] =>
    names.map((name) => {
      const module = map.get(name);
      if (module === undefined) {
        throw createUnknownToolError(name, "modelTools");
      }

      return {
        name: module.definition.name,
        description: module.definition.description,
        inputSchema: module.definition.inputSchema,
        ...(module.definition.outputContract !== undefined
          ? { outputContract: module.definition.outputContract }
          : {}),
      };
    });

  const toCapabilityManifest = (
    names: string[],
  ): Array<
    ToolCapabilityMetadata & {
      name: string;
      description: string;
      displayName: string;
      aliases: string[];
      keywords: string[];
      provider: string;
      toolFamily: string;
    }
  > =>
    names.map((name) => {
      const module = map.get(name);
      if (module === undefined) {
        throw createUnknownToolError(name, "capabilityManifest");
      }

      const presentation = resolveToolPresentationMetadata({
        name: module.definition.name,
        presentation: module.definition.presentation,
      });
      const capability = module.definition.capability;
      return {
        name: module.definition.name,
        description: module.definition.description,
        freshnessClass: capability.freshnessClass,
        latencyClass: capability.latencyClass,
        costClass: capability.costClass,
        executionClass: capability.executionClass,
        ...(capability.allowedInteractionModes !== undefined
          ? { allowedInteractionModes: [...capability.allowedInteractionModes] }
          : {}),
        capabilityClasses: [...capability.capabilityClasses],
        ...(capability.approvalCapabilities !== undefined
          ? { approvalCapabilities: [...capability.approvalCapabilities] }
          : {}),
        requires: capability.requires ?? [],
        ...(capability.suitability !== undefined
          ? {
              suitability: {
                ...capability.suitability,
                ...(Array.isArray(capability.suitability.typicalFailureModes)
                  ? {
                      typicalFailureModes: [...capability.suitability.typicalFailureModes],
                    }
                  : {}),
              },
            }
          : {}),
        displayName: presentation.displayName,
        aliases: [...presentation.aliases],
        keywords: [...presentation.keywords],
        provider: presentation.provider,
        toolFamily: presentation.toolFamily,
      };
    });

  const createHandlers = (names: string[], context: SharedToolContext): Record<string, SharedToolHandler> => {
    const handlers: Record<string, SharedToolHandler> = {};

    for (const name of names) {
      const module = map.get(name);
      if (module === undefined) {
        throw createUnknownToolError(name, "handlers");
      }

      const rawHandler = module.createHandler(context);
      handlers[name] = (input: unknown) =>
        runAgentTool({
          toolName: name,
          toolInput: input,
          handler: rawHandler,
        });
    }

    return handlers;
  };

  return {
    list,
    toModelTools,
    toCapabilityManifest,
    createHandlers,
  };
}

export const defaultToolCatalog = createToolCatalog();

function validateToolDefinition(definition: SharedToolDefinition): void {
  validateCapabilityMetadata(definition.name, definition.capability);
  resolveToolPresentationMetadata({
    name: definition.name,
    presentation: definition.presentation,
  });
}

function validateCapabilityMetadata(name: string, capability: ToolCapabilityMetadata): void {
  if (typeof capability.executionClass !== "string" || capability.executionClass.trim().length === 0) {
    throw createToolCatalogError(
      "TOOL_CAPABILITY_METADATA_INVALID",
      `Tool '${name}' is missing capability.executionClass.`,
      {
        subsystem: "tooling",
        toolName: name,
        field: "executionClass",
        contractPath: "definition.capability.executionClass",
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  if (
    capability.allowedInteractionModes !== undefined &&
    (
      capability.allowedInteractionModes.length === 0 ||
      capability.allowedInteractionModes.some((item) => !isInteractionMode(item))
    )
  ) {
    throw createToolCatalogError(
      "TOOL_CAPABILITY_METADATA_INVALID",
      `Tool '${name}' has invalid capability.allowedInteractionModes.`,
      {
        subsystem: "tooling",
        toolName: name,
        field: "allowedInteractionModes",
        contractPath: "definition.capability.allowedInteractionModes",
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  if (
    Array.isArray(capability.capabilityClasses) === false ||
    capability.capabilityClasses.length === 0 ||
    capability.capabilityClasses.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw createToolCatalogError(
      "TOOL_CAPABILITY_METADATA_INVALID",
      `Tool '${name}' is missing capability.capabilityClasses.`,
      {
        subsystem: "tooling",
        toolName: name,
        field: "capabilityClasses",
        contractPath: "definition.capability.capabilityClasses",
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  if (
    capability.approvalCapabilities !== undefined &&
    (
      Array.isArray(capability.approvalCapabilities) === false ||
      capability.approvalCapabilities.length === 0 ||
      capability.approvalCapabilities.some((item) => isApprovalCapabilityClass(item) === false)
    )
  ) {
    throw createToolCatalogError(
      "TOOL_CAPABILITY_METADATA_INVALID",
      `Tool '${name}' has invalid capability.approvalCapabilities.`,
      {
        subsystem: "tooling",
        toolName: name,
        field: "approvalCapabilities",
        contractPath: "definition.capability.approvalCapabilities",
        classification: "configuration",
        recoverable: false,
      },
    );
  }
}

function createToolCatalogError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return createRuntimeFailure(code, message, {
    subsystem: "tooling",
    ...(details ?? {}),
  });
}

function createUnknownToolError(name: string, surface: "modelTools" | "capabilityManifest" | "handlers") {
  return createToolCatalogError(
    "TOOL_LOOKUP_FAILED",
    `Unknown tool '${name}' requested for ${surface}.`,
    {
      toolName: name,
      surface,
      classification: "configuration",
      recoverable: false,
    },
  );
}
