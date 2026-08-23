import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import {
  FileAvailabilityError,
  verifyRestoredFileBlob,
} from "@/lib/files/availability";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({ blobId: routeIdSchema });

/**
 * Verify one operator-restored blob. The verifier owns the complete read,
 * digest check, state transition, and audit event; this route owns only the
 * organization-admin boundary and safe HTTP presentation.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ blobId: string }> },
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { blobId } = paramsSchema.parse(await context.params);
    const repaired = await verifyRestoredFileBlob({
      blobId,
      organizationId,
      actorUserId: session.user.id,
    });

    return NextResponse.json(
      {
        blobId: repaired.id,
        availabilityStatus: repaired.availabilityStatus,
        availabilityCheckedAt: repaired.availabilityCheckedAt,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return repairErrorResponse(error);
  }
}

function repairErrorResponse(error: unknown) {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "ATTACHMENT_REPAIR_INVALID_REQUEST" } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  if (error instanceof FileAvailabilityError) {
    const status =
      error.code === "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE"
        ? 503
        : error.code === "ATTACHMENT_BLOB_REPAIR_INTEGRITY_FAILED"
          ? 422
          : 409;
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: safeRepairMessage(error.code),
        },
      },
      { status, headers: { "cache-control": "no-store" } },
    );
  }

  if (error instanceof Error && error.message === "File blob not found.") {
    return NextResponse.json(
      {
        error: {
          code: "ATTACHMENT_BLOB_NOT_FOUND",
          message: "File blob not found.",
        },
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  if (
    hasErrorCode(error, "UNAUTHORIZED") ||
    errorMessage(error) === "Unauthorized"
  ) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED" } },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  if (errorMessage(error) === "Forbidden") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN" } },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      error: {
        code: "ATTACHMENT_REPAIR_FAILED",
        message: "Unable to verify the restored file blob.",
      },
    },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

function safeRepairMessage(code: FileAvailabilityError["code"]) {
  switch (code) {
    case "ATTACHMENT_BLOB_MISSING":
      return "The restored file content is still unavailable.";
    case "ATTACHMENT_SOURCE_TEMPORARILY_UNAVAILABLE":
      return "The attachment service could not verify the restored file.";
    case "ATTACHMENT_BLOB_REPAIR_INTEGRITY_FAILED":
      return "The restored file does not match its recorded integrity values.";
    case "ATTACHMENT_UNAVAILABLE":
      return "The attached file is unavailable.";
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "";
}

function hasErrorCode(error: unknown, code: string) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === code,
  );
}
