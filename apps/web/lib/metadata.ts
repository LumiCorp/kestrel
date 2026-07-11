import type { Metadata } from "next/types";
import { publicAppUrl, publicOgImageUrl } from "@/lib/public-config";

export function createMetadata(override: Metadata): Metadata {
  const openGraph: Metadata["openGraph"] = {
    title: override.title ?? undefined,
    description: override.description ?? undefined,
    siteName: "Kestrel One",
    ...override.openGraph,
  };

  if (!openGraph?.url && publicAppUrl) {
    openGraph.url = publicAppUrl;
  }

  if (!openGraph?.images && publicOgImageUrl) {
    openGraph.images = publicOgImageUrl;
  }

  const twitter: Metadata["twitter"] = {
    card: "summary_large_image",
    title: override.title ?? undefined,
    description: override.description ?? undefined,
    ...override.twitter,
  };

  if (!twitter?.images && publicOgImageUrl) {
    twitter.images = publicOgImageUrl;
  }

  return {
    ...override,
    openGraph,
    twitter,
  };
}
