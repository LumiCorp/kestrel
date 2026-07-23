import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { rateCardInputSchema } from "@/lib/costs/contracts";
import {
  createOrganizationRateCard,
  endOrganizationRateCard,
  listCostRateCards,
} from "@/lib/costs/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const endRateSchema = z.object({
  id: z.string().trim().min(1),
  effectiveTo: z.coerce.date(),
}).strict();

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json({ rates: await listCostRateCards(organizationId) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const rate = rateCardInputSchema.parse(await request.json());
    const created = await createOrganizationRateCard({
      organizationId,
      actorUserId: session.user.id,
      rate,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "costs",
      action: "create-rate",
      targetType: "cost_rate_card",
      targetId: created.id,
      message: "Created an organization cost rate override.",
      metadata: {
        category: created.category,
        provider: created.provider,
        service: created.service,
        meter: created.meter,
        unit: created.unit,
        provenance: created.provenance,
        effectiveFrom: created.effectiveFrom.toISOString(),
      },
    }).catch(() => {
      console.error("[costs] Rate committed, but audit recording failed.");
    });
    return NextResponse.json({ rate: created }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const body = endRateSchema.parse(await request.json());
    const rate = await endOrganizationRateCard({
      organizationId,
      rateCardId: body.id,
      effectiveTo: body.effectiveTo,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "costs",
      action: "end-rate",
      targetType: "cost_rate_card",
      targetId: rate.id,
      message: "Ended an organization cost rate override.",
      metadata: { effectiveTo: rate.effectiveTo?.toISOString() ?? null },
    }).catch(() => {
      console.error("[costs] Rate end committed, but audit recording failed.");
    });
    return NextResponse.json({ rate });
  } catch (error) {
    return apiError(error);
  }
}

function apiError(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Invalid rate override." }, { status: 400 });
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (hasErrorCode(error, "UNAUTHORIZED")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const message = error instanceof Error ? error.message : "Unable to save rate override.";
  return NextResponse.json({ error: message }, { status: 409 });
}

function hasErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
