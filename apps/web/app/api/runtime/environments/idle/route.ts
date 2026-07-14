import { NextResponse } from "next/server";
import { z } from "zod";
import { EnvironmentContractError } from "@/lib/environments/contracts";
import {
  authorizeWorkspaceIdleNotification,
  WorkspaceIdleNotificationError,
  workspaceIdleNotificationSchema,
} from "@/lib/environments/idle-contract";
import { requestWorkspaceIdleStop } from "@/lib/environments/store";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export async function POST(request: Request) {
  try {
    authorizeWorkspaceIdleNotification({
      authorization: request.headers.get("authorization"),
      expectedToken: process.env.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN,
    });
    const input = workspaceIdleNotificationSchema.parse(await request.json());
    const operation = await requestWorkspaceIdleStop({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      machineId: input.machineId,
      lastActivityAt: new Date(input.lastActivityAt),
    });
    if (operation?.status === "queued") {
      await enqueueEnvironmentOperation(operation.id);
    }
    return NextResponse.json(
      {
        accepted: true,
        operationId: operation?.id ?? null,
        status: operation?.status ?? "stopped",
      },
      { status: 202, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof WorkspaceIdleNotificationError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status, headers: NO_STORE_HEADERS }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: { code: "WORKSPACE_IDLE_NOTIFICATION_INVALID" } },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    if (error instanceof EnvironmentContractError) {
      return NextResponse.json(
        { error: { code: error.code } },
        {
          status: error.code === "ENVIRONMENT_FORBIDDEN" ? 403 : 409,
          headers: NO_STORE_HEADERS,
        }
      );
    }
    return NextResponse.json(
      { error: { code: "WORKSPACE_IDLE_NOTIFICATION_FAILED" } },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
