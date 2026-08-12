import { NextResponse } from "next/server";
import { z } from "zod";
import { recoverAdminDefaultEnvironment, setAdminEnvironmentRollout } from "@/lib/admin/environments";
import { getSafeGatewayAdminError } from "@/lib/ai/gateway-admin-error";
import { GatewayModelSyncHttpError } from "@/lib/ai/gateway-credential-health";
import {
  createGateway,
  listAIGatewaysWithModels,
  saveGatewayModel,
  syncGatewayModels,
  updateGateway,
} from "@/lib/ai/gateways";
import { getHostedEnvironmentsRollout } from "@/lib/environments/config";
import {
  configureFlyProviderConnection,
  testFlyProviderConnection,
} from "@/lib/environments/fly-connection";
import { EnvironmentProviderError } from "@/lib/environments/providers/contracts";
import { requireSession } from "@/lib/knowledge/auth";
import {
  isSignupAccessCodePolicyError,
  signupAccessCodeTemporarilyUnavailableMessage,
  signupAccessCodeUnavailableMessage,
} from "@/lib/signup-access-code-policy";
import {
  markSignupOnboardingComplete,
  replaceExpiredSignupAccessCodeReservation,
  SignupOnboardingCompletionError,
} from "@/lib/signup-access-codes";
import {
  getSignupOnboardingSnapshot,
  requireSignupOnboardingIdentity,
  requireSignupOnboardingWorkspace,
  SignupOnboardingGuardError,
} from "@/lib/signup-onboarding";
import {
  isSignupOnboardingProvider,
  SIGNUP_ONBOARDING_PROVIDERS,
} from "@/lib/signup-onboarding-provider-policy";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("replace-invite-code"),
    inviteCode: z.string().min(1),
  }),
  z.object({
    action: z.literal("connect-provider"),
    provider: z.enum(SIGNUP_ONBOARDING_PROVIDERS),
    apiKey: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("select-default-model"),
    modelId: z.string().min(1),
  }),
  z.object({
    action: z.literal("configure-fly"),
    organizationSlug: z.string().trim().min(1),
    apiToken: z.string().trim().min(1).nullable().optional(),
  }),
  z.object({ action: z.literal("retry-default-environment") }),
  z.object({ action: z.literal("complete") }),
]);

class SignupOnboardingResourceNotFoundError extends Error {
  constructor() {
    super("Onboarding resource not found.");
    this.name = "SignupOnboardingResourceNotFoundError";
  }
}

function onboardingErrorResponse(error: unknown) {
  if (isSignupAccessCodePolicyError(error)) {
    return NextResponse.json(
      { error: signupAccessCodeUnavailableMessage() },
      { status: 400 },
    );
  }
  if (error instanceof SignupOnboardingGuardError) {
    return NextResponse.json(
      { code: error.code, error: error.message },
      { status: error.status },
    );
  }
  if (error instanceof SignupOnboardingCompletionError) {
    return NextResponse.json(
      { code: error.code, error: "Your personal workspace is not ready yet." },
      { status: 409 },
    );
  }
  if (error instanceof SignupOnboardingResourceNotFoundError) {
    return NextResponse.json(
      { code: "ONBOARDING_RESOURCE_NOT_FOUND", error: error.message },
      { status: 404 },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { code: "ONBOARDING_REQUEST_INVALID", error: "Invalid onboarding request." },
      { status: 400 },
    );
  }
  if (error instanceof EnvironmentProviderError) {
    const status = error.code === "FLY_PROVIDER_REJECTED" ? 422 : 503;
    return NextResponse.json(
      {
        code: error.code,
        error:
          error.code === "FLY_PROVIDER_REJECTED"
            ? "Fly rejected those credentials or organization settings. Check them and try again."
            : "Fly credential validation is temporarily unavailable. Try again.",
      },
      { status },
    );
  }
  if (error instanceof GatewayModelSyncHttpError) {
    return NextResponse.json(
      {
        code:
          error.status === 401 || error.status === 403
            ? "PROVIDER_CREDENTIAL_INVALID"
            : "PROVIDER_VALIDATION_UNAVAILABLE",
        error:
          error.status === 401 || error.status === 403
            ? "The AI provider rejected that credential. Replace it and try again."
            : "AI provider validation is temporarily unavailable. Try again.",
      },
      { status: error.status === 401 || error.status === 403 ? 422 : 503 },
    );
  }
  const gatewayError = getSafeGatewayAdminError(error);
  if (
    gatewayError.body.code !== "GATEWAY_OPERATION_FAILED" ||
    gatewayError.status !== 500
  ) {
    return NextResponse.json(gatewayError.body, {
      status: gatewayError.status,
    });
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "UNAUTHORIZED" || message === "Unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.error("Signup onboarding operation failed.", {
    name: error instanceof Error ? error.name : "UnknownError",
    code: code || undefined,
  });
  return NextResponse.json(
    { error: signupAccessCodeTemporarilyUnavailableMessage() },
    { status: 503 },
  );
}

function sessionId(session: Awaited<ReturnType<typeof requireSession>>) {
  const id = (session.session as { id?: string | null } | undefined)?.id;
  if (!id) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHORIZED" });
  }
  return id;
}

async function snapshot(userId: string) {
  return getSignupOnboardingSnapshot({ userId });
}

async function assertModelReady(userId: string) {
  const current = await snapshot(userId);
  if (!current.onboarding.readiness?.modelAccess.ready) {
    throw new SignupOnboardingGuardError(
      "Validate an AI provider and select its default language model first.",
    );
  }
  return current;
}

async function connectProvider(input: {
  userId: string;
  organizationId: string;
  provider: (typeof SIGNUP_ONBOARDING_PROVIDERS)[number];
  apiKey: string;
}) {
  const gateways = await listAIGatewaysWithModels(input.organizationId);
  const existing = gateways.find(
    ({ gateway }) =>
      gateway.environmentId === null && gateway.provider === input.provider,
  )?.gateway;
  const gateway = existing
    ? await updateGateway(input.organizationId, existing.id, {
        apiKey: input.apiKey,
        enabled: true,
      })
    : await createGateway({
        organizationId: input.organizationId,
        provider: input.provider,
        apiKey: input.apiKey,
        enabled: true,
      });
  if (!gateway) {
    throw new Error("Gateway not found");
  }
  await syncGatewayModels(input.organizationId, gateway.id);
}

async function selectDefaultModel(input: {
  organizationId: string;
  modelId: string;
}) {
  const gateways = await listAIGatewaysWithModels(input.organizationId);
  for (const { gateway, models } of gateways) {
    if (
      gateway.environmentId !== null ||
      !gateway.enabled ||
      !isSignupOnboardingProvider(gateway.provider) ||
      !gateway.hasApiKey ||
      gateway.credentialStatus !== "ready" ||
      !gateway.credentialValidatedAt
    ) {
      continue;
    }
    const model = models.find(
      (candidate) =>
        candidate.id === input.modelId && candidate.modality === "language",
    );
    if (!model) continue;
    await saveGatewayModel({
      id: model.id,
      organizationId: input.organizationId,
      gatewayId: gateway.id,
      rawModelId: model.rawModelId,
      alias: model.alias,
      modality: "language",
      approved: true,
      isDefault: true,
      description: model.description,
      metadata:
        model.metadata && typeof model.metadata === "object"
          ? (model.metadata as Record<string, unknown>)
          : null,
    });
    return;
  }
  throw new SignupOnboardingResourceNotFoundError();
}

async function startOrRecoverEnvironment(input: {
  organizationId: string;
  userId: string;
}) {
  const rollout = await getHostedEnvironmentsRollout({
    organizationId: input.organizationId,
  });
  if (!rollout.deploymentEnabled) {
    return;
  }
  if (!rollout.organizationEnabled) {
    await setAdminEnvironmentRollout({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      enabled: true,
    });
  }
  await recoverAdminDefaultEnvironment({
    organizationId: input.organizationId,
    actorUserId: input.userId,
  });
}

export async function GET() {
  try {
    const session = await requireSession();
    return NextResponse.json(await snapshot(session.user.id));
  } catch (error) {
    return onboardingErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = actionSchema.parse(await request.json());

    if (body.action === "replace-invite-code") {
      const identity = await requireSignupOnboardingIdentity(session.user.id);
      if (
        identity.redemption.redeemedAt ||
        identity.redemption.reservationExpiresAt > new Date()
      ) {
        throw new SignupOnboardingGuardError(
          "A replacement invite code is not required.",
        );
      }
      await replaceExpiredSignupAccessCodeReservation({
        userId: session.user.id,
        email: session.user.email,
        code: body.inviteCode,
      });
      return NextResponse.json(await snapshot(session.user.id));
    }

    if (body.action === "complete") {
      const identity = await requireSignupOnboardingIdentity(session.user.id);
      if (identity.redemption.onboardingCompletedAt) {
        const current = await snapshot(session.user.id);
        if (!current.onboarding.organizationId) {
          throw new SignupOnboardingResourceNotFoundError();
        }
        await markSignupOnboardingComplete({
          userId: session.user.id,
          sessionId: sessionId(session),
          organizationId: current.onboarding.organizationId,
        });
        return NextResponse.json({
          ...current,
          redirectTo: "/threads/new",
        });
      }
    }

    const { organization } = await requireSignupOnboardingWorkspace(
      session.user.id,
    );

    if (body.action === "connect-provider") {
      await connectProvider({
        userId: session.user.id,
        organizationId: organization.id,
        provider: body.provider,
        apiKey: body.apiKey,
      });
    } else if (body.action === "select-default-model") {
      await selectDefaultModel({
        organizationId: organization.id,
        modelId: body.modelId,
      });
    } else if (body.action === "configure-fly") {
      await assertModelReady(session.user.id);
      await configureFlyProviderConnection({
        organizationId: organization.id,
        organizationSlug: body.organizationSlug,
        apiToken: body.apiToken,
        enabled: true,
      });
      await testFlyProviderConnection(organization.id);
      await startOrRecoverEnvironment({
        organizationId: organization.id,
        userId: session.user.id,
      });
    } else if (body.action === "retry-default-environment") {
      const current = await assertModelReady(session.user.id);
      if (!current.onboarding.readiness?.workspaceCompute.ready) {
        throw new SignupOnboardingGuardError(
          "Verify the Fly workspace provider before retrying the default Environment.",
        );
      }
      await startOrRecoverEnvironment({
        organizationId: organization.id,
        userId: session.user.id,
      });
    } else {
      const rollout = await getHostedEnvironmentsRollout({
        organizationId: organization.id,
      });
      if (!rollout.deploymentEnabled) {
        throw new SignupOnboardingGuardError(
          "Hosted Environments are disabled for this Kestrel One deployment.",
        );
      }
      await markSignupOnboardingComplete({
        userId: session.user.id,
        sessionId: sessionId(session),
        organizationId: organization.id,
      });
      return NextResponse.json({
        ...(await snapshot(session.user.id)),
        redirectTo: "/threads/new",
      });
    }

    return NextResponse.json(await snapshot(session.user.id));
  } catch (error) {
    return onboardingErrorResponse(error);
  }
}
