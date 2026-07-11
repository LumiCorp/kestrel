const LOW_VALUE_URL_SUFFIXES = [".xml", ".rss"];
const LOW_VALUE_URL_MARKERS = ["sitemap", "/video/", "/videos/", "/pictures/", "/graphics/"];

export function isLowValueInternetResultUrl(rawUrl: string | undefined): boolean {
  const normalized = rawUrl?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    return matchesLowValueUrlParts(parsed.hostname.toLowerCase(), parsed.pathname.toLowerCase());
  } catch {
    return matchesLowValueUrlParts(normalized, normalized);
  }
}

function matchesLowValueUrlParts(hostname: string, pathname: string): boolean {
  if (LOW_VALUE_URL_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
    return true;
  }

  if (hostname.includes("sitemap") || pathname.includes("sitemap")) {
    return true;
  }

  return LOW_VALUE_URL_MARKERS.some((marker) => pathname.includes(marker));
}
