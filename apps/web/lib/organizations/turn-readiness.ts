import "server-only";

import { NextResponse } from "next/server";
import { getOrganizationChatReadiness } from "./chat-readiness";

const setupRequiredMessage =
  "Organization setup must be completed before starting a new agent turn.";

export async function organizationSetupRequiredTurnResponse(
  organizationId: string
) {
  const readiness = await getOrganizationChatReadiness(organizationId);
  if (!(readiness.applicable && !readiness.ready && readiness.nextStep)) {
    return null;
  }
  return NextResponse.json(
    {
      code: "ORGANIZATION_SETUP_REQUIRED",
      error: setupRequiredMessage,
      nextStep: readiness.nextStep,
    },
    { status: 409 }
  );
}

export async function mobileOrganizationSetupRequiredTurnResponse(
  organizationId: string
) {
  const readiness = await getOrganizationChatReadiness(organizationId);
  if (!(readiness.applicable && !readiness.ready && readiness.nextStep)) {
    return null;
  }
  return NextResponse.json(
    {
      error: {
        code: "ORGANIZATION_SETUP_REQUIRED",
        message: setupRequiredMessage,
        retryable: false,
        nextStep: readiness.nextStep,
      },
    },
    { status: 409 }
  );
}
