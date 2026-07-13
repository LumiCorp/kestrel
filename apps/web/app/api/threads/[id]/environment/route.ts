import { NextResponse } from "next/server";
import { z } from "zod";
import { describeEnvironmentActivation } from "@/lib/environments/execution-route";
import {
  getThreadExecutionBindingState,
  resolveOrCreateThreadExecutionBinding,
} from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { getThreadAccessForUser } from "@/lib/threads/store";

const paramsSchema = z.object({ id: routeIdSchema });

async function requireThreadEnvironmentAccess(context: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId, session } = await requireActiveOrganization();
  const { id } = paramsSchema.parse(await context.params);
  const access = await getThreadAccessForUser(
    id,
    session.user.id,
    organizationId
  );
  if (!access) return null;
  return { organizationId, session, threadId: id };
}

function activationFor(
  state: NonNullable<Awaited<ReturnType<typeof getThreadExecutionBindingState>>>
) {
  return describeEnvironmentActivation({
    environmentStatus: state.environment.status,
    workspaceStatus: state.workspace.status,
    failureMessage:
      state.workspace.failureMessage ?? state.environment.failureMessage,
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireThreadEnvironmentAccess(context);
    if (!access) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const state = await getThreadExecutionBindingState({
      organizationId: access.organizationId,
      threadId: access.threadId,
    });
    if (!state) {
      return NextResponse.json(
        { error: "Thread Environment binding not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ...state, activation: activationFor(state) });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireThreadEnvironmentAccess(context);
    if (!access) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    const resolved = await resolveOrCreateThreadExecutionBinding({
      organizationId: access.organizationId,
      threadId: access.threadId,
      userId: access.session.user.id,
    });
    if (resolved.created && resolved.operation?.status === "queued") {
      await enqueueEnvironmentOperation(resolved.operation.id);
    }
    const state = await getThreadExecutionBindingState({
      organizationId: access.organizationId,
      threadId: access.threadId,
    });
    if (!state) {
      return NextResponse.json(
        { error: "Thread Environment binding not found" },
        { status: 500 }
      );
    }
    return NextResponse.json(
      {
        ...resolved,
        environment: state.environment,
        activation: activationFor(state),
      },
      {
        status: resolved.created ? 201 : 200,
      }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
