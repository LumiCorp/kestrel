import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { ArtifactKind } from "@/components/artifact";
import type { createDocument } from "./ai/tools/create-document";
import type { getWeather } from "./ai/tools/get-weather";
import type { requestSuggestions } from "./ai/tools/request-suggestions";
import type { updateDocument } from "./ai/tools/update-document";

export type ChatVisibility = "private" | "public";

export type ThreadHistoryEntry = {
  id: string;
  title: string | null;
  createdAt: Date;
  visibility: ChatVisibility;
  shareToken?: string | null;
};

export type MessageFeedback = {
  threadId: string;
  messageId: string;
  feedback: "positive" | "negative" | null;
};

export type ArtifactDocument = {
  id: string;
  createdAt: Date;
  title: string;
  content: string | null;
  kind: ArtifactKind;
  userId: string;
  organizationId: string;
  threadId: string | null;
};

export type ArtifactSuggestion = {
  id: string;
  documentId: string;
  documentCreatedAt: Date;
  originalText: string;
  suggestedText: string;
  description: string | null;
  isResolved: boolean;
  userId: string;
  organizationId: string;
  createdAt: Date;
};

export type DataPart = { type: "append-message"; message: string };

const kestrelTerminalStatusSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "runner_error",
  "empty",
]);

export const messageMetadataSchema = z.object({
  createdAt: z.string().optional(),
  feedback: z.enum(["positive", "negative"]).nullable().optional(),
  authorUserId: z.string().optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().optional(),
  kestrelTerminalStatus: kestrelTerminalStatusSchema.optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type weatherTool = InferUITool<typeof getWeather>;
type createDocumentTool = InferUITool<ReturnType<typeof createDocument>>;
type updateDocumentTool = InferUITool<ReturnType<typeof updateDocument>>;
type requestSuggestionsTool = InferUITool<
  ReturnType<typeof requestSuggestions>
>;
type searchKnowledgeDocumentsTool = {
  input: {
    query: string;
    limit?: number;
  };
  output: {
    query: string;
    count: number;
    excerptCount: number;
    results: Array<Record<string, unknown>>;
  };
};

export type ChatTools = {
  getWeather: weatherTool;
  createDocument: createDocumentTool;
  updateDocument: updateDocumentTool;
  requestSuggestions: requestSuggestionsTool;
  searchKnowledgeDocuments: searchKnowledgeDocumentsTool;
};

export type CustomUIDataTypes = {
  textDelta: string;
  imageDelta: string;
  sheetDelta: string;
  codeDelta: string;
  suggestion: ArtifactSuggestion;
  appendMessage: string;
  id: string;
  title: string;
  kind: ArtifactKind;
  clear: null;
  finish: null;
  "chat-title": { title: string };
  "resume-warning": { message: string };
  "stream-resumed": null;
  "stream-warning": { droppedChunkCount: number };
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
  pathname?: string;
  knowledgeEligible?: boolean;
};

export type ChatFirstTurnHandoff = {
  threadId: string;
  projectId?: string;
  messageId: string;
  messageParts: ChatMessage["parts"];
  modelId: string;
  createdAt: number;
  pendingAssistant: boolean;
};
