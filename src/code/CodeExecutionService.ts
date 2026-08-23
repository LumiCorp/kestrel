import { randomUUID } from "node:crypto";
import type {
  CodeExecutionRequest,
  CodeExecutionResult,
  CodeModeProfileConfig,
  SandboxCapabilityGrant,
  SandboxCapabilityRuntimeContext,
  SandboxExecutionOutput,
  SandboxExecutor,
} from "./contracts.js";
import { DockerSandboxExecutor, DockerUnavailableError } from "./DockerSandboxExecutor.js";
import { evaluateExecutionPolicy } from "./PolicyEngine.js";
import {
  fingerprintSandboxCapabilityCatalogV1,
  parseSandboxCapabilityProfileV1,
  parseSandboxCapabilityProfilesV1,
  parseSandboxCapabilitySelectionV1,
  TAVILY_SEARCH_RESOURCE,
  type TavilySearchAdapterResponseV1,
} from "../kestrel/contracts/sandbox-capability.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY } from "../security/ExecutionBoundaryPolicy.js";

export interface CodeExecutionServiceOptions {
  executor?: SandboxExecutor | undefined;
}

export class CodeExecutionService {
  private readonly executor: SandboxExecutor;

  constructor(options: CodeExecutionServiceOptions = {}) {
    this.executor = options.executor ?? new DockerSandboxExecutor();
  }

  async execute(
    config: CodeModeProfileConfig | undefined,
    request: CodeExecutionRequest,
    options: {
      signal?: AbortSignal | undefined;
      capability?: SandboxCapabilityGrant | undefined;
      capabilityRuntime?: SandboxCapabilityRuntimeContext | undefined;
    } = {},
  ): Promise<CodeExecutionResult> {
    const policyDecision = evaluateExecutionPolicy(config, request);
    if (policyDecision.ok === false) {
      return policyDecision.result;
    }
    let capability = options.capability;
    let releaseCapabilitySensitiveValue: (() => void) | undefined;
    if (request.capability !== undefined) {
      const resolved = await resolveTavilyCapability(
        config,
        request.capability,
        options.capabilityRuntime,
      );
      capability = resolved.grant;
      releaseCapabilitySensitiveValue = resolved.releaseSensitiveValue;
    } else if (options.capability !== undefined) {
      throw new Error("Caller-authored sandbox capability grants are not accepted");
    }
    try {
      const output = await this.executor.execute({
        request: policyDecision.request,
        policy: policyDecision.policy,
        capability,
        signal: options.signal,
      });

      return {
        status: output.status,
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        durationMs: output.durationMs,
        artifacts: output.artifacts,
        summary: summarizeExecutionResult(output),
        policy: policyDecision.policy,
        retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
      };
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw error;
      }
      if (error instanceof DockerUnavailableError) {
        return {
          status: "runtime_unavailable",
          exitCode: null,
          stdout: "",
          stderr: error.message,
          durationMs: 0,
          artifacts: [],
          summary: "Code runtime unavailable: Docker is not installed or not reachable.",
          policy: policyDecision.policy,
          retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
        };
      }

      return {
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        artifacts: [],
        summary: "Code execution failed before completion due to an internal runtime error.",
        policy: policyDecision.policy,
        retention: config?.retention ?? { persistSummary: true, persistArtifacts: true },
      };
    } finally {
      releaseCapabilitySensitiveValue?.();
    }
  }
}

async function resolveTavilyCapability(
  config: CodeModeProfileConfig | undefined,
  selectedValue: unknown,
  runtime: SandboxCapabilityRuntimeContext | undefined,
): Promise<{
  grant: SandboxCapabilityGrant;
  releaseSensitiveValue?: (() => void) | undefined;
}> {
  const selected = parseSandboxCapabilitySelectionV1(selectedValue);
  const authoredProfiles = parseSandboxCapabilityProfilesV1(config?.capabilities ?? []);
  if (runtime !== undefined && runtime.capabilityCatalogFingerprint !== fingerprintSandboxCapabilityCatalogV1(authoredProfiles)) throw new Error("Sandbox capability catalog fingerprint is stale");
  const authored = authoredProfiles.find((item) => item.capabilityId === selected.capabilityId);
  if (authored === undefined) throw new Error("Selected sandbox capability is not authored by the resolved profile");
  const profile = parseSandboxCapabilityProfileV1(authored);
  if (runtime === undefined) throw new Error("Trusted sandbox capability runtime context is missing");
  if (runtime.tenantId !== profile.audience.tenantId || runtime.environmentId !== profile.audience.environmentId) throw new Error("Sandbox capability audience does not match the trusted runtime identity");
  if (runtime.brokerAuthority.authorityId !== profile.brokerAuthority.authorityId || runtime.brokerAuthority.revision !== profile.brokerAuthority.revision) throw new Error("Sandbox broker authority is stale or mismatched");
  if (/^[a-f0-9]{64}$/u.test(runtime.profileFingerprint) === false) throw new Error("Sandbox capability resolved-profile fingerprint is invalid");
  if (runtime.executionBoundaryRevision !== KESTREL_EXECUTION_BOUNDARY_POLICY.revision) throw new Error("Sandbox capability execution-boundary revision is stale");
  const credentialSnapshot = runtime.resolveCredentialSnapshot === undefined ? runtime.credentialSnapshot : await runtime.resolveCredentialSnapshot();
  if (credentialSnapshot === undefined) throw new Error("Authoritative Tavily credential snapshot is unavailable");
  for (const [label, value] of Object.entries({ sessionId: runtime.sessionId, runId: runtime.runId, toolCallId: runtime.toolCallId, executionBoundaryRevision: runtime.executionBoundaryRevision, credentialRevision: credentialSnapshot.revision })) {
    if (value.trim().length === 0) throw new Error(`Trusted sandbox capability ${label} is missing`);
  }
  if (credentialSnapshot.credentialId !== "tool.tavily.default" || credentialSnapshot.secret.trim().length === 0) throw new Error("Authoritative Tavily credential snapshot is unavailable");
  const query = selected.input.query;
  if (query.length > profile.maxQueryChars) throw new Error("Sandbox Tavily query exceeds the profile ceiling");
  const maxResults = selected.input.maxResults ?? Math.min(5, profile.maxResults);
  if (maxResults > profile.maxResults) throw new Error("Sandbox Tavily result request exceeds the profile ceiling");
  const now = (runtime.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + profile.maxExpiryMs);
  const grant: SandboxCapabilityGrant = {
    transport: "docker-shared-loopback-v1",
    lease: randomUUID(),
    operation: "search",
    destination: new URL(TAVILY_SEARCH_RESOURCE).hostname,
    response: undefined,
    expiresAt: expiresAt.toISOString(),
    maxRequests: 1,
    maxResponseBytes: profile.maxResponseBytes,
    authority: {
      version: 1,
      tenantId: runtime.tenantId,
      environmentId: runtime.environmentId,
      sessionId: runtime.sessionId,
      runId: runtime.runId,
      toolCallId: runtime.toolCallId,
      profileFingerprint: runtime.profileFingerprint,
      executionBoundaryRevision: runtime.executionBoundaryRevision,
      brokerAuthority: runtime.brokerAuthority,
      credentialReference: {
        credentialId: credentialSnapshot.credentialId,
        revision: credentialSnapshot.revision,
      },
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    expectedInput: { query, maxResults },
    adapter: async (adapterInput, signal) => {
      try {
        const remainingExpiryMs = expiresAt.getTime() - (runtime.now ?? (() => new Date()))().getTime();
        if (remainingExpiryMs <= 0) throw new Error("Tavily adapter capability expired before provider invocation");
        return await callExactTavilySearch({
          fetchImpl: runtime.fetchImpl ?? fetch,
          secret: credentialSnapshot.secret,
          query: adapterInput.query,
          maxResults: adapterInput.maxResults,
          timeoutMs: profile.timeoutMs,
          expiryMs: remainingExpiryMs,
          maxResponseBytes: profile.maxResponseBytes,
          signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.split(credentialSnapshot.secret).join("[redacted:credential]"));
      }
    },
  };
  const releaseSensitiveValue = runtime.registerSensitiveValue?.({
    referenceId: [
      "sandbox-capability",
      credentialSnapshot.credentialId,
      credentialSnapshot.revision,
      runtime.toolCallId,
    ].join(":"),
    value: credentialSnapshot.secret,
  });
  return {
    grant,
    ...(releaseSensitiveValue === undefined ? {} : { releaseSensitiveValue }),
  };
}

async function callExactTavilySearch(input: { fetchImpl: typeof fetch; secret: string; query: string; maxResults: number; timeoutMs: number; expiryMs: number; maxResponseBytes: number; signal: AbortSignal }): Promise<TavilySearchAdapterResponseV1> {
  const deadlineSignal = AbortSignal.timeout(Math.min(input.timeoutMs, input.expiryMs));
  const signal = AbortSignal.any([input.signal, deadlineSignal]);
  const response = await input.fetchImpl(TAVILY_SEARCH_RESOURCE, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${input.secret}` },
    body: JSON.stringify({ query: input.query, max_results: input.maxResults }),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("Tavily adapter rejected a redirect response");
  if (response.ok === false) throw new Error(`Tavily adapter failed with status ${response.status}`);
  const text = await readBoundedResponseBody(response, input.maxResponseBytes, signal);
  const value = JSON.parse(text) as { results?: unknown };
  if (Array.isArray(value.results) === false) throw new Error("Tavily adapter returned an invalid response");
  const results = value.results.slice(0, input.maxResults).map((item: unknown) => {
    const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const url = typeof record.url === "string" ? record.url : "";
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new Error("Tavily adapter returned an unsafe result URL");
    return { title: clipAdapterField(record.title, 300), url: parsed.toString(), content: clipAdapterField(record.content, 2_000) };
  });
  return { version: 1, results };
}

async function readBoundedResponseBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Tavily adapter response exceeds the profile ceiling");
        throw new Error("Tavily adapter response exceeds the profile ceiling");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function clipAdapterField(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function summarizeExecutionResult(output: SandboxExecutionOutput): string {
  if (output.status === "timeout") {
    return `Execution timed out after ${output.durationMs}ms.`;
  }

  const base =
    output.status === "ok"
      ? `Execution completed successfully in ${output.durationMs}ms.`
      : `Execution failed with exit code ${output.exitCode ?? "unknown"} in ${output.durationMs}ms.`;

  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();
  if (stdout.length === 0 && stderr.length === 0) {
    return `${base} No console output.`;
  }

  const snippets: string[] = [];
  if (stdout.length > 0) {
    snippets.push(`stdout: ${clip(stdout, 180)}`);
  }
  if (stderr.length > 0) {
    snippets.push(`stderr: ${clip(stderr, 180)}`);
  }

  return `${base} ${snippets.join(" ")}`;
}

function clip(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}
