import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { pathToFileURL } from "node:url";

export interface FakeOpenRouterServer {
  url: string;
  requests: Array<{ schemaName: string; userMessage: string }>;
  close(): Promise<void>;
}

export async function startFakeOpenRouterServer(
  input: { port?: number | undefined } = {}
): Promise<FakeOpenRouterServer> {
  const requests: Array<{ schemaName: string; userMessage: string }> = [];
  const scenarios: {
    failedAttempts: number;
    waitingCallId?: string | undefined;
  } = { failedAttempts: 0 };
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    void handleFakeOpenRouterRequest(request, response, requests, scenarios);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to start fake OpenRouter server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleFakeOpenRouterRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<{ schemaName: string; userMessage: string }>,
  scenarios: {
    failedAttempts: number;
    waitingCallId?: string | undefined;
  }
): Promise<void> {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  const body = await readRequestBody(request);
  const parsed = JSON.parse(body) as {
    metadata?:
      | {
          callId?: string | undefined;
          schemaName?: string | undefined;
        }
      | undefined;
    response_format?:
      | { json_schema?: { name?: string | undefined } | undefined }
      | undefined;
    messages?: Array<{ content?: string | undefined }> | undefined;
    stream?: boolean | undefined;
    tools?:
      | Array<{ function?: { name?: string | undefined } | undefined }>
      | undefined;
  };
  const schemaName =
    parsed.response_format?.json_schema?.name ?? parsed.metadata?.schemaName;
  const lastMessage = parsed.messages?.at(-1)?.content;
  const rawMessage = typeof lastMessage === "string" ? lastMessage : "";
  const parsedMessage =
    typeof lastMessage === "string" ? parseFakeModelMessage(lastMessage) : {};
  const userMessage = trimForUnderstanding(
    parsedMessage.userMessage ??
      (typeof lastMessage === "string" ? lastMessage : "")
  );
  const modeSource = `${body}\n${rawMessage}\n${userMessage}`;
  const toolNames = new Set(
    parsed.tools?.flatMap((tool) =>
      tool.function?.name ? [tool.function.name] : []
    ) ?? []
  );
  const finalizeToolName = toolNames.has("kestrel.finalize")
    ? "kestrel.finalize"
    : toolNames.has("kestrel_finalize")
      ? "kestrel_finalize"
      : null;
  const askUserToolName = toolNames.has("kestrel.ask_user")
    ? "kestrel.ask_user"
    : toolNames.has("kestrel_ask_user")
      ? "kestrel_ask_user"
      : null;
  const toolMode = finalizeToolName !== null;
  const callId = parsed.metadata?.callId ?? `request-${requests.length}`;
  process.stderr.write(
    `[fake-openrouter] url=${request.url ?? "none"} schema=${schemaName ?? "none"} tools=${[...toolNames].join(",") || "none"}\n`
  );

  if (
    request.url?.endsWith("/v1/responses") &&
    schemaName === undefined &&
    !toolMode
  ) {
    response.writeHead(200, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(
      JSON.stringify({
        id: `fake-response-${requests.length}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: "openai/gpt-5.2-chat",
        output: [
          {
            id: `fake-message-${requests.length}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Product Contract",
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      })
    );
    return;
  }

  if (schemaName === undefined && !toolMode) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "missing response schema name" }));
    return;
  }

  requests.push({ schemaName: schemaName ?? "tool_call", userMessage });

  if (schemaName !== undefined && schemaName !== "kestrel_agent_action") {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: `unsupported schema '${schemaName}'` })
    );
    return;
  }

  if (modeSource.includes("fake-openrouter-500")) {
    response.writeHead(500, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(JSON.stringify({ error: "fake upstream failure" }));
    return;
  }

  if (
    modeSource.includes("fake-openrouter-fail-once") &&
    scenarios.failedAttempts < 3
  ) {
    scenarios.failedAttempts += 1;
    response.writeHead(500, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(JSON.stringify({ error: "fake first-attempt failure" }));
    return;
  }

  if (modeSource.includes("fake-openrouter-malformed")) {
    response.writeHead(200, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(
      JSON.stringify({
        model: "openai/gpt-5.2-chat",
        choices: [
          { message: { content: JSON.stringify({ notNextAction: true }) } },
        ],
      })
    );
    return;
  }

  if (modeSource.includes("fake-openrouter-delay")) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (toolMode) {
    const waiting =
      modeSource.includes("fake-openrouter-wait") &&
      (scenarios.waitingCallId === undefined ||
        scenarios.waitingCallId === callId);
    if (waiting) scenarios.waitingCallId ??= callId;
    const providerToolName = waiting ? askUserToolName : finalizeToolName;
    if (!providerToolName) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: `missing tool '${providerToolName}'` })
      );
      return;
    }
    const name = providerToolName;
    const functionCall = {
      id: `fake-call-${requests.length}`,
      type: "function_call",
      name,
      arguments: JSON.stringify(
        waiting
          ? { prompt: "Which workspace should I inspect?" }
          : {
              status: "goal_satisfied",
              message: "Hello from the fake cross-surface model.",
            }
      ),
    };
    if (parsed.stream === true) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      response.write(
        `data: ${JSON.stringify({
          model: "openai/gpt-5.2-chat",
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: functionCall.id,
                    type: "function",
                    function: {
                      name,
                      arguments: functionCall.arguments,
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(
      JSON.stringify({
        model: "openai/gpt-5.2-chat",
        output: [{ content: [functionCall] }],
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: functionCall.id,
                  type: "function",
                  function: {
                    name,
                    arguments: functionCall.arguments,
                  },
                },
              ],
            },
          },
        ],
      })
    );
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(
    JSON.stringify({
      model: "openai/gpt-5.2-chat",
      choices: [
        {
          message: {
            content: JSON.stringify(
              modeSource.includes("fake-openrouter-wait")
                ? {
                    understanding: {
                      task: userMessage,
                      facts: ["The user must supply one deterministic value."],
                      currentGap: "The requested workspace name is missing.",
                      actionBasis: "Ask for the missing workspace name.",
                    },
                    nextAction: {
                      kind: "ask_user",
                      prompt: "Which workspace should I inspect?",
                    },
                    reason: "The task needs the exact workspace name.",
                  }
                : {
                    understanding: {
                      task:
                        userMessage.length > 0
                          ? userMessage
                          : "Answer the cross-surface test message.",
                      facts: [
                        "The deterministic fake model can answer this cross-surface request directly.",
                      ],
                      currentGap: "The run needs a final chat response.",
                      actionBasis:
                        "A finalize action satisfies the deterministic cross-surface test path.",
                    },
                    nextAction: {
                      kind: "finalize",
                      status: "goal_satisfied",
                      message: "Hello from the fake cross-surface model.",
                    },
                    reason:
                      "This deterministic test path can answer directly without tools.",
                  }
            ),
          },
        },
      ],
    })
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFakeModelMessage(content: string): {
  userMessage?: string | undefined;
} {
  const contextJson = extractContextJson(content);
  if (contextJson !== undefined) {
    try {
      const parsed = JSON.parse(contextJson) as {
        userMessage?: string | undefined;
        goal?: string | undefined;
      };
      return {
        userMessage: parsed.userMessage ?? parsed.goal,
      };
    } catch {
      return {
        userMessage: extractTaskSource(content) ?? content,
      };
    }
  }
  return {
    userMessage: extractTaskSource(content) ?? content,
  };
}

function extractTaskSource(content: string): string | undefined {
  const match = content.match(/^Task source:\s*\n(?<task>.+)$/imu);
  return match?.groups?.task?.trim();
}

function trimForUnderstanding(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

function extractContextJson(content: string): string | undefined {
  const marker = "Task context:";
  const start = content.indexOf(marker);
  if (start < 0) {
    return;
  }
  const jsonStart = content.indexOf("{", start);
  if (jsonStart < 0) {
    return;
  }

  let depth = 0;
  for (let index = jsonStart; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(jsonStart, index + 1);
      }
    }
  }
  return;
}

async function main(): Promise<void> {
  const port = readPort(process.argv.slice(2));
  const server = await startFakeOpenRouterServer({ port });
  process.stdout.write(`[fake-openrouter] listening ${server.url}\n`);
  const close = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
}

function readPort(args: string[]): number | undefined {
  const index = args.indexOf("--port");
  if (index < 0) {
    return;
  }
  const raw = args[index + 1];
  if (raw === undefined) {
    throw new Error("--port requires a value");
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) === false || parsed < 1) {
    throw new Error(`Invalid --port value '${raw}'`);
  }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
