import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ADMIN_DOCS } from "@/lib/admin/docs";

export default function AdminDocsPage() {
  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Local markdown documentation for the Kestrel One runtime, policy model, and integration workflows."
        eyebrow="Reference"
        title="Admin Docs"
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ADMIN_DOCS.map((doc) => (
          <Link href={`/admin/docs/${doc.slug}`} key={doc.slug}>
            <Card className="h-full transition-colors hover:bg-muted/30">
              <CardHeader>
                <CardTitle>{doc.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">
                {doc.description}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
