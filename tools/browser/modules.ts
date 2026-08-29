import { hashCanonical } from "../../src/kestrel/contracts/tool-contract.js";
import type { ToolExecutionClass } from "../../src/mode/contracts.js";
import {
  BROWSER_CONTRACT_VERSION,
  BROWSER_TOOL_NAMES,
  browserArtifactPresentation,
  browserFailure,
  isBrowserToolName,
  requireBrowserServicePort,
  type BrowserToolName,
} from "../../src/browser/contracts.js";
import {
  getBrowserToolContract,
  type BrowserToolContractFixtureV1,
} from "../../src/browser/browserAppContract.fixture.js";
import type { SharedToolModule } from "../contracts.js";

const RESULT_NORMALIZER_ID = "kestrel.browser-contract:v1";

function resolveExactExecutionClass(
  contract: BrowserToolContractFixtureV1,
  input: Record<string, unknown>,
): ToolExecutionClass {
  if (contract.toolId === "browser.tabs" && input.operation === "list") {
    return "read_only";
  }
  return contract.executionClass;
}

function resolveExactEffects(
  contract: BrowserToolContractFixtureV1,
  input: Record<string, unknown>,
): readonly string[] {
  if (contract.toolId === "browser.tabs") {
    return input.operation === "switch"
      ? ["tab.switch"]
      : input.operation === "close"
        ? ["tab.close"]
        : [];
  }
  return contract.exactEffects;
}

function createBrowserToolModule(toolName: BrowserToolName): SharedToolModule {
  const contract = getBrowserToolContract(toolName);
  return {
    definition: {
      name: contract.toolId,
      description: contract.description,
      inputSchema: contract.inputSchema,
      runtimeOutputSchema: contract.outputSchema,
      resultNormalizerId: RESULT_NORMALIZER_ID,
      capability: {
        freshnessClass: "live",
        latencyClass:
          contract.toolId === "browser.snapshot" ||
          contract.toolId === "browser.inspect"
            ? "medium"
            : "high",
        costClass: "metered",
        executionClass: contract.executionClass,
        allowedInteractionModes: ["chat", "build"],
        capabilityClasses: ["browser.operate"],
        ...(contract.executionClass === "external_side_effect"
          ? {
              approvalCapabilities:
                contract.approval === "always_approval" ||
                contract.approval === "dynamic_personal_grant"
                  ? (["external.confirm"] as const)
                  : (["network.call"] as const),
            }
          : {}),
        ...(contract.approval === "always_approval"
          ? {
              minimumApprovalMode: "ask",
            }
          : {}),
        suitability: {
          supportsAttribution: true,
          supportsAggregation: false,
          typicalFailureModes: [...contract.failureCodes],
        },
      },
      presentation: {
        displayName: browserToolDisplayName(contract.toolId),
        aliases: [contract.toolId, browserToolDisplayName(contract.toolId)],
        keywords: ["browser", contract.toolId.slice("browser.".length)],
        provider: "kestrel-browser",
        toolFamily: "browser",
      },
    },
    resolveExecutionClass(input) {
      return resolveExactExecutionClass(contract, input);
    },
    prepareInputAdapter(input) {
      return {
        adapterId: RESULT_NORMALIZER_ID,
        metadata: {
          contractVersion: BROWSER_CONTRACT_VERSION,
          operation: contract.toolId,
          executionClass: resolveExactExecutionClass(contract, input),
          exactEffects: [...resolveExactEffects(contract, input)],
          approval: contract.approval,
        },
      };
    },
    createHandler(context, prepared) {
      return async (input: unknown) => {
        if (prepared === undefined) {
          throw browserFailure(
            "BROWSER_SERVICE_UNAVAILABLE",
            "Browser tools require a durable prepared invocation.",
            { recoverable: false, toolName: contract.toolId },
          );
        }
        if (
          prepared.activation.descriptor.toolId !== contract.toolId ||
          isBrowserToolName(prepared.activation.descriptor.toolId) === false
        ) {
          throw browserFailure(
            "BROWSER_SERVICE_UNAVAILABLE",
            "The prepared Browser operation does not match its pinned handler.",
            { recoverable: false, toolName: contract.toolId },
          );
        }
        if (hashCanonical(prepared.effectiveInput) !== hashCanonical(input)) {
          throw browserFailure(
            "BROWSER_SERVICE_UNAVAILABLE",
            "The Browser handler received input that differs from its durable prepared invocation.",
            { recoverable: false, toolName: contract.toolId },
          );
        }
        return await requireBrowserServicePort(context.browserService).execute(
          prepared,
        );
      };
    },
    normalizeResult(output) {
      return {
        output,
        ...(browserArtifactPresentation(output) === undefined
          ? {}
          : { presentation: browserArtifactPresentation(output) }),
      };
    },
  };
}

function browserToolDisplayName(toolName: BrowserToolName): string {
  const operation = toolName.slice("browser.".length);
  return `Browser ${operation
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")}`;
}

export const browserTools: readonly SharedToolModule[] = BROWSER_TOOL_NAMES.map(
  createBrowserToolModule,
);
