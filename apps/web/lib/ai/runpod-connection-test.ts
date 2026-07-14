export const RUNPOD_VALIDATION_METADATA_KEY = "kestrelRunPodValidation";
export const RUNPOD_VALIDATION_VERSION = "runpod-tool-round-trip-v2";

const PROBE_TOOL_NAME = "kestrel_connection_probe";
const MAX_VALIDATION_STREAM_BYTES = 1024 * 1024;

export type RunPodFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type RunPodValidationEvidence = {
  version: typeof RUNPOD_VALIDATION_VERSION;
  streaming: true;
  toolRoundTrip: true;
  rawModelId: string;
  baseUrl: string;
  validatedAt: string;
};

export class RunPodConnectionTestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    options?: { retryable?: boolean; status?: number }
  ) {
    super(message);
    this.name = "RunPodConnectionTestError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status ?? null;
  }
}

export function getRunPodValidationEvidence(
  metadata: unknown
): RunPodValidationEvidence | null {
  const root = asRecord(metadata);
  const evidence = asRecord(root?.[RUNPOD_VALIDATION_METADATA_KEY]);
  if (
    evidence?.version !== RUNPOD_VALIDATION_VERSION ||
    evidence.streaming !== true ||
    evidence.toolRoundTrip !== true ||
    typeof evidence.rawModelId !== "string" ||
    evidence.rawModelId.length === 0 ||
    typeof evidence.baseUrl !== "string" ||
    evidence.baseUrl.length === 0 ||
    typeof evidence.validatedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.validatedAt))
  ) {
    return null;
  }
  return evidence as unknown as RunPodValidationEvidence;
}

export function getMatchingRunPodValidationEvidence(input: {
  metadata: unknown;
  rawModelId: string;
  baseUrl: string;
}) {
  const evidence = getRunPodValidationEvidence(input.metadata);
  return evidence?.rawModelId === input.rawModelId &&
    evidence.baseUrl === input.baseUrl
    ? evidence
    : null;
}

export function mergeRunPodValidationEvidence(input: {
  metadata: unknown;
  evidence: RunPodValidationEvidence;
}) {
  return {
    ...asRecord(input.metadata),
    [RUNPOD_VALIDATION_METADATA_KEY]: input.evidence,
  } satisfies Record<string, unknown>;
}

export function preserveTrustedRunPodValidation(input: {
  incomingMetadata: unknown;
  storedMetadata: unknown;
  storedRawModelId: string;
  storedModality: string;
  nextRawModelId: string;
  nextModality: string;
  baseUrl: string;
}) {
  const incoming = { ...asRecord(input.incomingMetadata) };
  delete incoming[RUNPOD_VALIDATION_METADATA_KEY];
  const modelIdentityUnchanged =
    input.storedRawModelId === input.nextRawModelId &&
    input.storedModality === input.nextModality;
  const storedEvidence = modelIdentityUnchanged
    ? getMatchingRunPodValidationEvidence({
        metadata: input.storedMetadata,
        rawModelId: input.nextRawModelId,
        baseUrl: input.baseUrl,
      })
    : null;
  return storedEvidence
    ? {
        ...incoming,
        [RUNPOD_VALIDATION_METADATA_KEY]: storedEvidence,
      }
    : incoming;
}

export async function validateRunPodToolRoundTrip(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: RunPodFetch;
  now?: Date;
}): Promise<RunPodValidationEvidence> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = `kestrel-${crypto.randomUUID()}`;
  const endpoint = `${input.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json",
  };
  const tools = [
    {
      type: "function",
      function: {
        name: PROBE_TOOL_NAME,
        description: "Return a Kestrel connection-validation token.",
        strict: true,
        parameters: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
          additionalProperties: false,
        },
      },
    },
  ];

  const first = await postStreamingCompletion({
    endpoint,
    fetchImpl,
    headers,
    phase: "tool_call",
    body: {
      model: input.model,
      messages: [
        {
          role: "user",
          content: `Call ${PROBE_TOOL_NAME} exactly once with token ${token}. Do not answer directly.`,
        },
      ],
      tools,
      tool_choice: {
        type: "function",
        function: { name: PROBE_TOOL_NAME },
      },
      parallel_tool_calls: false,
      stream: true,
      max_tokens: 128,
    },
  });
  const toolCall = extractToolCall(first);
  if (toolCall.name !== PROBE_TOOL_NAME || toolCall.input.token !== token) {
    throw new RunPodConnectionTestError(
      "RUNPOD_TOOL_CALL_INVALID",
      "RunPod model did not return the required Kestrel tool call."
    );
  }

  const second = await postStreamingCompletion({
    endpoint,
    fetchImpl,
    headers,
    phase: "tool_result",
    body: {
      model: input.model,
      messages: [
        {
          role: "user",
          content: `Call ${PROBE_TOOL_NAME} exactly once with token ${token}. Do not answer directly.`,
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.input),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify({ token, status: "ok" }),
        },
        {
          role: "user",
          content: "Reply with the exact token returned by the tool.",
        },
      ],
      tools,
      tool_choice: "none",
      stream: true,
      max_tokens: 128,
    },
  });
  const finalText = extractText(second);
  if (!finalText.includes(token)) {
    throw new RunPodConnectionTestError(
      "RUNPOD_TOOL_RESULT_INVALID",
      "RunPod model did not consume the Kestrel tool result."
    );
  }

  return {
    version: RUNPOD_VALIDATION_VERSION,
    streaming: true,
    toolRoundTrip: true,
    rawModelId: input.model,
    baseUrl: input.baseUrl,
    validatedAt: (input.now ?? new Date()).toISOString(),
  };
}

async function postStreamingCompletion(input: {
  endpoint: string;
  fetchImpl: RunPodFetch;
  headers: Record<string, string>;
  phase: string;
  body: Record<string, unknown>;
}) {
  let response: Response;
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new RunPodConnectionTestError(
      "RUNPOD_CONNECTION_FAILED",
      `RunPod ${input.phase} validation request failed.`,
      { retryable: true }
    );
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new RunPodConnectionTestError(
        "RUNPOD_OPENAI_CHAT_UNAVAILABLE",
        "This RunPod endpoint does not expose OpenAI-compatible /chat/completions. Queue-only /run and /runsync handlers are not supported yet.",
        { status: response.status }
      );
    }
    throw new RunPodConnectionTestError(
      "RUNPOD_CONNECTION_REJECTED",
      `RunPod ${input.phase} validation was rejected (${response.status}).`,
      {
        retryable:
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        status: response.status,
      }
    );
  }
  const isEventStream = response.headers
    .get("content-type")
    ?.toLowerCase()
    .includes("text/event-stream");
  if (!(isEventStream && response.body)) {
    throw new RunPodConnectionTestError(
      "RUNPOD_STREAMING_UNSUPPORTED",
      "RunPod model did not return an OpenAI-compatible event stream."
    );
  }
  const text = await readBoundedStream(response.body);
  const events = text
    .split(/\r?\n\r?\n/u)
    .flatMap((block) =>
      block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
    )
    .filter((value) => value && value !== "[DONE]")
    .map((value) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        throw new RunPodConnectionTestError(
          "RUNPOD_STREAM_INVALID",
          "RunPod model returned an invalid event stream."
        );
      }
    });
  if (events.length === 0) {
    throw new RunPodConnectionTestError(
      "RUNPOD_STREAM_EMPTY",
      "RunPod model returned an empty event stream."
    );
  }
  return events;
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return `${text}${decoder.decode()}`;
    }
    bytes += chunk.value.byteLength;
    if (bytes > MAX_VALIDATION_STREAM_BYTES) {
      await reader.cancel();
      throw new RunPodConnectionTestError(
        "RUNPOD_STREAM_TOO_LARGE",
        "RunPod model returned an oversized validation stream."
      );
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function extractToolCall(events: unknown[]) {
  let id = "";
  let name = "";
  let argumentsText = "";
  for (const event of events) {
    const choice = asRecord(asArray(asRecord(event)?.choices)[0]);
    const delta = asRecord(choice?.delta);
    for (const part of asArray(delta?.tool_calls)) {
      const toolCall = asRecord(part);
      const fn = asRecord(toolCall?.function);
      if (typeof toolCall?.id === "string") {
        id += toolCall.id;
      }
      if (typeof fn?.name === "string") {
        name += fn.name;
      }
      if (typeof fn?.arguments === "string") {
        argumentsText += fn.arguments;
      }
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    parsed = null;
  }
  const input = asRecord(parsed);
  if (!(id && name && input)) {
    throw new RunPodConnectionTestError(
      "RUNPOD_TOOL_CALL_MISSING",
      "RunPod model did not stream an OpenAI-compatible tool call."
    );
  }
  return { id, name, input };
}

function extractText(events: unknown[]) {
  let text = "";
  for (const event of events) {
    const choice = asRecord(asArray(asRecord(event)?.choices)[0]);
    const delta = asRecord(choice?.delta);
    if (typeof delta?.content === "string") {
      text += delta.content;
    }
  }
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
