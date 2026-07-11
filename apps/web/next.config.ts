import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));
const canvasRuntimeFiles = [
  "../../node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/**/*",
  "../../node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/canvas-*/**/*",
];

const nextConfig: NextConfig = {
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
    "/api/knowledge/documents/**": canvasRuntimeFiles,
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
