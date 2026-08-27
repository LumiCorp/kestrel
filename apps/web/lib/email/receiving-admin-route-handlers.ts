import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  inspectReceivingDomains,
  saveReceivingConnection,
} from "@/lib/email/receiving-config";
import {
  getSafeReceivingAdminError,
  parseReceivingAdminJson,
} from "@/lib/email/receiving-admin-error";
import { routeIdSchema } from "@/lib/knowledge/validation";

type OrganizationAdminAuthority = {
  organizationId: string;
  session: { user: { id: string } };
};

type DesktopAdminAuthority = { id: string };
type DesktopContext = { params: Promise<{ organizationId: string }> };

const receivingBodySchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  receivingDomainId: z.string().trim().min(1).max(160),
});

const domainsBodySchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
});

export function createOneReceivingPutHandler(options: {
  requireAdmin: () => Promise<OrganizationAdminAuthority>;
}) {
  return async function putOneReceiving(request: Request) {
    try {
      const { organizationId, session } = await options.requireAdmin();
      const body = receivingBodySchema.parse(
        await parseReceivingAdminJson(request),
      );
      const connection = await saveReceivingConnection({
        organizationId,
        actorUserId: session.user.id,
        apiKey: body.apiKey,
        receivingDomainId: body.receivingDomainId,
      });
      await logAdminEvent({
        organizationId,
        actorUserId: session.user.id,
        category: "email",
        action: "update-inbound-receiving",
        targetType: "organization_receiving_connection",
        targetId: organizationId,
        message: "Updated Organization inbound email receiving.",
        metadata: {
          provider: "resend",
          readiness: connection.readiness,
          inboundEnabled: false,
        },
      }).catch(() => {
        console.error(
          "[organization:email:receiving] Configuration committed, but its audit event could not be recorded.",
        );
      });
      return NextResponse.json({ connection });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createOneReceivingDomainsPostHandler(options: {
  requireAdmin: () => Promise<OrganizationAdminAuthority>;
}) {
  return async function postOneReceivingDomains(request: Request) {
    try {
      const { organizationId } = await options.requireAdmin();
      const body = domainsBodySchema.parse(
        await parseReceivingAdminJson(request),
      );
      return NextResponse.json({
        domains: await inspectReceivingDomains({
          organizationId,
          apiKey: body.apiKey,
        }),
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createDesktopReceivingPutHandler(options: {
  requireAdmin: (
    request: Request,
    organizationId: string,
  ) => Promise<DesktopAdminAuthority>;
}) {
  return async function putDesktopReceiving(
    request: Request,
    context: DesktopContext,
  ) {
    try {
      const organizationId = routeIdSchema.parse(
        (await context.params).organizationId,
      );
      const user = await options.requireAdmin(request, organizationId);
      const body = receivingBodySchema.parse(
        await parseReceivingAdminJson(request),
      );
      return NextResponse.json({
        connection: await saveReceivingConnection({
          organizationId,
          actorUserId: user.id,
          apiKey: body.apiKey,
          receivingDomainId: body.receivingDomainId,
        }),
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function createDesktopReceivingDomainsPostHandler(options: {
  requireAdmin: (
    request: Request,
    organizationId: string,
  ) => Promise<DesktopAdminAuthority>;
}) {
  return async function postDesktopReceivingDomains(
    request: Request,
    context: DesktopContext,
  ) {
    try {
      const organizationId = routeIdSchema.parse(
        (await context.params).organizationId,
      );
      await options.requireAdmin(request, organizationId);
      const body = domainsBodySchema.parse(
        await parseReceivingAdminJson(request),
      );
      return NextResponse.json({
        domains: await inspectReceivingDomains({
          organizationId,
          apiKey: body.apiKey,
        }),
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function errorResponse(error: unknown) {
  const safe = getSafeReceivingAdminError(error);
  return NextResponse.json(safe.body, { status: safe.status });
}
