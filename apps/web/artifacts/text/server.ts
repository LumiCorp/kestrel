import { smoothStream, streamText } from "ai";
import { updateDocumentPrompt } from "@/lib/ai/prompts";
import { resolveRequiredLanguageModel } from "@/lib/ai/providers";
import { createDocumentHandler } from "@/lib/artifacts/server";

export const textDocumentHandler = createDocumentHandler<"text">({
  kind: "text",
  onCreateDocument: async ({ title, modelId, dataStream, organizationId }) => {
    let draftContent = "";
    const resolvedArtifactModel = await resolveRequiredLanguageModel({
      modelId,
      surface: "artifact",
      organizationId,
    });

    const { fullStream } = streamText({
      model: resolvedArtifactModel.model,
      system:
        "Write about the given topic. Markdown is supported. Use headings wherever appropriate.",
      experimental_transform: smoothStream({ chunking: "word" }),
      prompt: title,
    });

    for await (const delta of fullStream) {
      if (delta.type === "text-delta") {
        draftContent += delta.text;

        dataStream.write({
          type: "data-textDelta",
          data: delta.text,
          transient: true,
        });
      }
    }

    return draftContent;
  },
  onUpdateDocument: async ({
    document,
    description,
    modelId,
    dataStream,
    organizationId,
  }) => {
    let draftContent = "";
    const resolvedArtifactModel = await resolveRequiredLanguageModel({
      modelId,
      surface: "artifact",
      organizationId,
    });

    const { fullStream } = streamText({
      model: resolvedArtifactModel.model,
      system: updateDocumentPrompt(document.content, "text"),
      experimental_transform: smoothStream({ chunking: "word" }),
      prompt: description,
      providerOptions: {
        openai: {
          prediction: {
            type: "content",
            content: document.content,
          },
        },
      },
    });

    for await (const delta of fullStream) {
      if (delta.type === "text-delta") {
        draftContent += delta.text;

        dataStream.write({
          type: "data-textDelta",
          data: delta.text,
          transient: true,
        });
      }
    }

    return draftContent;
  },
});
