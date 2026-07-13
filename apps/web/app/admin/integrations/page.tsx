import { Mail } from "lucide-react";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function IntegrationsAdminPage() {
  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Connect and manage platform services used across Kestrel One."
        eyebrow="Platform"
        title="Integrations"
      />
      <Link className="block max-w-xl" href="/admin/integrations/email">
        <Card className="transition-colors hover:bg-muted/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="size-5" /> Email
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            Configure transactional email delivery with Resend.
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}
