import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { ReasoningPolicyForm } from "./reasoning-policy-form";

export default async function EnvironmentOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const environment = await getOrganizationEnvironment({
    organizationId,
    environmentId: id,
  });
  return (
    <div className="grid gap-6">
    <Card>
      <CardHeader>
        <CardTitle>Overview</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm md:grid-cols-3">
        <div>
          <div className="text-muted-foreground">Region</div>
          {environment?.region}
        </div>
        <div>
          <div className="text-muted-foreground">Runtime</div>
          {environment?.runtimeTemplate}
        </div>
        <div>
          <div className="text-muted-foreground">Idle timeout</div>
          {environment?.idleTimeoutMinutes} minutes
        </div>
      </CardContent>
    </Card>
    {environment ? (
      <Card>
        <CardHeader>
          <CardTitle>Provider reasoning</CardTitle>
        </CardHeader>
        <CardContent>
          <ReasoningPolicyForm
            environmentId={environment.id}
            initial={{
              requestMode: environment.reasoningRequestMode,
              ...(environment.reasoningEffort ? { effort: environment.reasoningEffort } : {}),
              retentionMode: environment.reasoningRetentionMode,
              retentionDays: environment.reasoningRetentionDays,
            }}
          />
        </CardContent>
      </Card>
    ) : null}
    </div>
  );
}
