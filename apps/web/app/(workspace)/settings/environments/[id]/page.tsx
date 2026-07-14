import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

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
  );
}
