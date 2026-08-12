import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { ADMIN_DOCS } from "@/lib/admin/docs";

const GROUPS = ["Start", "Operate", "Integrate"] as const;

export default function AdminDocsPage() {
  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Concise operating guidance for the Kestrel One platform."
        eyebrow="Reference"
        title="Documentation"
      />

      <div className="space-y-8">
        {GROUPS.map((group) => (
          <section key={group}>
            <h2 className="mb-2 font-medium text-sm">{group}</h2>
            <div className="divide-y border-y">
              {ADMIN_DOCS.filter((doc) => doc.group === group).map((doc) => (
                <Link
                  className="group flex items-start justify-between gap-6 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  href={`/admin/docs/${doc.slug}`}
                  key={doc.slug}
                >
                  <span className="min-w-0">
                    <span className="font-medium text-sm group-hover:underline">
                      {doc.title}
                    </span>
                    <span className="mt-1 block max-w-3xl text-muted-foreground text-xs/5">
                      {doc.description}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
