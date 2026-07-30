import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      allow: "/",
      disallow: [
        "/admin/",
        "/api/",
        "/apps/",
        "/dashboard/",
        "/knowledge/",
        "/projects/",
        "/settings/",
        "/threads/",
      ],
      userAgent: "*",
    },
    sitemap: "https://kestrelagents.dev/sitemap.xml",
  };
}
