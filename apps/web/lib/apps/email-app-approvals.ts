import "server-only";

import type { RunnerRunTerminalEvent } from "@kestrel-agents/sdk";
import { recordHostedAppApprovalRequest } from "./hosted-app-approval-recorder";

/** @deprecated New email approvals are recorded in app_operation_approvals. */
export function recordEmailAppApprovalRequest(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorUserId: string;
  agentId: string;
  requestedExecutionId: string;
  event: RunnerRunTerminalEvent;
}) {
  return recordHostedAppApprovalRequest(input);
}
