export type CodexRequestId = string | number;

interface ApprovalBase {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null | undefined;
  [key: string]: unknown;
}

export type CodexServerRequest =
  | {
      method: "item/commandExecution/requestApproval";
      id: CodexRequestId;
      params: ApprovalBase;
    }
  | {
      method: "item/fileChange/requestApproval";
      id: CodexRequestId;
      params: ApprovalBase;
    }
  | {
      method: "item/tool/requestUserInput";
      id: CodexRequestId;
      params: ApprovalBase & {
        questions: Array<{
          id: string;
          question: string;
          header?: string | undefined;
          options?: Array<{ label: string; description?: string | undefined }> | undefined;
          multiSelect?: boolean | undefined;
        }>;
      };
    };

export interface CodexUnknownServerRequest {
  method: string;
  id: CodexRequestId;
  params: Record<string, unknown>;
}

export type CodexAnyServerRequest =
  | CodexServerRequest
  | CodexUnknownServerRequest;

export type CodexServerNotification =
  | {
      method: "item/agentMessage/delta";
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: "serverRequest/resolved";
      params: { threadId: string; requestId: CodexRequestId };
    }
  | {
      method: "turn/completed";
      params: {
        threadId: string;
        turn: {
          id: string;
          status: "completed" | "interrupted" | "failed" | "inProgress";
          error: unknown | null;
        };
      };
    };

export interface CodexThreadStartResponse {
  thread: { id: string; path?: string | null | undefined };
}

export interface CodexThreadResumeResponse {
  thread: { id: string; path?: string | null | undefined };
}

export interface CodexTurnStartResponse {
  turn: { id: string };
}

export function parseCodexServerMessage(value: unknown):
  | { kind: "notification"; value: CodexServerNotification }
  | { kind: "request"; value: CodexAnyServerRequest }
  | undefined {
  if (!isRecord(value) || typeof value.method !== "string") return;
  if ("id" in value) {
    if (!isRequestId(value.id) || !isRecord(value.params)) {
      throw protocolError("Codex server request is malformed.");
    }
    const candidate = value as Record<string, unknown>;
    if (isSupportedRequestMethod(value.method)) {
      validateApprovalParams(value.params, value.method);
    }
    return {
      kind: "request",
      value: candidate as unknown as CodexAnyServerRequest,
    };
  }
  if (!isKnownNotificationMethod(value.method)) return;
  if (!isRecord(value.params)) {
    throw protocolError("Codex notification parameters are malformed.");
  }
  validateNotification(value.method, value.params);
  return {
    kind: "notification",
    value: value as unknown as CodexServerNotification,
  };
}

export function parseCodexResponseResult(method: string, value: unknown): unknown {
  if (method === "thread/start" || method === "thread/resume") {
    if (!isRecord(value) || !isRecord(value.thread) || typeof value.thread.id !== "string") {
      throw protocolError(`Codex ${method} response is malformed.`);
    }
    if (
      value.thread.path !== undefined &&
      value.thread.path !== null &&
      typeof value.thread.path !== "string"
    ) {
      throw protocolError(`Codex ${method} thread path is malformed.`);
    }
  } else if (method === "turn/start") {
    if (!isRecord(value) || !isRecord(value.turn) || typeof value.turn.id !== "string") {
      throw protocolError("Codex turn/start response is malformed.");
    }
  } else if (method === "account/read") {
    if (
      !isRecord(value) ||
      !("account" in value) ||
      typeof value.requiresOpenaiAuth !== "boolean"
    ) {
      throw protocolError("Codex account/read response is malformed.");
    }
  } else if (method === "model/list") {
    if (
      !isRecord(value) ||
      !Array.isArray(value.data) ||
      !value.data.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          typeof entry.model === "string",
      )
    ) {
      throw protocolError("Codex model/list response is malformed.");
    }
  } else if (method === "initialize" && !isRecord(value)) {
    throw protocolError("Codex initialize response is malformed.");
  }
  return value;
}

function validateApprovalParams(
  params: Record<string, unknown>,
  method: CodexServerRequest["method"],
): void {
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string"
  ) {
    throw protocolError(`Codex ${method} request is malformed.`);
  }
  if (method === "item/tool/requestUserInput") {
    if (!Array.isArray(params.questions)) {
      throw protocolError("Codex user-input questions are malformed.");
    }
    for (const question of params.questions) {
      if (
        !isRecord(question) ||
        typeof question.id !== "string" ||
        typeof question.question !== "string" ||
        (question.multiSelect !== undefined &&
          typeof question.multiSelect !== "boolean") ||
        (question.options !== undefined &&
          (!Array.isArray(question.options) ||
            !question.options.every(
              (option) =>
                isRecord(option) &&
                typeof option.label === "string" &&
                (option.description === undefined ||
                  typeof option.description === "string"),
            )))
      ) {
        throw protocolError("Codex user-input question is malformed.");
      }
    }
  }
}

function validateNotification(
  method: CodexServerNotification["method"],
  params: Record<string, unknown>,
): void {
  if (method === "item/agentMessage/delta") {
    if (
      typeof params.threadId !== "string" ||
      typeof params.turnId !== "string" ||
      typeof params.itemId !== "string" ||
      typeof params.delta !== "string"
    ) {
      throw protocolError("Codex agent-message notification is malformed.");
    }
    return;
  }
  if (method === "serverRequest/resolved") {
    if (typeof params.threadId !== "string" || !isRequestId(params.requestId)) {
      throw protocolError("Codex request-resolution notification is malformed.");
    }
    return;
  }
  if (
    typeof params.threadId !== "string" ||
    !isRecord(params.turn) ||
    typeof params.turn.id !== "string" ||
    !["completed", "interrupted", "failed", "inProgress"].includes(
      String(params.turn.status),
    ) ||
    !("error" in params.turn)
  ) {
    throw protocolError("Codex turn-completed notification is malformed.");
  }
}

function isSupportedRequestMethod(
  value: string,
): value is CodexServerRequest["method"] {
  return (
    value === "item/commandExecution/requestApproval" ||
    value === "item/fileChange/requestApproval" ||
    value === "item/tool/requestUserInput"
  );
}

function isKnownNotificationMethod(
  value: string,
): value is CodexServerNotification["method"] {
  return (
    value === "item/agentMessage/delta" ||
    value === "serverRequest/resolved" ||
    value === "turn/completed"
  );
}

function isRequestId(value: unknown): value is CodexRequestId {
  return typeof value === "string" || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "CODEX_PROTOCOL_INVALID" });
}
