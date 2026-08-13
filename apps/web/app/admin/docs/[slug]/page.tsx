import { permanentRedirect } from "next/navigation";

export default async function LegacyAdminDocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  permanentRedirect(`/platform/docs/${slug}`);
}
