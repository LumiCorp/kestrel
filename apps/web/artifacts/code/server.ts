import { streamObject } from "ai";
import { z } from "zod";
import { codePrompt, updateDocumentPrompt } from "@/lib/ai/prompts";
import { resolveRequiredLanguageModel } from "@/lib/ai/providers";
import { createDocumentHandler } from "@/lib/artifacts/server";

export const codeDocumentHandler = createDocumentHandler<"code">({
  kind: "code",
  onCreateDocument: async ({ title, modelId, dataStream }) => {
    let draftContent = "";
    const resolvedArtifactModel = await resolveRequiredLanguageModel({
      modelId,
      surface: "artifact",
    });

    const { fullStream } = streamObject({
      model: resolvedArtifactModel.model,
      system: codePrompt,
      prompt: title,
      schema: z.object({
        code: z.string(),
      }),
    });

    for await (const delta of fullStream) {
      if (delta.type === "object") {
        const code = delta.object.code;

        if (code) {
          dataStream.write({
            type: "data-codeDelta",
            data: code,
            transient: true,
          });

          draftContent = code;
        }
      }
    }

    return draftContent;
  },
  onUpdateDocument: async ({ document, description, modelId, dataStream }) => {
    let draftContent = "";
    const resolvedArtifactModel = await resolveRequiredLanguageModel({
      modelId,
      surface: "artifact",
    });

    const { fullStream } = streamObject({
      model: resolvedArtifactModel.model,
      system: updateDocumentPrompt(document.content, "code"),
      prompt: description,
      schema: z.object({
        code: z.string(),
      }),
    });

    for await (const delta of fullStream) {
      if (delta.type === "object") {
        const code = delta.object.code;

        if (code) {
          dataStream.write({
            type: "data-codeDelta",
            data: code,
            transient: true,
          });

          draftContent = code;
        }
      }
    }

    return draftContent;
  },
});
