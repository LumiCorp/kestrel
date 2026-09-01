import { NextResponse } from "next/server";
import { z } from "zod";
import {
  completeHostedPersonalAuthorization,
  HostedPersonalOAuthError,
  parseHostedPersonalOAuthProvider,
} from "@/lib/integrations/hosted-personal-oauth";
import { resolveKestrelAppUrl } from "@/lib/app-url";
import { requireSession } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({ provider: z.string().trim().min(1).max(64) });
const querySchema = z.object({
  state: z.string().uuid(),
  code: z.string().trim().min(1).max(8192).optional(),
  error: z.string().trim().min(1).max(256).optional(),
}).passthrough();

/**
 * The callback intentionally requires the existing Better Auth Kestrel One
 * session. It never trusts provider state as a user identity or redirects to
 * a caller-provided URL.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    const session = await requireSession(request);
    const { provider: providerPath } = paramsSchema.parse(await context.params);
    const provider = parseHostedPersonalOAuthProvider(providerPath);
    const requestUrl = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(requestUrl.searchParams));
    if (query.error) {
      throw new HostedPersonalOAuthError("OAUTH_PROVIDER_DENIED", "The OAuth provider did not approve this authorization.");
    }
    if (!query.code) {
      throw new HostedPersonalOAuthError("OAUTH_CODE_REQUIRED", "The OAuth provider did not return an authorization code.");
    }
    await completeHostedPersonalAuthorization({
      provider,
      sessionId: query.state,
      userId: session.user.id,
      code: query.code,
    });
    const returnUrl = new URL("/settings/connections", resolveKestrelAppUrl());
    returnUrl.searchParams.set("integration", provider);
    returnUrl.searchParams.set("status", "connected");
    return NextResponse.redirect(returnUrl, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
