export type MountaintopEngine = "cli" | "web";

export type MountaintopRunStatus = "passed" | "failed" | "infra_failed" | "build_failed";
export type MountaintopPromptEnvelope = "benchmark" | "operator";
export type MountaintopCompletionMode = "marker" | "runtime_finalize";
export type MountaintopWorkspacePrecondition = "package_json" | "none";
export type MountaintopSimulatedUserMode = "explicit_waits";
export type MountaintopFailureBucket = "harness" | "agent_runtime" | "product_output";

export interface MountaintopPromptStep {
  id: string;
  label: string;
  instruction: string;
}

export interface MountaintopQualityGate {
  id: string;
  label: string;
  command: string;
  args: string[];
  required: boolean;
}

export interface MountaintopSmokeRoute {
  path: string;
  contains: string[];
}

export interface MountaintopRequiredArtifactAlternative {
  paths: string[];
}

export interface MountaintopJsonArrayArtifactRequirement {
  paths: string[];
  arrayPath: string;
  minLength: number;
  requiredStringFields?: string[];
  requiredAbsoluteUrlFields?: string[];
  forbiddenStringLiterals?: string[];
}

export interface MountaintopToolEvidenceRequirement {
  tools: string[];
  minSuccessfulCalls?: number;
}

export interface MountaintopScenario {
  id: string;
  title: string;
  description: string;
  supportedEngines?: MountaintopEngine[];
  promptEnvelope?: MountaintopPromptEnvelope;
  operatorPrompt?: string | undefined;
  provider: {
    profileId: string;
    provider: "openrouter";
    model: string;
  };
  setupCommands: string[];
  promptProgram: MountaintopPromptStep[];
  simulatedUser?: {
    mode: MountaintopSimulatedUserMode;
    maxTurns: number;
  } | undefined;
  requiredArtifacts: string[];
  requiredArtifactAlternatives?: MountaintopRequiredArtifactAlternative[];
  requiredJsonArrayArtifacts?: MountaintopJsonArrayArtifactRequirement[];
  requiredToolEvidence?: MountaintopToolEvidenceRequirement[];
  qualityGates: MountaintopQualityGate[];
  smokeRoutes: MountaintopSmokeRoute[];
  workspacePrecondition?: MountaintopWorkspacePrecondition;
  completionMode?: MountaintopCompletionMode;
  completionMarker?: string;
  completionTimeoutSeconds: number;
}

export interface MountaintopEngineResult {
  engine: MountaintopEngine;
  status: MountaintopRunStatus;
  failureBucket?: MountaintopFailureBucket | undefined;
  failureBucketDiagnostics: string[];
  durationMs: number;
  workspacePath: string;
  transcriptPath: string;
  diagnostics: string[];
  completionDetected: boolean;
  qualityGateResults: Array<{
    id: string;
    label: string;
    required: boolean;
    status: MountaintopRunStatus;
    durationMs: number;
    outputPath: string;
    diagnostics: string[];
  }>;
  artifactChecks: Array<{
    path: string;
    exists: boolean;
    diagnostics?: string[];
  }>;
  toolEvidence: {
    successfulCalls: Array<{
      toolName: string;
      count: number;
    }>;
    failedCalls: Array<{
      toolName: string;
      count: number;
    }>;
    checks: Array<{
      tools: string[];
      minSuccessfulCalls: number;
      matchedSuccessfulCalls: number;
      satisfied: boolean;
      diagnostics: string[];
    }>;
    diagnostics: string[];
  };
  modelEvidence: {
    requestedProvider: string;
    requestedModel: string;
    observedProviders: string[];
    observedModels: string[];
    diagnostics: string[];
  };
  smokeChecks: Array<{
    route: string;
    status: MountaintopRunStatus;
    diagnostics: string[];
  }>;
}

export interface MountaintopReport {
  scenarioId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: MountaintopRunStatus;
  logsDir: string;
  engines: MountaintopEngineResult[];
  parityChecks: Array<{
    id: string;
    status: MountaintopRunStatus;
    diagnostics: string[];
  }>;
}
