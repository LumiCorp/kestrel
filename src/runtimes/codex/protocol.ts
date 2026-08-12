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
  thread: { id: string };
}

export interface CodexThreadResumeResponse {
  thread: { id: string };
}

export interface CodexTurnStartResponse {
  turn: { id: string };
}
