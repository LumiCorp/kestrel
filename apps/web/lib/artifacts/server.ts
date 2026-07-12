import type { UIMessageStreamWriter } from "ai";
import type { AuthSession } from "@/app/(auth)/auth";
import { codeDocumentHandler } from "@/artifacts/code/server";
import { sheetDocumentHandler } from "@/artifacts/sheet/server";
import { textDocumentHandler } from "@/artifacts/text/server";
import type { ArtifactKind } from "@/components/artifact";
import type { ArtifactDocument, ChatMessage } from "../types";
import { saveArtifactDocument } from "./store";

export type SaveDocumentProps = {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
  organizationId: string;
  threadId?: string | null;
};

export type CreateDocumentCallbackProps = {
  id: string;
  title: string;
  modelId?: string | null;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  session: AuthSession;
};

export type UpdateDocumentCallbackProps = {
  document: ArtifactDocument;
  description: string;
  modelId?: string | null;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  session: AuthSession;
};

export type DocumentHandler<T = ArtifactKind> = {
  kind: T;
  onCreateDocument: (args: CreateDocumentCallbackProps) => Promise<void>;
  onUpdateDocument: (args: UpdateDocumentCallbackProps) => Promise<void>;
};

export function createDocumentHandler<T extends ArtifactKind>(config: {
  kind: T;
  onCreateDocument: (params: CreateDocumentCallbackProps) => Promise<string>;
  onUpdateDocument: (params: UpdateDocumentCallbackProps) => Promise<string>;
}): DocumentHandler<T> {
  return {
    kind: config.kind,
    onCreateDocument: async (args: CreateDocumentCallbackProps) => {
      const draftContent = await config.onCreateDocument({
        id: args.id,
        title: args.title,
        modelId: args.modelId,
        dataStream: args.dataStream,
        session: args.session,
      });

      if (args.session?.user?.id) {
        const organizationId = (
          args.session as typeof args.session & {
            session?: { activeOrganizationId?: string | null };
          }
        ).session?.activeOrganizationId;

        if (!organizationId) {
          throw new Error("Active organization required");
        }

        await saveArtifactDocument({
          id: args.id,
          title: args.title,
          content: draftContent,
          kind: config.kind,
          userId: args.session.user.id,
          organizationId,
        });
      }

      return;
    },
    onUpdateDocument: async (args: UpdateDocumentCallbackProps) => {
      const draftContent = await config.onUpdateDocument({
        document: args.document,
        description: args.description,
        modelId: args.modelId,
        dataStream: args.dataStream,
        session: args.session,
      });

      if (args.session?.user?.id) {
        const organizationId = (
          args.session as typeof args.session & {
            session?: { activeOrganizationId?: string | null };
          }
        ).session?.activeOrganizationId;

        if (!organizationId) {
          throw new Error("Active organization required");
        }

        await saveArtifactDocument({
          id: args.document.id,
          title: args.document.title,
          content: draftContent,
          kind: config.kind,
          userId: args.session.user.id,
          organizationId,
          threadId: args.document.threadId,
        });
      }

      return;
    },
  };
}

/*
 * Use this array to define the document handlers for each artifact kind.
 */
export const documentHandlersByArtifactKind: DocumentHandler[] = [
  textDocumentHandler,
  codeDocumentHandler,
  sheetDocumentHandler,
];

export const artifactKinds = [
  "text",
  "code",
  "sheet",
  "image",
  "video",
] as const;
