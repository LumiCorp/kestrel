import { Output, streamText, tool, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { AuthSession } from "@/app/(auth)/auth";
import {
  getLatestArtifactDocumentById,
  saveArtifactSuggestions,
} from "@/lib/artifacts/store";
import type { ArtifactSuggestion, ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";
import { resolveRequiredLanguageModel } from "../providers";

type RequestSuggestionsProps = {
  session: AuthSession | null;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  modelId?: string | null;
};

function createToolExecutionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export const requestSuggestions = ({
  session,
  dataStream,
  modelId,
}: RequestSuggestionsProps) =>
  tool({
    description:
      "Request writing suggestions for an existing document artifact. Only use this when the user explicitly asks to improve or get suggestions for a document they have already created. Never use for general questions.",
    inputSchema: z.object({
      documentId: z
        .string()
        .describe(
          "The UUID of an existing document artifact that was previously created with createDocument"
        ),
    }),
    execute: async ({ documentId }) => {
      if (!session?.user?.id) {
        throw createToolExecutionError("UNAUTHORIZED", "Unauthorized");
      }

      const organizationId = (
        session as typeof session & {
          session?: { activeOrganizationId?: string | null };
        }
      ).session?.activeOrganizationId;

      if (!organizationId) {
        throw createToolExecutionError(
          "ACTIVE_ORGANIZATION_REQUIRED",
          "Active organization required"
        );
      }

      const document = await getLatestArtifactDocumentById({
        id: documentId,
        userId: session.user.id,
        organizationId,
      });

      if (!(document && document.content)) {
        return {
          error: "Document not found",
        };
      }

      const suggestions: Omit<
        ArtifactSuggestion,
        "userId" | "organizationId" | "createdAt" | "documentCreatedAt"
      >[] = [];
      const resolvedSuggestionModel = await resolveRequiredLanguageModel({
        modelId,
        surface: "suggestions",
        organizationId,
      });

      const { partialOutputStream } = streamText({
        model: resolvedSuggestionModel.model,
        system:
          "You are a help writing assistant. Given a piece of writing, please offer suggestions to improve the piece of writing and describe the change. It is very important for the edits to contain full sentences instead of just words. Max 5 suggestions.",
        prompt: document.content,
        output: Output.array({
          element: z.object({
            originalSentence: z.string().describe("The original sentence"),
            suggestedSentence: z.string().describe("The suggested sentence"),
            description: z
              .string()
              .describe("The description of the suggestion"),
          }),
        }),
      });

      let processedCount = 0;
      for await (const partialOutput of partialOutputStream) {
        if (!partialOutput) {
          continue;
        }

        for (let i = processedCount; i < partialOutput.length; i++) {
          const element = partialOutput[i];
          if (
            !(
              element?.originalSentence &&
              element?.suggestedSentence &&
              element?.description
            )
          ) {
            continue;
          }

          const suggestion = {
            originalText: element.originalSentence,
            suggestedText: element.suggestedSentence,
            description: element.description,
            id: generateUUID(),
            documentId,
            isResolved: false,
          };

          dataStream.write({
            type: "data-suggestion",
            data: suggestion as ArtifactSuggestion,
            transient: true,
          });

          suggestions.push(suggestion);
          processedCount++;
        }
      }

      const userId = session.user.id;

      await saveArtifactSuggestions({
        suggestions: suggestions.map((suggestion) => ({
          ...suggestion,
          userId,
          organizationId,
          createdAt: new Date(),
          documentCreatedAt: document.createdAt,
        })),
      });

      return {
        id: documentId,
        title: document.title,
        kind: document.kind,
        message: "Suggestions have been added to the document",
      };
    },
  });
