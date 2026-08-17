export interface ConversationLinkDestination {
  url: string;
  hostname: string;
  destination: string;
}

export function describeConversationLink(url: string): ConversationLinkDestination | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    return {
      url: parsed.toString(),
      hostname: parsed.hostname,
      destination: `${parsed.pathname}${parsed.search}${parsed.hash}` || "/",
    };
  } catch {
    return;
  }
}
