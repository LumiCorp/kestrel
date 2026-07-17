import { randomUUID } from "node:crypto";

import type {
  KestrelAgent,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerRunTerminalEvent,
  RunnerStreamEvent,
} from "@kestrel-agents/sdk";

export interface NextRequestCorrelation {
  requestId: string;
  correlationId: string;
  userAgent?: string | undefined;
  forwardedFor?: string | undefined;
}

export type AgentContextResolver = (request: Request, correlation: NextRequestCorrelation) => Promise<KestrelRequestContext> | KestrelRequestContext

export interface JsonRunRouteHandlerOptions {
  agent: KestrelAgent;
  resolveContext: AgentContextResolver;
  parseInput?: ((body: unknown, request: Request, correlation: NextRequestCorrelation) => Promise<KestrelAgentTurnInput> | KestrelAgentTurnInput) | undefined;
  mapResponse?: ((terminal: RunnerRunTerminalEvent) => unknown) | undefined;
}

export interface StreamRunRouteHandlerOptions {
  agent: KestrelAgent;
  resolveContext: AgentContextResolver;
  parseInput?: ((body: unknown, request: Request, correlation: NextRequestCorrelation) => Promise<KestrelAgentTurnInput> | KestrelAgentTurnInput) | undefined;
}

export interface WebhookRunRouteHandlerOptions<TPayload = unknown> {
  agent: KestrelAgent;
  resolveContext: AgentContextResolver;
  mapPayload: (
    payload: TPayload,
    request: Request,
    correlation: NextRequestCorrelation,
  ) => Promise<KestrelAgentTurnInput> | KestrelAgentTurnInput;
}

export function createJsonRunRouteHandler(options: JsonRunRouteHandlerOptions) {
  return async function POST(request: Request): Promise<Response> {
    assertServerOnly();
    const correlation = readRequestCorrelation(request);
    const [body, context] = await Promise.all([
      request.json(),
      options.resolveContext(request, correlation),
    ]);
    const input = options.parseInput !== undefined
      ? await options.parseInput(body, request, correlation)
      : parseDefaultTurnInput(body);
    const terminal = await options.agent.run(input, context);
    return jsonResponse(options.mapResponse?.(terminal) ?? terminal, correlation);
  };
}

export function createStreamRunRouteHandler(options: StreamRunRouteHandlerOptions) {
  return async function POST(request: Request): Promise<Response> {
    assertServerOnly();
    const correlation = readRequestCorrelation(request);
    const [body, context] = await Promise.all([
      request.json(),
      options.resolveContext(request, correlation),
    ]);
    const input = options.parseInput !== undefined
      ? await options.parseInput(body, request, correlation)
      : parseDefaultTurnInput(body);
    const stream = options.agent.stream(
      {
        ...input,
        signal: request.signal,
      },
      context,
    );

    const responseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let terminalDelivered = false;
        let streamClosed = false;
        const enqueueEvent = (event: RunnerStreamEvent | RunnerRunTerminalEvent | {
          id: string;
          type: string;
          ts: string;
          payload: Record<string, unknown>;
        }): boolean => {
          if (streamClosed) {
            return false;
          }
          try {
            controller.enqueue(encoder.encode(serializeSseEvent(event)));
            return true;
          } catch {
            streamClosed = true;
            return false;
          }
        };
        const closeController = () => {
          if (streamClosed) {
            return;
          }
          streamClosed = true;
          try {
            controller.close();
          } catch {
            // Ignore close races after client cancellation.
          }
        };
        try {
          for await (const event of stream) {
            if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
              terminalDelivered = true;
            }
            if (enqueueEvent(event) === false) {
              return;
            }
          }
          const terminal = await stream.result;
          if (terminalDelivered === false) {
            enqueueEvent(terminal);
          }
        } catch (error) {
          if (streamClosed === false) {
            enqueueEvent({
              id: randomUUID(),
              type: "runner.error",
              ts: new Date().toISOString(),
              payload: {
                code: "NEXT_ROUTE_STREAM_ERROR",
                message: error instanceof Error ? error.message : "Stream failed.",
              },
            });
          }
        } finally {
          closeController();
        }
      },
      cancel() {
        // The client closed the response stream; stop writing and cancel upstream work.
        void stream.cancel();
      },
    });

    return new Response(responseStream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-kestrel-request-id": correlation.requestId,
        "x-kestrel-correlation-id": correlation.correlationId,
      },
    });
  };
}

export function createWebhookRunRouteHandler<TPayload = unknown>(options: WebhookRunRouteHandlerOptions<TPayload>) {
  return async function POST(request: Request): Promise<Response> {
    assertServerOnly();
    const correlation = readRequestCorrelation(request);
    const [payload, context] = await Promise.all([
      request.json() as Promise<TPayload>,
      options.resolveContext(request, correlation),
    ]);
    const input = await options.mapPayload(payload, request, correlation);
    const terminal = await options.agent.run(input, context);
    return jsonResponse(terminal, correlation, 200);
  };
}

export function readRequestCorrelation(request: Request): NextRequestCorrelation {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const correlationId = request.headers.get("x-correlation-id")?.trim() || requestId;
  const userAgent = request.headers.get("user-agent")?.trim() || undefined;
  const forwardedFor = request.headers.get("x-forwarded-for")?.trim() || undefined;
  return {
    requestId,
    correlationId,
    ...(userAgent !== undefined ? { userAgent } : {}),
    ...(forwardedFor !== undefined ? { forwardedFor } : {}),
  };
}

function parseDefaultTurnInput(body: unknown): KestrelAgentTurnInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("Route body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  if (typeof input.sessionId !== "string" || input.sessionId.trim().length === 0) {
    throw new TypeError("Route body must include sessionId.");
  }
  if (typeof input.message !== "string") {
    throw new TypeError("Route body must include message.");
  }
  return {
    sessionId: input.sessionId,
    message: input.message,
    ...(typeof input.eventType === "string" ? { eventType: input.eventType } : {}),
  };
}

function jsonResponse(payload: unknown, correlation: NextRequestCorrelation, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-kestrel-request-id": correlation.requestId,
      "x-kestrel-correlation-id": correlation.correlationId,
    },
  });
}

function serializeSseEvent(event: RunnerStreamEvent | RunnerRunTerminalEvent | {
  id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function assertServerOnly(): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new Error("@kestrel-agents/next route helpers are server-only.");
  }
}
