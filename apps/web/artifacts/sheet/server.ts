import { streamObject } from "ai";
import { z } from "zod";
import { sheetPrompt, updateDocumentPrompt } from "@/lib/ai/prompts";
import { resolveRequiredLanguageModel } from "@/lib/ai/providers";
import { createDocumentHandler } from "@/lib/artifacts/server";

export const sheetDocumentHandler = createDocumentHandler<"sheet">({
  kind: "sheet",
  onCreateDocument: async ({ title, modelId, dataStream }) => {
    let draftContent = "";
    const resolvedArtifactModel = await resolveRequiredLanguageModel({
      modelId,
      surface: "artifact",
    });

    const { fullStream } = streamObject({
      model: resolvedArtifactModel.model,
      system: sheetPrompt,
      prompt: title,
      schema: z.object({
        csv: z.string().describe("CSV data"),
      }),
    });

    for await (const delta of fullStream) {
      if (delta.type === "object") {
        const csv = delta.object.csv;

        if (csv) {
          dataStream.write({
            type: "data-sheetDelta",
            data: csv,
            transient: true,
          });

          draftContent = csv;
        }
      }
    }

    dataStream.write({
      type: "data-sheetDelta",
      data: draftContent,
      transient: true,
    });

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
      system: updateDocumentPrompt(document.content, "sheet"),
      prompt: description,
      schema: z.object({
        csv: z.string(),
      }),
    });

    for await (const delta of fullStream) {
      if (delta.type === "object") {
        const csv = delta.object.csv;

        if (csv) {
          dataStream.write({
            type: "data-sheetDelta",
            data: csv,
            transient: true,
          });

          draftContent = csv;
        }
      }
    }

    return draftContent;
  },
});
