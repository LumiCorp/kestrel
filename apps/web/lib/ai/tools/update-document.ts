import { tool, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { AuthSession } from "@/app/(auth)/auth";
import { documentHandlersByArtifactKind } from "@/lib/artifacts/server";
import { getLatestArtifactDocumentById } from "@/lib/artifacts/store";
import type { ChatMessage } from "@/lib/types";

type UpdateDocumentProps = {
  session: AuthSession | null;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  modelId?: string | null;
};

function createToolExecutionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export const updateDocument = ({
  session,
  dataStream,
  modelId,
}: UpdateDocumentProps) =>
  tool({
    description: "Update a document with the given description.",
    inputSchema: z.object({
      id: z.string().describe("The ID of the document to update"),
      description: z
        .string()
        .describe("The description of changes that need to be made"),
    }),
    execute: async ({ id, description }) => {
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
        id,
        userId: session.user.id,
        organizationId,
      });

      if (!document) {
        return {
          error: "Document not found",
        };
      }

      dataStream.write({
        type: "data-clear",
        data: null,
        transient: true,
      });

      const documentHandler = documentHandlersByArtifactKind.find(
        (documentHandlerByArtifactKind) =>
          documentHandlerByArtifactKind.kind === document.kind
      );

      if (!documentHandler) {
        throw createToolExecutionError(
          "DOCUMENT_HANDLER_NOT_FOUND",
          `No document handler found for kind: ${document.kind}`
        );
      }

      await documentHandler.onUpdateDocument({
        document,
        description,
        modelId,
        dataStream,
        session,
      });

      dataStream.write({ type: "data-finish", data: null, transient: true });

      return {
        id,
        title: document.title,
        kind: document.kind,
        content: "The document has been updated successfully.",
      };
    },
  });
