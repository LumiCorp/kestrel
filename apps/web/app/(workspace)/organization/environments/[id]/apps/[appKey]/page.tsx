import { notFound } from "next/navigation";
import { EnvironmentAppSettings } from "@/components/apps/environment-apps-panel";
import { validateRuntimeApprovalReturnContext } from "@/lib/apps/runtime-approval-policy";
import { getEnvironmentAppConfiguration } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { z } from "zod";

const approvalReturnContextSchema = z.object({
  capability: z.string().trim().min(1).max(160),
  threadId: z.string().trim().min(1).max(200),
  turnId: z.string().trim().min(1).max(200),
  requestId: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).max(200),
  app: z.string().trim().min(1).max(160),
});

export default async function OrganizationEnvironmentAppDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; appKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationId, session } = await requireOrganizationAdmin();
  const { id, appKey } = await params;
  const decodedAppKey = decodeURIComponent(appKey);
  const configuration = await getEnvironmentAppConfiguration({
    organizationId,
    environmentId: id,
    appKey: decodedAppKey,
  }).catch(() => null);
  if (!configuration) notFound();
  const parsedReturnContext = approvalReturnContextSchema.safeParse(
    await searchParams,
  );
  const approvalReturnContext =
    parsedReturnContext.success &&
    parsedReturnContext.data.app === decodedAppKey &&
    configuration.capabilities.some(
      (capability) => capability.key === parsedReturnContext.data.capability,
    )
      ? await validateRuntimeApprovalReturnContext({
          organizationId,
          environmentId: id,
          userId: session.user.id,
          ...parsedReturnContext.data,
        }).catch((): undefined => {})
      : undefined;

  return (
    <EnvironmentAppSettings
      environmentId={id}
      initialConfiguration={configuration}
      approvalReturnContext={approvalReturnContext}
    />
  );
}
