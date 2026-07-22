import { notFound } from "next/navigation";
import { getEnvironmentPrivateInference } from "@/lib/ai/environment-inference";
import { isEnvironmentPrivateInferenceEnabled } from "@/lib/ai/managed-runpod-config";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { EnvironmentInferenceClient } from "@/app/(workspace)/settings/environments/[id]/inference/page-client";

export default async function EnvironmentInferencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isEnvironmentPrivateInferenceEnabled()) notFound();
  const { organizationId } = await requireOrganizationAdmin();
  const { id: environmentId } = await params;
  const state = await getEnvironmentPrivateInference({
    organizationId,
    environmentId,
  });
  return <EnvironmentInferenceClient initialState={state} />;
}
