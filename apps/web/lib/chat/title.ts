import "server-only";

import { generateText, type UIMessage } from "ai";
import { titlePrompt } from "@/lib/ai/prompts";
import { resolveRequiredLanguageModel } from "@/lib/ai/providers";
import { getTextFromMessage } from "@/lib/utils";

export async function generateTitleForOrganization({
  message,
  modelId,
  organizationId,
  environmentId,
}: {
  message: UIMessage;
  modelId?: string | null;
  organizationId: string;
  environmentId?: string | undefined;
}) {
  const resolvedTitleModel = await resolveRequiredLanguageModel({
    modelId,
    surface: "title",
    organizationId,
    environmentId,
  });
  const { text } = await generateText({
    model: resolvedTitleModel.model,
    system: titlePrompt,
    prompt: getTextFromMessage(message),
  });

  return text
    .replace(/^[#*"\s]+/, "")
    .replace(/["]+$/, "")
    .trim();
}
