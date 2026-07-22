import { NextResponse } from "next/server";
import { z } from "zod";
import { EnvironmentContractError } from "@/lib/environments/contracts";
import { WorkspaceIdleNotificationError, workspaceIdleNotificationSchema } from "@/lib/environments/idle-contract";
import { verifyEnvironmentServiceToken } from "@/lib/environments/service-tokens";
import { knowledgeDb } from "@/lib/knowledge/db";
import { requestWorkspaceIdleStop } from "@/lib/environments/store";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export async function POST(request: Request) {
  try {
    const input = workspaceIdleNotificationSchema.parse(await request.json());
    const environment = await knowledgeDb.query.environments.findFirst({
      where: (table, { and, eq }) => and(
        eq(table.id, input.environmentId),
        eq(table.organizationId, input.organizationId)
      ),
    });
    const authorization = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
    if (!environment?.gatewayServiceTokenHash || !verifyEnvironmentServiceToken({
      token: authorization,
      expectedHash: environment.gatewayServiceTokenHash,
    })) {
      throw new WorkspaceIdleNotificationError(
        "WORKSPACE_IDLE_UNAUTHORIZED",
        "Workspace idle authorization is invalid.",
        401
      );
    }
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
        accepted: operation !== null,
        operationId: operation?.id ?? null,
        status: operation?.status ?? "active_preview",
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
