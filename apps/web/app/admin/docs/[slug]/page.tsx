import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { AdminDocContent } from "@/components/admin/admin-doc-content";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { readAdminDoc } from "@/lib/admin/docs";
import { createMetadata } from "@/lib/metadata";
import { publicAppUrl } from "@/lib/public-config";

const getAdminDoc = cache(readAdminDoc);

type AdminDocPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: AdminDocPageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = await getAdminDoc(slug);
  const routeUrl = publicAppUrl
    ? `${publicAppUrl}/admin/docs/${slug}`
    : undefined;

  if (!doc) {
    return createMetadata({
      title: "Admin Docs",
      description: "Reference documentation for Kestrel One administrators.",
      alternates: routeUrl
        ? {
            canonical: routeUrl,
          }
        : undefined,
      openGraph: routeUrl
        ? {
            url: routeUrl,
          }
        : undefined,
    });
  }

  return createMetadata({
    title: `${doc.title} Doc`,
    description: doc.description,
    alternates: routeUrl
      ? {
          canonical: routeUrl,
        }
      : undefined,
    openGraph: routeUrl
      ? {
          url: routeUrl,
        }
      : undefined,
  });
}

export default async function AdminDocPage({ params }: AdminDocPageProps) {
  const { slug } = await params;
  const doc = await getAdminDoc(slug);

  if (!doc) {
    notFound();
  }

  return (
    <article className="mx-auto max-w-[75ch] space-y-6">
      <nav aria-label="Breadcrumb" className="text-muted-foreground text-sm">
        <Link
          className="hover:text-foreground hover:underline"
          href="/admin/docs"
        >
          Documentation
        </Link>
        <span aria-hidden="true" className="mx-2">
          /
        </span>
        <span aria-current="page">{doc.title}</span>
      </nav>
      <AdminPageHeader description={doc.description} title={doc.title} />
      <AdminDocContent content={doc.content} />
    </article>
  );
}
