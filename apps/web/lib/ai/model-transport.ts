type LanguageModelUsage = "default" | "tool-loop";
type LanguageModelTransport = "responses" | "chat";

export type { LanguageModelTransport, LanguageModelUsage };

export function resolveLanguageModelTransport(input: {
  provider: string;
  usage?: LanguageModelUsage;
}): LanguageModelTransport {
  if (input.usage === "tool-loop" && input.provider === "openrouter") {
    return "chat";
  }

  return "responses";
}
