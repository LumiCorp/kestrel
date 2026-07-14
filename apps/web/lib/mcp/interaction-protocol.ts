import { z } from "zod";

const urlElicitationSchema = z.object({
  mode: z.literal("url"),
  message: z.string(),
  elicitationId: z.string(),
  url: z.string().url(),
});

export function parseUrlElicitation(value: unknown) {
  const parsed = urlElicitationSchema.safeParse(value);
  if (!parsed.success) return null;
  const url = new URL(parsed.data.url);
  if (url.protocol !== "https:") {
    throw new Error("URL elicitation requires an HTTPS URL.");
  }
  return { ...parsed.data, url: url.toString() };
}

export function buildElicitationResponse(input: {
  requestEnvelope: unknown;
  decision: "approve" | "deny";
  content?: Record<string, string | number | boolean | string[]> | undefined;
}) {
  if (input.decision === "deny") return { action: "decline" as const };
  if (parseUrlElicitation(input.requestEnvelope)) {
    return { action: "accept" as const };
  }
  return {
    action: "accept" as const,
    content: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
      )
      .parse(input.content ?? {}),
  };
}
