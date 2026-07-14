import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const withMDX = createMDX({
  extension: /\.(md|mdx)$/,
});

const nextConfig = {
  experimental: {
    externalDir: true,
  },
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/search-index.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, s-maxage=300, stale-while-revalidate=86400" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/apps/desktop", destination: "/desktop", permanent: true },
      { source: "/apps/web", destination: "/kestrel-one", permanent: true },
      { source: "/docs", destination: "/start", permanent: true },
      { source: "/docs/quickstart", destination: "/start/quickstart", permanent: true },
      { source: "/docs/core-concepts", destination: "/start/concepts", permanent: true },
      { source: "/docs/architecture-overview", destination: "/start/architecture", permanent: true },
      { source: "/docs/faq", destination: "/start/faq", permanent: true },
      { source: "/deploy", destination: "/operate", permanent: true },
      { source: "/deploy/running-the-runner-service", destination: "/operate/runner-service", permanent: true },
      { source: "/deploy/environment-and-auth", destination: "/operate/environment-and-auth", permanent: true },
      { source: "/deploy/deployment-troubleshooting", destination: "/operate/troubleshooting", permanent: true },
      { source: "/operations/:path*", destination: "/operate/:path*", permanent: true },
    ];
  },
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
} satisfies NextConfig;

export default withMDX(nextConfig);
