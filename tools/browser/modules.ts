import {
  compileToolJsonSchemaV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import type { ToolExecutionClass } from "../../src/mode/contracts.js";
import {
  BROWSER_CONTRACT_VERSION,
  BROWSER_POLICY_RESOLUTION_VERSION,
  BROWSER_TOOL_NAMES,
  browserArtifactPresentation,
  browserFailure,
  isBrowserToolName,
  normalizeBrowserHostFailure,
  parseBrowserPolicyResolutionV1,
  requireBrowserServicePort,
  validateBrowserResultSemantics,
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
  const validateOutput = compileToolJsonSchemaV1(contract.outputSchema, {
    surface: "output",
  });
  const normalizeOutput = (output: unknown): unknown => {
    const normalized = validateBrowserResultSemantics(toolName, output);
    if (validateOutput(normalized) !== true) {
      throw browserFailure(
        "BROWSER_ENGINE_FAILURE",
        "The Browser engine returned an invalid result.",
        {
          recoverable: false,
          operation: toolName,
        },
      );
    }
    return normalized;
  };
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
        ...(contract.toolId === "browser.request_grant" ||
        contract.toolId === "browser.tabs"
          ? { inputDependentPreparation: true }
          : {}),
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
    ...(contract.toolId === "browser.request_grant"
      ? {
          async resolvePolicy(context, input) {
            const runtime = context.runtime;
            if (runtime === undefined) {
              throw browserFailure(
                "BROWSER_SERVICE_UNAVAILABLE",
                "Browser policy resolution requires a trusted runtime identity.",
                { recoverable: false, operation: contract.toolId },
              );
            }
            try {
              const resolution = parseBrowserPolicyResolutionV1(
                await requireBrowserServicePort(
                  context.browserService,
                ).resolvePolicy({
                  version: BROWSER_POLICY_RESOLUTION_VERSION,
                  runId: runtime.runId,
                  threadId: runtime.threadId ?? runtime.sessionId,
                  operation: contract.toolId,
                  effectiveInput: input,
                }),
              );
              return {
                decision: resolution.decision,
                policyRevision: resolution.policyRevision,
              };
            } catch (error) {
              throw normalizeBrowserHostFailure(error, {
                toolName: contract.toolId,
                dispatchAcknowledged: false,
                effectful: false,
              });
            }
          },
        }
      : {}),
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
        const effectful =
          resolveExactExecutionClass(contract, prepared.effectiveInput) ===
          "external_side_effect";
        let dispatchAcknowledged = false;
        try {
          const output = await requireBrowserServicePort(
            context.browserService,
          ).execute(prepared, {
            acknowledgeDispatch() {
              if (!effectful || dispatchAcknowledged) return;
              dispatchAcknowledged = true;
              context.acknowledgeExternalEffect?.();
            },
            async persistCompletedResult(rawOutput) {
              await context.persistCompletedCapabilityResult?.(
                normalizeOutput(rawOutput),
              );
            },
          });
          return normalizeOutput(output);
        } catch (error) {
          throw normalizeBrowserHostFailure(error, {
            toolName: contract.toolId,
            dispatchAcknowledged,
            effectful,
          });
        }
      };
    },
    normalizeResult(output) {
      const normalized = normalizeOutput(output);
      return {
        output: normalized,
        ...(browserArtifactPresentation(normalized) === undefined
          ? {}
          : { presentation: browserArtifactPresentation(normalized) }),
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
