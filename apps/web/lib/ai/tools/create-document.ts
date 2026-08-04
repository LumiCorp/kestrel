import { jsonSchema, tool, type UIMessageStreamWriter } from "ai";
import type { AuthSession } from "@/app/(auth)/auth";
import {
  artifactKinds,
  documentHandlersByArtifactKind,
} from "@/lib/artifacts/server";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";
import { webArtifactToolDescriptorCatalog } from "./artifact-tool-contracts";

type CreateDocumentProps = {
  session: AuthSession | null;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  modelId?: string | null;
};

function createToolExecutionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export const createDocument = ({
  session,
  dataStream,
  modelId,
}: CreateDocumentProps) =>
  tool({
    description: createDocumentDescriptor.description,
    inputSchema: jsonSchema<{
      title: string;
      kind: (typeof artifactKinds)[number];
    }>(createDocumentDescriptor.inputSchema),
    execute: async ({ title, kind }) => {
      if (!session?.user?.id) {
        throw createToolExecutionError("UNAUTHORIZED", "Unauthorized");
      }

      const id = generateUUID();

      dataStream.write({
        type: "data-kind",
        data: kind,
        transient: true,
      });

      dataStream.write({
        type: "data-id",
        data: id,
        transient: true,
      });

      dataStream.write({
        type: "data-title",
        data: title,
        transient: true,
      });

      dataStream.write({
        type: "data-clear",
        data: null,
        transient: true,
      });

      const documentHandler = documentHandlersByArtifactKind.find(
        (documentHandlerByArtifactKind) =>
          documentHandlerByArtifactKind.kind === kind
      );

      if (!documentHandler) {
        throw createToolExecutionError(
          "DOCUMENT_HANDLER_NOT_FOUND",
          `No document handler found for kind: ${kind}`
        );
      }

      await documentHandler.onCreateDocument({
        id,
        title,
        modelId,
        dataStream,
        session,
      });

      dataStream.write({ type: "data-finish", data: null, transient: true });

      return {
        id,
        title,
        kind,
        content: "A document was created and is now visible to the user.",
      };
    },
  });

const createDocumentDescriptor = requiredDescriptor("createDocument");

function requiredDescriptor(toolId: string) {
  const descriptor = webArtifactToolDescriptorCatalog.getDescriptor(toolId);
  if (descriptor === undefined) throw new Error(`Missing descriptor '${toolId}'`);
  return descriptor;
}
