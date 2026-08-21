import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { loadKestrelBuildIdentity } from "./lib/deployment/build-identity";

const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const kestrelBuildIdentity = loadKestrelBuildIdentity();
const canvasRuntimeFiles = [
  "../../node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/**/*",
  "../../node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/canvas-*/**/*",
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
    "/knowledge": canvasRuntimeFiles,
    "/api/cron/attachments/**": canvasRuntimeFiles,
    "/api/files/**": canvasRuntimeFiles,
    "/api/knowledge/documents/**": canvasRuntimeFiles,
    "/api/projects/**/files": canvasRuntimeFiles,
    "/api/threads/**/attachments/**": canvasRuntimeFiles,
  },

  serverExternalPackages: [
    "pdf-parse",
    "@napi-rs/canvas",
    "@chat-adapter/discord",
    "discord.js",
    "@discordjs/ws",
    "zlib-sync",
  ],
};

export default nextConfig;
