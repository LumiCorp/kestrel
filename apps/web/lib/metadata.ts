import type { Metadata } from "next/types";
import { publicAppUrl, publicOgImageUrl } from "@/lib/public-config";

const DEFAULT_SOCIAL_IMAGE = "/brand/kestrel-one-social-card.png";

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

  if (publicOgImageUrl) {
    openGraph.images = publicOgImageUrl;
  } else if (!openGraph?.images) {
    openGraph.images = DEFAULT_SOCIAL_IMAGE;
  }

  const twitter: Metadata["twitter"] = {
    card: "summary_large_image",
    title: override.title ?? undefined,
    description: override.description ?? undefined,
    ...override.twitter,
  };

  if (publicOgImageUrl) {
    twitter.images = publicOgImageUrl;
  } else if (!twitter?.images) {
    twitter.images = DEFAULT_SOCIAL_IMAGE;
  }

  return {
    ...override,
    openGraph,
    twitter,
  };
}
