import { NextResponse } from "next/server";
import { z } from "zod";
import { getSafeGatewayAdminError } from "@/lib/ai/gateway-admin-error";
import { syncGatewayModels } from "@/lib/ai/gateways";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import {
  signupOnboardingSetupMutationGuard,
} from "@/lib/signup-onboarding-mutation-guard";

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const setupRequired = await signupOnboardingSetupMutationGuard({
      organizationId,
      userId: session.user.id,
    });
    if (setupRequired) {
      return setupRequired;
    }
    const params = paramsSchema.parse(await context.params);
    const synced = await syncGatewayModels(organizationId, params.id);
    return NextResponse.json(synced);
  } catch (error) {
    const result = getSafeGatewayAdminError(error, 502);
    return NextResponse.json(result.body, { status: result.status });
  }
}
