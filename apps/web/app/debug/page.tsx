import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DebugOverviewPage() {
  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Inspect developer-facing runtime state for the active organization."
        eyebrow="Developer"
        title="Debug"
      />

      <Card>
        <CardHeader>
          <CardTitle>Knowledge</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-muted-foreground text-sm">
            Organization Knowledge is document-backed. Manage shared documents from the Knowledge workspace and Project-only material from Project context.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
