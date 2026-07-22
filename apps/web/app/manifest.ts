import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kestrel One",
    short_name: "Kestrel One",
    description: "Kestrel One agent workspace",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      {
        src: "/brand/favicon-light-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/brand/favicon-light-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
