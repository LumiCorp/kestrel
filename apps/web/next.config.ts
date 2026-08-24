import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { loadKestrelBuildIdentity } from "./lib/deployment/build-identity";

const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const kestrelBuildIdentity = loadKestrelBuildIdentity();
const canvasRuntimeFiles = [
  "../../node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/**/*",
  "../../node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/canvas-*/**/*",
];
const attachmentRuntimeFiles = [
  "../../packages/attachments/package.json",
  "../../packages/attachments/dist/**/*",
];
const attachmentRouteRuntimeFiles = [
  ...canvasRuntimeFiles,
  ...attachmentRuntimeFiles,
];

const nextConfig: NextConfig = {
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
