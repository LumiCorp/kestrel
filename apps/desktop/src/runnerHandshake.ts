import { randomUUID } from "node:crypto";

import { createDesktopError, type DesktopError } from "./errors.js";
import type { RunnerProtocolObserver } from "./runnerTransport.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 4_000;

interface RunnerPingCommandEnvelope {
  id: string;
  type: "runner.ping";
  metadata: {
    actor: {
      actorId: string;
      actorType: "operator";
      displayName: string;
    };
  };
  payload: {
    nonce: string;
  };
}

interface RunnerProtocolEvent {
  id: string;
  type: string;
  commandId?: string | undefined;
  payload: Record<string, unknown>;
}

export interface RunnerHandshakeTransport {
  ensureStarted(): void;
  send(line: string): void;
  observe(observer: RunnerProtocolObserver): () => void;
}

export async function ensureDesktopRunnerResponsive(
  transport: RunnerHandshakeTransport,
  options: {
    timeoutMs?: number | undefined;
  } = {},
): Promise<void> {
  const commandId = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      unsubscribe();
      callback();
    };

    unsubscribe = transport.observe({
      onLine(line) {
        const event = parseRunnerEvent(line);
        if (event === undefined) {
          return;
        }
        if (event.type === "runner.error" && event.commandId === undefined) {
          settle(() => reject(toDesktopHandshakeError(event.payload.code, event.payload.message)));
          return;
        }
        if (event.commandId !== commandId) {
          return;
        }
        if (event.type === "runner.pong") {
          settle(() => resolve());
          return;
        }
        if (event.type === "runner.error") {
          settle(() => reject(toDesktopHandshakeError(event.payload.code, event.payload.message)));
        }
      },
      onExit(code) {
        settle(() =>
          reject(
            createDesktopError({
              code: "desktop.runner_exited_during_handshake",
              message:
                code === null
                  ? "Kestrel runtime exited before completing startup verification."
                  : `Kestrel runtime exited with code ${code} before completing startup verification.`,
            }),
          ),
        );
      },
    });

    if (settled) {
      return;
    }

    timeoutHandle = setTimeout(() => {
      settle(() =>
        reject(
          createDesktopError({
            code: "desktop.runner_handshake_timeout",
            message: `Kestrel runtime did not respond to startup verification within ${timeoutMs}ms.`,
          }),
        ),
      );
    }, timeoutMs);

    try {
      transport.ensureStarted();
      const command: RunnerPingCommandEnvelope = {
        id: commandId,
        type: "runner.ping",
        metadata: {
          actor: {
            actorId: "kestrel-desktop",
            actorType: "operator",
            displayName: "Kestrel Desktop",
          },
        },
        payload: {
          nonce: commandId,
        },
      };
      transport.send(JSON.stringify(command));
    } catch (error) {
      settle(() => reject(normalizeDesktopError(error)));
    }
  });
}

function parseRunnerEvent(line: string): RunnerProtocolEvent | undefined {
  const normalized = line.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(normalized);
  } catch {
    return undefined;
  }

  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return undefined;
  }

  const record = decoded as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.type !== "string" ||
    typeof record.payload !== "object" ||
    record.payload === null ||
    Array.isArray(record.payload)
  ) {
    return undefined;
  }

  return decoded as RunnerProtocolEvent;
}

function toDesktopHandshakeError(code: unknown, message: unknown): DesktopError {
  const normalizedCode = typeof code === "string" && code.length > 0
    ? code
    : "RUNNER_RUNTIME_ERROR";
  const normalizedMessage = typeof message === "string" && message.trim().length > 0
    ? message
    : `Kestrel runtime reported ${normalizedCode} before completing startup verification.`;
  return createDesktopError({
    code: normalizedCode,
    message: normalizedMessage,
  });
}

function normalizeDesktopError(error: unknown): DesktopError {
  if (typeof (error as { code?: unknown })?.code === "string" && error instanceof Error) {
    return error as DesktopError;
  }

  return createDesktopError({
    code: "desktop.runner_handshake_failed",
    message: error instanceof Error ? error.message : String(error),
  });
}
