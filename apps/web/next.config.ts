import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { loadKestrelBuildIdentity } from "./lib/deployment/build-identity";

const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const kestrelBuildIdentity = loadKestrelBuildIdentity();
const canvasRuntimeFiles = [
  "../../node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/**/*",
  "../../node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/canvas-*/**/*",
  "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/@napi-rs/canvas/**/*",
];
const pdfRuntimeFiles = [
  "../../node_modules/.pnpm/pdf-parse@*/node_modules/pdf-parse/package.json",
  "../../node_modules/.pnpm/pdf-parse@*/node_modules/pdf-parse/dist/pdf-parse/**/*",
  "../../node_modules/.pnpm/pdf-parse@*/node_modules/pdf-parse/dist/worker/**/*",
  "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/package.json",
  "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/cmaps/**/*",
  "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/standard_fonts/**/*",
  "../../node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/wasm/**/*",
];
const attachmentRuntimeFiles = [
  "../../packages/attachments/package.json",
  "../../packages/attachments/dist/**/*",
  "../../packages/attachments/node_modules/pdfjs-dist/package.json",
  "./node_modules/pdfjs-dist/package.json",
];
const attachmentRouteRuntimeFiles = [
  ...canvasRuntimeFiles,
  ...pdfRuntimeFiles,
  ...attachmentRuntimeFiles,
];

const nextConfig: NextConfig = {
  experimental: {
    // A custom Webpack hook disables Next's default build worker. Keep the
    // compiler isolated so its heap is released before TypeScript analysis.
    webpackBuildWorker: true,
  },

  env: {
    KESTREL_APP_VERSION: kestrelBuildIdentity.version,
    KESTREL_BUILD_REVISION: kestrelBuildIdentity.revision,
  },

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatar.vercel.sh",
      },
    ],
  },

  outputFileTracingRoot: monorepoRoot,
  outputFileTracingIncludes: {
    "/knowledge": attachmentRouteRuntimeFiles,
    "/api/attachments/**": attachmentRouteRuntimeFiles,
    "/api/cron/attachments/**": attachmentRouteRuntimeFiles,
    "/api/files/**": attachmentRouteRuntimeFiles,
    "/api/knowledge/documents/**": attachmentRouteRuntimeFiles,
    "/api/projects/**/files": attachmentRouteRuntimeFiles,
    "/api/threads/**/attachments/**": attachmentRouteRuntimeFiles,
  },

  serverExternalPackages: [
    "@kestrel-agents/files",
    "pdf-parse",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "@chat-adapter/discord",
    "discord.js",
    "@discordjs/ws",
    "zlib-sync",
  ],

  webpack(config, { isServer }) {
    if (isServer) {
      // Next's serverExternalPackages matcher only recognizes resolved paths
      // below node_modules. pnpm resolves this workspace dependency to its
      // monorepo source path, so keep the exact package request external too.
      config.externals.push({
        "@kestrel-agents/files": "commonjs @kestrel-agents/files",
      });
    }
    return config;
  },
};

export default nextConfig;
