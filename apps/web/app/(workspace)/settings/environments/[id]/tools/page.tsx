import { McpEnvironmentPanel } from "@/app/admin/environments/mcp-environment-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function EnvironmentToolsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOrganizationAdmin();
  const { id } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tools & access</CardTitle>
      </CardHeader>
      <CardContent>
        <McpEnvironmentPanel environmentId={id} />
      </CardContent>
    </Card>
  );
}
