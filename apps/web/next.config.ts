import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatar.vercel.sh",
      },
    ],
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
