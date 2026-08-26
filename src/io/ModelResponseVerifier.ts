import type { ValidateFunction } from "ajv";

import {
  type ModelProviderIdentityV1,
  type ModelRequestV2,
  type ModelResponseV2,
  parseModelResponseV2,
} from "../kestrel/contracts/model-registration.js";
import { compileToolJsonSchemaV1 } from "../kestrel/contracts/tool-contract.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

const validatorCache = new Map<string, ValidateFunction>();

/**
 * Verifies the proof that a V2 provider response makes before it crosses the
 * shared model gateway. Provider codecs own decoding and terminal-state
 * normalization; this layer owns the local schema and tool-contract proof.
 */
export function verifyModelResponseV2<TOutput>(
  request: ModelRequestV2,
  value: unknown,
): ModelResponseV2<TOutput> {
  const response = parseResponse<TOutput>(value);
  assertCompletedTerminal(request, response);
  verifyContinuation(request, response);

  const schemaHash = verifyStructuredOutput(request, response);
  const toolSurfaceHash = verifyToolCalls(request, response);
  const validation =
    schemaHash === undefined && toolSurfaceHash === undefined
      ? { state: "not_requested" as const }
      : {
          state: "passed" as const,
          ...(schemaHash !== undefined ? { schemaHash } : {}),
          ...(toolSurfaceHash !== undefined ? { toolSurfaceHash } : {}),
        };

  return parseModelResponseV2<TOutput>({
    ...response,
    validation,
  });
}

/**
 * Rejects opaque continuation that belongs to another configured provider
 * before it reaches that provider's request codec or transport.
 */
export function verifyModelRequestV2BeforeInvocation(
  request: ModelRequestV2,
  providerId: ModelProviderIdentityV1,
): void {
  for (const continuation of request.reasoning?.continuation ?? []) {
    if (continuation.provider !== providerId) {
      throw createRuntimeFailure(
        "MODEL_CONTINUATION_PROVIDER_MISMATCH",
        "Reasoning continuation does not belong to the configured provider.",
        { provider: providerId, continuationProvider: continuation.provider },
      );
    }
  }
}

function parseResponse<TOutput>(value: unknown): ModelResponseV2<TOutput> {
  try {
    return parseModelResponseV2<TOutput>(value);
  } catch {
    throw createRuntimeFailure(
      "MODEL_MALFORMED_RESPONSE",
      "Provider response did not satisfy the V2 model response contract.",
      malformedResponseDiagnostics(value),
    );
  }
}

function malformedResponseDiagnostics(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const provider = isRecord(value.provider) ? value.provider : undefined;
  const terminal = isRecord(value.terminal) ? value.terminal : undefined;

  return {
    ...(typeof provider?.requestId === "string"
      ? { requestId: provider.requestId }
      : {}),
    ...(typeof terminal?.providerTerminalEvent === "string"
      ? { providerTerminalEvent: terminal.providerTerminalEvent }
      : {}),
  };
}

function assertCompletedTerminal(
  request: ModelRequestV2,
  response: ModelResponseV2,
): void {
  if (response.terminal.state !== "completed") {
    const failure = {
      refused: ["MODEL_REFUSED", "Provider refused the model request."],
      incomplete: ["MODEL_INCOMPLETE_RESPONSE", "Provider response was incomplete."],
      truncated: ["MODEL_TRUNCATED_RESPONSE", "Provider response was truncated."],
      interrupted: ["MODEL_INTERRUPTED_RESPONSE", "Provider response was interrupted."],
      malformed: ["MODEL_MALFORMED_RESPONSE", "Provider response was malformed."],
    } as const;
    const [code, message] = failure[response.terminal.state];
    throw createRuntimeFailure(code, message, providerDiagnostics(response));
  }

  if (
    request.requirements.streaming.terminalBehavior === "required" &&
    response.terminal.providerTerminalEvent === undefined
  ) {
    throw proofFailure(
      "MODEL_STREAM_TERMINAL_EVIDENCE_MISSING",
      "Provider stream completed without required terminal evidence.",
      response,
    );
  }
}

function verifyContinuation(
  request: ModelRequestV2,
  response: ModelResponseV2,
): void {
  if (
    request.requirements.endpoint !== "any" &&
    response.provider.endpoint !== request.requirements.endpoint
  ) {
    throw proofFailure(
      "MODEL_ENDPOINT_MISMATCH",
      "Provider response endpoint did not match the requested contract.",
      response,
      { requiredEndpoint: request.requirements.endpoint },
    );
  }

  const requestContinuation = request.reasoning?.continuation ?? [];
  const responseContinuation = response.reasoning?.continuation ?? [];
  const allowedKinds = new Set(request.requirements.reasoning.continuationKinds);

  for (const continuation of [...requestContinuation, ...responseContinuation]) {
    if (continuation.provider !== response.provider.name) {
      throw proofFailure(
        "MODEL_CONTINUATION_PROVIDER_MISMATCH",
        "Reasoning continuation does not belong to the responding provider.",
        response,
      );
    }
    if (!allowedKinds.has(continuation.kind)) {
      throw proofFailure(
        "MODEL_CONTINUATION_KIND_UNSUPPORTED",
        "Provider returned a reasoning continuation outside the requested contract.",
        response,
        { continuationKind: continuation.kind },
      );
    }
  }
}

function verifyStructuredOutput(
  request: ModelRequestV2,
  response: ModelResponseV2,
): string | undefined {
  const requirement = request.requirements.output;
  if (requirement.kind === "text") return;

  if (response.output === undefined) {
    throw proofFailure(
      "MODEL_STRUCTURED_OUTPUT_MISSING",
      "Provider did not return the required structured output.",
      response,
    );
  }

  if (requirement.kind === "json_object" && !isRecord(response.output)) {
    throw proofFailure(
      "MODEL_OUTPUT_NOT_JSON_OBJECT",
      "Provider structured output must be a JSON object.",
      response,
    );
  }

  if (requirement.kind === "json_schema") {
    const validator = compileValidator(
      request.responseSchema,
      request.fingerprints.schema,
      "output",
      response,
    );
    if (!validator(response.output)) {
      throw proofFailure(
        "MODEL_OUTPUT_SCHEMA_INVALID",
        "Provider structured output did not match the requested schema.",
        response,
        validatorDiagnostics(validator),
      );
    }
  }

  return request.fingerprints.schema;
}

function verifyToolCalls(
  request: ModelRequestV2,
  response: ModelResponseV2,
): string | undefined {
  const tools = request.tools ?? [];
  const requirements = request.requirements.tools;
  const intents = response.toolIntents;
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  if (requirements.choice === "none" && intents.length > 0) {
    throw proofFailure(
      "MODEL_TOOL_CALL_UNEXPECTED",
      "Provider returned tool calls when tools were not allowed.",
      response,
    );
  }

  const callIds = new Set<string>();
  for (const intent of intents) {
    const tool = toolsByName.get(intent.name);
    if (tool === undefined) {
      throw proofFailure(
        "MODEL_TOOL_UNKNOWN",
        "Provider returned a tool call that was not exposed for this request.",
        response,
        { toolName: intent.name },
      );
    }
    if (intent.id === undefined) {
      throw proofFailure(
        "MODEL_TOOL_CALL_ID_MISSING",
        "Provider tool calls must include a unique call identity.",
        response,
        { toolName: intent.name },
      );
    }
    if (callIds.has(intent.id)) {
      throw proofFailure(
        "MODEL_TOOL_CALL_ID_DUPLICATE",
        "Provider tool call identities must be unique.",
        response,
        { toolName: intent.name },
      );
    }
    callIds.add(intent.id);

    const validator = compileValidator(
      tool.inputSchema,
      `input:${request.fingerprints.toolSurface}:${tool.name}`,
      "input",
      response,
      { toolName: intent.name },
    );
    if (!validator(intent.input)) {
      throw proofFailure(
        "MODEL_TOOL_ARGUMENTS_INVALID",
        "Provider tool arguments did not match the exposed tool schema.",
        response,
        { toolName: intent.name, ...validatorDiagnostics(validator) },
      );
    }
  }

  if (
    (requirements.choice === "required" || requirements.choice === "named") &&
    intents.length === 0
  ) {
    throw proofFailure(
      "MODEL_REQUIRED_TOOL_CALL_MISSING",
      "Provider did not return a required tool call.",
      response,
    );
  }
  if (
    requirements.choice === "named" &&
    !intents.some((intent) => intent.name === requirements.toolName)
  ) {
    throw proofFailure(
      "MODEL_NAMED_TOOL_CALL_MISSING",
      "Provider did not return the required named tool call.",
      response,
      { toolName: requirements.toolName },
    );
  }
  if (
    requirements.choice === "named" &&
    intents.some((intent) => intent.name !== requirements.toolName)
  ) {
    throw proofFailure(
      "MODEL_NAMED_TOOL_CALL_UNEXPECTED",
      "Provider returned a tool call outside the required named tool contract.",
      response,
      { toolName: requirements.toolName },
    );
  }
  if (requirements.parallelism === "forbidden" && intents.length > 1) {
    throw proofFailure(
      "MODEL_TOOL_PARALLELISM_FORBIDDEN",
      "Provider returned parallel tool calls when they were forbidden.",
      response,
    );
  }
  if (
    requirements.parallelism === "required" &&
    intents.length < 2
  ) {
    throw proofFailure(
      "MODEL_TOOL_PARALLELISM_REQUIRED",
      "Provider did not return the required parallel tool calls.",
      response,
    );
  }

  return tools.length > 0 ? request.fingerprints.toolSurface : undefined;
}

function compileValidator(
  schema: Record<string, unknown> | undefined,
  cacheKey: string,
  surface: "input" | "output",
  response: ModelResponseV2,
  details: Record<string, unknown> = {},
): ValidateFunction {
  if (schema === undefined) {
    throw proofFailure(
      "MODEL_RESPONSE_SCHEMA_MISSING",
      "A schema-validation request did not include its required schema.",
      response,
      details,
    );
  }
  const cached = validatorCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const compiled = compileToolJsonSchemaV1(schema, { surface });
    validatorCache.set(cacheKey, compiled);
    return compiled;
  } catch {
    throw proofFailure(
      surface === "input" ? "MODEL_TOOL_SCHEMA_INVALID" : "MODEL_RESPONSE_SCHEMA_INVALID",
      surface === "input"
        ? "The exposed tool schema could not be compiled for verification."
        : "The requested response schema could not be compiled for verification.",
      response,
      details,
    );
  }
}

function proofFailure(
  code: string,
  message: string,
  response: ModelResponseV2,
  details: Record<string, unknown> = {},
) {
  return createRuntimeFailure(code, message, {
    ...providerDiagnostics(response),
    ...details,
  });
}

function providerDiagnostics(response: ModelResponseV2): Record<string, unknown> {
  return {
    provider: response.provider.name,
    ...(response.provider.requestId !== undefined
      ? { requestId: response.provider.requestId }
      : {}),
    terminalState: response.terminal.state,
    ...(response.terminal.providerTerminalEvent !== undefined
      ? { providerTerminalEvent: response.terminal.providerTerminalEvent }
      : {}),
  };
}

function validatorDiagnostics(validator: ValidateFunction): Record<string, unknown> {
  const error = validator.errors?.[0];
  if (error === undefined) return {};
  return {
    ...(error.keyword !== undefined ? { keyword: error.keyword } : {}),
    ...(error.instancePath !== undefined ? { instancePath: error.instancePath } : {}),
    ...(error.schemaPath !== undefined ? { schemaPath: error.schemaPath } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
