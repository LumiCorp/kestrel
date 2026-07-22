"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

const ACTIVE_FAVICON_SELECTOR = 'link[data-kestrel-favicon="active"]';

export function BrandFaviconSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") {
      return;
    }

    let link = document.head.querySelector<HTMLLinkElement>(
      ACTIVE_FAVICON_SELECTOR
    );
    if (!link) {
      link = document.createElement("link");
      link.dataset.kestrelFavicon = "active";
      link.rel = "icon";
      link.sizes = "any";
      link.type = "image/x-icon";
      document.head.append(link);
    }
    link.href = `/brand/favicon-${resolvedTheme}.ico`;
  }, [resolvedTheme]);

  return null;
}
