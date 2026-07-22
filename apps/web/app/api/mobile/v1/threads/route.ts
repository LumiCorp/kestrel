import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getDefaultOrganizationEnvironment,
  getOrganizationEnvironment,
} from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileThreadDtos } from "@/lib/mobile/dto";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshotForRequest } from "@/lib/mobile/snapshot";
import { mobileOrganizationSetupRequiredTurnResponse } from "@/lib/organizations/turn-readiness";
import { resolveProjectRuntimeContext } from "@/lib/projects/runtime-context";
import { listThreadsForUser } from "@/lib/threads/store";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { createMobileThreadWithFirstTurn } from "@/lib/turns/store";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: routeIdSchema.optional(),
  projectId: routeIdSchema.optional(),
});
const createSchema = z
  .object({
    id: routeIdSchema,
    projectId: routeIdSchema.nullable(),
    message: z.object({
      id: routeIdSchema,
      parts: z
        .array(
          z
            .object({
              type: z.literal("text"),
              text: z.string().min(1).max(50_000),
            })
            .strict()
        )
        .min(1)
        .max(1),
    }),
  })
  .strict();

export async function GET(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const query = querySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );
    const pageSize = query.limit ?? 30;
    const threads = (
      await listThreadsForUser(session.user.id, organizationId, {
        limit: pageSize + 1,
        endingBefore: query.cursor,
        projectId: query.projectId,
      })
    ).filter((thread) => thread.mode === "chat");
    const page = threads.slice(0, pageSize);
    return NextResponse.json({
      threads: await mobileThreadDtos(page),
      nextCursor: threads.length > pageSize ? (page.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    return mobileErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const body = createSchema.parse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return mobileErrorResponse(new Error("Idempotency key required"), 400);
    }
    const setupRequired =
      await mobileOrganizationSetupRequiredTurnResponse(organizationId);
    if (setupRequired) return setupRequired;
    const projectContext = await resolveProjectRuntimeContext({
      projectId: body.projectId ?? null,
      organizationId,
      userId: session.user.id,
    });
    const environment = projectContext
      ? await getOrganizationEnvironment({
          organizationId,
          environmentId: projectContext.project.environmentId,
        })
      : await getDefaultOrganizationEnvironment(organizationId);
    if (!environment) {
      return mobileErrorResponse(new Error("Environment unavailable"), 503);
    }
    const durable = await createMobileThreadWithFirstTurn({
      threadId: body.id,
      projectId: body.projectId ?? null,
      organizationId,
      authorUserId: session.user.id,
      requestedEnvironmentId: environment.id,
      messageId: body.message.id,
      messageParts: body.message.parts,
      idempotencyKey,
      projectContextRevisionId: projectContext?.contextRevision.id ?? null,
      requestedModelId: null,
      source: "mobile",
    });
    if (durable.shouldDispatch) {
      await enqueueDurableThreadTurn(
        durable.dispatchTurnId ?? durable.turn.id
      ).catch(() => {});
    }
    const snapshot = await getMobileThreadSnapshotForRequest(request, {
      threadId: body.id,
      organizationId,
      userId: session.user.id,
    });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json(
      { snapshot, acceptedTurnId: durable.turn.id },
      { status: durable.created ? 202 : 200 }
    );
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
