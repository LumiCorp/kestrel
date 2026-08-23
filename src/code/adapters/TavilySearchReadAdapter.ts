import {
  normalizeSandboxCapabilityProfileV2,
  normalizeSandboxCapabilitySelectionV2,
  TAVILY_SEARCH_CAPABILITY_ID,
  TAVILY_SEARCH_OPERATION,
  TAVILY_SEARCH_RESOURCE,
  type SandboxCapabilityProfileV2,
  type SandboxCapabilitySelectionV2,
  type TavilySearchAdapterResponseV1,
} from "../../kestrel/contracts/sandbox-capability.js";
import type { SandboxCapabilityAdapter } from "../SandboxCapabilityAdapterRegistry.js";

export class SandboxCapabilityAdapterFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SandboxCapabilityAdapterFailure";
  }
}

export const tavilySearchReadAdapter: SandboxCapabilityAdapter<
  SandboxCapabilityProfileV2,
  SandboxCapabilitySelectionV2 & { input: { query: string; maxResults?: number | undefined } },
  { query: string; maxResults: number },
  TavilySearchAdapterResponseV1
> = {
  capabilityId: TAVILY_SEARCH_CAPABILITY_ID,
  operation: TAVILY_SEARCH_OPERATION,
  resource: TAVILY_SEARCH_RESOURCE,
  credentialId: "tool.tavily.default",
  effectClass: "read_only",
  parseProfile(value) {
    const profile = normalizeSandboxCapabilityProfileV2(value);
    if (profile.capabilityId !== TAVILY_SEARCH_CAPABILITY_ID || profile.operation !== TAVILY_SEARCH_OPERATION || profile.resource !== TAVILY_SEARCH_RESOURCE || profile.effectClass !== "read_only") {
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_PROFILE_MISMATCH", "Tavily adapter profile does not match its exact registration");
    }
    const maxQueryChars = boundedAdapterInteger(profile.adapterConfig.maxQueryChars, 1, 400, "maxQueryChars");
    const maxResults = boundedAdapterInteger(profile.adapterConfig.maxResults, 1, 20, "maxResults");
    return { ...profile, adapterConfig: { maxQueryChars, maxResults } };
  },
  parseSelection(value) {
    const selection = normalizeSandboxCapabilitySelectionV2(value);
    if (selection.capabilityId !== TAVILY_SEARCH_CAPABILITY_ID || selection.operation !== TAVILY_SEARCH_OPERATION) {
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_SELECTION_MISMATCH", "Tavily adapter selection does not match its exact registration");
    }
    const keys = Object.keys(selection.input);
    if (keys.some((key) => key !== "query" && key !== "maxResults")) throw new SandboxCapabilityAdapterFailure("CAPABILITY_INPUT_INVALID", "Tavily adapter input contains an unknown field");
    if (typeof selection.input.query !== "string" || selection.input.query.trim().length === 0) throw new SandboxCapabilityAdapterFailure("CAPABILITY_INPUT_INVALID", "Tavily adapter query is required");
    const maxResults = selection.input.maxResults === undefined ? undefined : boundedAdapterInteger(selection.input.maxResults, 1, 20, "maxResults");
    return { ...selection, input: { query: selection.input.query, ...(maxResults === undefined ? {} : { maxResults }) } } as SandboxCapabilitySelectionV2 & { input: { query: string; maxResults?: number | undefined } };
  },
  canonicalInput(profile, selection) {
    const query = selection.input.query;
    const maxQueryChars = profile.adapterConfig.maxQueryChars as number;
    const profileMaxResults = profile.adapterConfig.maxResults as number;
    if (query.length > maxQueryChars) {
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_REQUEST_CEILING_EXCEEDED", "Sandbox Tavily query exceeds the profile ceiling");
    }
    const maxResults = selection.input.maxResults ?? Math.min(5, profileMaxResults);
    if (maxResults > profileMaxResults) {
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_REQUEST_CEILING_EXCEEDED", "Sandbox Tavily result request exceeds the profile ceiling");
    }
    return { query, maxResults };
  },
  destination() {
    return new URL(TAVILY_SEARCH_RESOURCE).hostname;
  },
  async invoke(input, context) {
    const deadlineSignal = AbortSignal.timeout(Math.min(context.timeoutMs, context.expiryMs));
    const signal = AbortSignal.any([context.signal, deadlineSignal]);
    let response: Response;
    try {
      response = await context.fetchImpl(TAVILY_SEARCH_RESOURCE, {
        method: "POST",
        redirect: "manual",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${context.credential}` },
        body: JSON.stringify({ query: input.query, max_results: input.maxResults }),
      });
    } catch (error) {
      if (deadlineSignal.aborted) {
        throw new SandboxCapabilityAdapterFailure("CAPABILITY_DEADLINE_EXCEEDED", "Sandbox capability adapter deadline expired");
      }
      if (context.signal.aborted) {
        throw new SandboxCapabilityAdapterFailure("CAPABILITY_CANCELLED", "Sandbox capability adapter invocation was cancelled");
      }
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_PROVIDER_FAILED", "Sandbox capability provider request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_REDIRECT_REJECTED", "Tavily adapter rejected a redirect response");
    }
    if (response.ok === false) {
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_PROVIDER_FAILED", `Tavily adapter failed with status ${response.status}`);
    }
    const text = await readBoundedResponseBody(response, context.maxResponseBytes, signal);
    let value: { results?: unknown };
    try {
      value = JSON.parse(text) as { results?: unknown };
    } catch {
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_RESPONSE_INVALID", "Tavily adapter returned an invalid response");
    }
    if (Array.isArray(value.results) === false) {
      throw new SandboxCapabilityAdapterFailure("CAPABILITY_RESPONSE_INVALID", "Tavily adapter returned an invalid response");
    }
    const results = value.results.slice(0, input.maxResults).map((item: unknown) => {
      const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
      const url = typeof record.url === "string" ? record.url : "";
      let parsed: URL;
      try { parsed = new URL(url); } catch {
        throw new SandboxCapabilityAdapterFailure("CAPABILITY_RESPONSE_INVALID", "Tavily adapter returned an unsafe result URL");
      }
      if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
        throw new SandboxCapabilityAdapterFailure("CAPABILITY_RESPONSE_INVALID", "Tavily adapter returned an unsafe result URL");
      }
      return { title: clipField(record.title, 300), url: parsed.toString(), content: clipField(record.content, 2_000) };
    });
    return { version: 1, results };
  },
};

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
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new SandboxCapabilityAdapterFailure("CAPABILITY_RESPONSE_CEILING_EXCEEDED", "Tavily adapter response exceeds the profile ceiling");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clipField(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").slice(0, max);
}

function boundedAdapterInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new SandboxCapabilityAdapterFailure("CAPABILITY_PROFILE_INVALID", `Tavily adapter ${label} is outside its allowed range`);
  }
  return value as number;
}
