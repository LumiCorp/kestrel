import "server-only";

import { NextResponse } from "next/server";
import { shouldDeferPersonalEnvironmentCreation } from "./signup-access-codes";

const setupRequiredMessage =
  "Complete signup onboarding before changing personal workspace setup.";

export async function signupOnboardingSetupMutationGuard(input: {
  organizationId: string;
  userId: string;
}) {
  const onboardingIncomplete =
    await shouldDeferPersonalEnvironmentCreation(input);
  if (!onboardingIncomplete) {
    return null;
  }

  return NextResponse.json(
    {
      code: "ORGANIZATION_SETUP_REQUIRED",
      error: setupRequiredMessage,
    },
    { status: 409 },
  );
}
