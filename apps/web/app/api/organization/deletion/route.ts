import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  getOrganizationDeletionOperation,
  requestOrganizationDeletion,
  retryOrganizationDeletion,
} from "@/lib/organizations/deletion";
import { requireOrganizationOwner } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { enqueueOrganizationDeletion } from "@/lib/knowledge/queue";

const deletionSchema = z.object({
  confirmationName: z.string().trim().min(1).max(120),
});

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationOwner({
      allowDeleting: true,
    });
    return NextResponse.json({
      operation: await getOrganizationDeletionOperation({ organizationId }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationOwner();
    const { confirmationName } = deletionSchema.parse(await request.json());
    const operation = await requestOrganizationDeletion({
      organizationId,
      actorUserId: session.user.id,
      confirmationName,
    });
    await enqueueOrganizationDeletion(operation.id);
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "organizations",
      action: "organization.delete.requested",
      targetType: "organization",
      targetId: organizationId,
      message: "Requested organization teardown.",
      metadata: { operationId: operation.id },
    }).catch(() => {});
    return NextResponse.json({ operation }, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function PATCH() {
  try {
    const { organizationId, session } = await requireOrganizationOwner({
      allowDeleting: true,
    });
    const operation = await retryOrganizationDeletion({ organizationId });
    await enqueueOrganizationDeletion(operation.id);
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "organizations",
      action: "organization.delete.retry_requested",
      targetType: "organization",
      targetId: organizationId,
      message: "Requested organization teardown retry.",
      metadata: { operationId: operation.id },
    }).catch(() => {});
    return NextResponse.json({ operation }, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
