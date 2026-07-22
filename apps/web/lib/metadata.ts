import type { Metadata } from "next/types";
import { publicAppUrl, publicOgImageUrl } from "@/lib/public-config";

const DEFAULT_SOCIAL_IMAGE = "/brand/kestrel-one-social-card.png";
type SocialImages = Exclude<Metadata["openGraph"], null | undefined>["images"];

export function resolveSocialImages(
  routeImages: SocialImages,
  configuredImage: string | null = publicOgImageUrl
): SocialImages {
  return configuredImage || routeImages || DEFAULT_SOCIAL_IMAGE;
}

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

  openGraph.images = resolveSocialImages(openGraph.images);

  const twitter: Metadata["twitter"] = {
    card: "summary_large_image",
    title: override.title ?? undefined,
    description: override.description ?? undefined,
    ...override.twitter,
  };

  twitter.images = resolveSocialImages(twitter.images);

  return {
    ...override,
    openGraph,
    twitter,
  };
}
