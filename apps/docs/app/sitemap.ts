import type { MetadataRoute } from "next";

import { getPublicPages } from "@/lib/content";
import { SITE_ORIGIN } from "@/lib/site";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = await getPublicPages();

  return pages.map(({ meta }) => ({
    url: new URL(meta.url, SITE_ORIGIN).toString(),
    changeFrequency: meta.url === "/" ? "weekly" : "monthly",
    priority: meta.url === "/" ? 1 : meta.slug.length === 1 ? 0.9 : 0.7,
  }));
}
