import { NextResponse } from "next/server";
import { z } from "zod";
import {
  HostedBrowserPersonalDomainAccessError,
  hostedBrowserAllowlistAdoptionCoordinator,
  listPersonalBrowserDomainsForSignedInUser,
  revokePersonalBrowserDomainForSignedInUser,
} from "@/lib/apps/browser-personal-domain-access";
import {
  listHostedBrowserPersonalDomains,
  revokeHostedBrowserPersonalDomain,
} from "@/lib/apps/browser-domain-service";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const listQuerySchema = z
  .object({ environmentId: z.string().trim().min(1).max(160) })
  .strict();

const revokeBodySchema = z
  .object({
    environmentId: z.string().trim().min(1).max(160),
    canonicalDomain: z.string().trim().min(1).max(253),
  })
  .strict();

const personalDomainDependencies = {
  findEnvironment: getOrganizationEnvironment,
  listDomains: listHostedBrowserPersonalDomains,
  revokeDomain: revokeHostedBrowserPersonalDomain,
  adoptionCoordinator: hostedBrowserAllowlistAdoptionCoordinator,
};

export async function GET(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization(request);
    const query = listQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const domains = await listPersonalBrowserDomainsForSignedInUser(
      {
        organizationId,
        environmentId: query.environmentId,
        userId: session.user.id,
      },
      personalDomainDependencies,
    );
    return NextResponse.json(
      { domains },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return personalDomainErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { organizationId, session } = await requireActiveOrganization(request);
    const input = revokeBodySchema.parse(await request.json());
    const mutation = await revokePersonalBrowserDomainForSignedInUser(
      {
        organizationId,
        environmentId: input.environmentId,
        userId: session.user.id,
        destination: `https://${input.canonicalDomain}`,
      },
      personalDomainDependencies,
    );
    return NextResponse.json(
      {
        changed: mutation.changed,
        personalRevision: mutation.personalRevision,
        domain: mutation.domain,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return personalDomainErrorResponse(error);
  }
}

function personalDomainErrorResponse(error: unknown) {
  if (error instanceof HostedBrowserPersonalDomainAccessError) {
    const status =
      error.code === "BROWSER_PERSONAL_DOMAIN_SCOPE_NOT_FOUND" ? 404 : 503;
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status, headers: { "cache-control": "private, no-store" } },
    );
  }
  return errorResponse(error, 400);
}
