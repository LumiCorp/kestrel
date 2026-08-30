import path from "node:path";

import {
  compileToolJsonSchemaV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import {
  BROWSER_CONTRACT_VERSION,
  BROWSER_POLICY_RESOLUTION_VERSION,
  BROWSER_TOOL_NAMES,
  browserArtifactAuthorizationRequest,
  browserArtifactPresentation,
  browserFailure,
  canonicalizeBrowserArtifact,
  isBrowserToolName,
  normalizeBrowserHostFailure,
  parseBrowserAuthorizedArtifactV1,
  parseBrowserPolicyResolutionV1,
  requireBrowserServicePort,
  validateBrowserResultSemantics,
  validateBrowserResultAuthority,
  withoutBrowserArtifactPresentationUrl,
  type BrowserToolName,
  type BrowserHostExecutionAuthorityV1,
} from "../../src/browser/contracts.js";
import { DURABLE_EXTERNAL_EFFECT_DISPATCH_VERSION } from "../../src/io/ToolInvocationSupport.js";
import {
  getBrowserToolContract,
  resolveBrowserToolExecutionClass,
  type BrowserToolContractFixtureV1,
} from "../../src/browser/browserAppContract.fixture.js";
import { resolveWorkspaceAppCwd } from "../devshell/shared.js";
import type {
  RuntimeToolRunContext,
  SharedToolContext,
  SharedToolModule,
} from "../contracts.js";

const RESULT_NORMALIZER_ID = "kestrel.browser-contract:v1";

function resolveBrowserHostAuthority(
  context: SharedToolContext,
  runtime: RuntimeToolRunContext,
): BrowserHostExecutionAuthorityV1 {
  const workspaceRoot = context.fileSystem?.workspaceRoot;
  const appRoot = context.workspace?.appRoot;
  const projectRoot =
    workspaceRoot === undefined || appRoot === undefined
      ? undefined
      : resolveWorkspaceAppCwd(path.resolve(workspaceRoot), appRoot);
  return {
    threadId: runtime.threadId ?? runtime.sessionId,
    ...(runtime.projectId === undefined
      ? {}
      : { projectId: runtime.projectId }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
  };
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
    durableExternalEffectDispatch: {
      version: DURABLE_EXTERNAL_EFFECT_DISPATCH_VERSION,
      notStartedFailureCode: "BROWSER_ENGINE_FAILURE",
      notStartedMessage: "The Browser operation was not dispatched.",
      unknownOutcomeFailureCode: "BROWSER_ACTION_OUTCOME_UNKNOWN",
      unknownOutcomeMessage:
        "The Browser operation was dispatched, but its exact outcome could not be confirmed.",
    },
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
        contract.toolId === "browser.tabs" ||
        contract.approval === "always_approval"
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
      return resolveBrowserToolExecutionClass(contract.toolId, input);
    },
    prepareInputAdapter(input) {
      return {
        adapterId: RESULT_NORMALIZER_ID,
        metadata: {
          contractVersion: BROWSER_CONTRACT_VERSION,
          operation: contract.toolId,
          executionClass: resolveBrowserToolExecutionClass(
            contract.toolId,
            input,
          ),
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
                  authority: resolveBrowserHostAuthority(context, runtime),
                }),
              );
              if (
                contract.toolId === "browser.request_grant" &&
                resolution.decision === "approval_required" &&
                resolution.sessionMode !== "operator"
              ) {
                throw browserFailure(
                  "BROWSER_DESTINATION_BLOCKED",
                  "QA Browser Sessions cannot create personal public-domain grants.",
                  { recoverable: false, operation: contract.toolId },
                );
              }
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
          resolveBrowserToolExecutionClass(
            contract.toolId,
            prepared.effectiveInput,
          ) === "external_side_effect";
        const runtime = context.runtime;
        const threadId = runtime?.threadId ?? runtime?.sessionId;
        if (
          runtime === undefined ||
          threadId === undefined ||
          runtime.toolCallId === undefined
        ) {
          throw browserFailure(
            "BROWSER_SERVICE_UNAVAILABLE",
            "Browser tools require trusted execution authority.",
            { recoverable: false, toolName: contract.toolId },
          );
        }
        const executionAuthority = {
          runId: runtime.runId,
          sessionId: runtime.sessionId,
          threadId,
          callId: runtime.toolCallId,
          toolName: contract.toolId,
        } as const;
        const browserService = requireBrowserServicePort(
          context.browserService,
        );
        let acceptedRawCanonical: string | undefined;
        let acceptedCanonical: string | undefined;
        let acceptedOutput: unknown;
        const acceptOutput = async (rawOutput: unknown): Promise<unknown> => {
          const normalized = normalizeOutput(rawOutput);
          const rawCanonical = hashCanonical(normalized);
          if (acceptedRawCanonical === rawCanonical) {
            return acceptedOutput;
          }
          validateBrowserResultAuthority(
            prepared,
            normalized,
            executionAuthority,
          );
          const artifactRequest = browserArtifactAuthorizationRequest(
            executionAuthority,
            normalized,
          );
          let canonicalOutput = normalized;
          if (artifactRequest !== undefined) {
            const authorization =
              await browserService.authorizeArtifact(artifactRequest);
            if (authorization === undefined) {
              throw new Error(
                "Browser artifact is not authorized for this execution.",
              );
            }
            canonicalOutput = normalizeOutput(
              canonicalizeBrowserArtifact(
                normalized,
                parseBrowserAuthorizedArtifactV1(
                  authorization,
                  artifactRequest,
                ),
              ),
            );
          }
          const canonical = hashCanonical(canonicalOutput);
          if (acceptedCanonical !== undefined) {
            if (acceptedCanonical !== canonical) {
              throw new Error(
                "Browser host returned conflicting completed results.",
              );
            }
            return acceptedOutput;
          }
          acceptedRawCanonical = rawCanonical;
          acceptedCanonical = canonical;
          acceptedOutput = canonicalOutput;
          return acceptedOutput;
        };
        let dispatchAcknowledged = false;
        try {
          const output = await browserService.execute(prepared, {
            authority: resolveBrowserHostAuthority(context, runtime),
            async acknowledgeDispatch() {
              if (!effectful || dispatchAcknowledged) return;
              await context.acknowledgeExternalEffect?.();
              dispatchAcknowledged = true;
            },
            async persistCompletedResult(rawOutput) {
              const accepted = await acceptOutput(rawOutput);
              await context.persistCompletedCapabilityResult?.(accepted);
            },
          });
          const accepted = await acceptOutput(output);
          return accepted;
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
      const presentation = browserArtifactPresentation(normalized);
      return {
        output: withoutBrowserArtifactPresentationUrl(normalized),
        ...(presentation === undefined ? {} : { presentation }),
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
