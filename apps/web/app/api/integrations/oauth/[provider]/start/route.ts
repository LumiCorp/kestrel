import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseHostedPersonalOAuthProvider,
  startHostedPersonalAuthorization,
} from "@/lib/integrations/hosted-personal-oauth";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({ provider: z.string().trim().min(1).max(64) });
const bodySchema = z.object({
  packs: z.array(z.string().trim().min(1).max(64)).min(1).max(2),
}).strict();

/** Starts a signed-in user's hosted personal provider authorization. */
export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization(request);
    const { provider: providerPath } = paramsSchema.parse(await context.params);
    const provider = parseHostedPersonalOAuthProvider(providerPath);
    const body = bodySchema.parse(await request.json());
    const result = await startHostedPersonalAuthorization({
      provider,
      organizationId,
      userId: session.user.id,
      packs: body.packs,
    });
    return NextResponse.json(result, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
