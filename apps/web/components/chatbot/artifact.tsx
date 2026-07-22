import type { UseChatHelpers } from "@ai-sdk/react";
import equal from "fast-deep-equal";
import { AnimatePresence, motion } from "framer-motion";
import {
  type ComponentType,
  memo,
  useCallback,
  useEffect,
  useState,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import { useDebounceCallback, useWindowSize } from "usehooks-ts";
import { codeArtifact } from "@/artifacts/code/client";
import { imageArtifact } from "@/artifacts/image/client";
import { sheetArtifact } from "@/artifacts/sheet/client";
import { textArtifact } from "@/artifacts/text/client";
import { videoArtifact } from "@/components/chatbot/artifacts/video-client";
import { TimeText } from "@/components/ui/time-text";
import { useArtifact } from "@/hooks/use-artifact";
import type {
  ArtifactDocument,
  ChatMessage,
  MessageFeedback,
} from "@/lib/types";
import { fetcher } from "@/lib/utils";
import { ArtifactActions } from "./artifact-actions";
import { ArtifactCloseButton } from "./artifact-close-button";
import { ArtifactMessages } from "./artifact-messages";
import { Toolbar } from "./toolbar";
import { useSidebar } from "./ui/sidebar";
import { VersionFooter } from "./version-footer";
import type { VisibilityType } from "./visibility-selector";

export const artifactDefinitions = [
  textArtifact,
  codeArtifact,
  imageArtifact,
  sheetArtifact,
  videoArtifact,
];
export type ArtifactKind = (typeof artifactDefinitions)[number]["kind"];

export type UIArtifact = {
  title: string;
  documentId: string;
  kind: ArtifactKind;
  content: string;
  isVisible: boolean;
  status: "streaming" | "idle";
  boundingBox: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
};

function PureArtifact({
  addToolApprovalResponse,
  threadId,
  status,
  sendMessage,
  messages,
  setMessages,
  regenerate,
  feedbackByMessageId,
  onFeedbackChange,
  isReadonly,
  selectedVisibilityType: _selectedVisibilityType,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  threadId: string;
  status: UseChatHelpers<ChatMessage>["status"];
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  feedbackByMessageId: Record<string, MessageFeedback | undefined>;
  onFeedbackChange: (
    messageId: string,
    feedback: "positive" | "negative" | null
  ) => void;
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  selectedVisibilityType: VisibilityType;
}) {
  const { artifact, setArtifact, metadata, setMetadata } = useArtifact();

  const {
    data: documents,
    isLoading: isDocumentsFetching,
    mutate: mutateDocuments,
  } = useSWR<ArtifactDocument[]>(
    artifact.documentId !== "init" && artifact.status !== "streaming"
      ? `/api/artifacts/${artifact.documentId}`
      : null,
    fetcher
  );

  const [mode, setMode] = useState<"edit" | "diff">("edit");
  const [document, setDocument] = useState<ArtifactDocument | null>(null);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(-1);

  const { open: isSidebarOpen } = useSidebar();

  useEffect(() => {
    if (documents && documents.length > 0) {
      const mostRecentDocument = documents.at(-1);

      if (mostRecentDocument) {
        setDocument(mostRecentDocument);
        setCurrentVersionIndex(documents.length - 1);
        setArtifact((currentArtifact) => ({
          ...currentArtifact,
          content: mostRecentDocument.content ?? "",
        }));
      }
    }
  }, [documents, setArtifact]);

  useEffect(() => {
    mutateDocuments();
  }, [mutateDocuments]);

  const { mutate } = useSWRConfig();
  const [isContentDirty, setIsContentDirty] = useState(false);

  const handleContentChange = useCallback(
    (updatedContent: string) => {
      if (!artifact) {
        return;
      }

      mutate<ArtifactDocument[]>(
        `/api/artifacts/${artifact.documentId}`,
        async (currentDocuments) => {
          if (!currentDocuments) {
            return [];
          }

          const currentDocument = currentDocuments.at(-1);

          if (!(currentDocument && currentDocument.content)) {
            setIsContentDirty(false);
            return currentDocuments;
          }

          if (currentDocument.content !== updatedContent) {
            await fetch(`/api/artifacts/${artifact.documentId}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                title: artifact.title,
                content: updatedContent,
                kind: artifact.kind,
                threadId,
              }),
            });

            setIsContentDirty(false);

            const newDocument = {
              ...currentDocument,
              content: updatedContent,
              createdAt: new Date(),
            };

            return [...currentDocuments, newDocument];
          }
          return currentDocuments;
        },
        { revalidate: false }
      );
    },
    [artifact, mutate]
  );

  const debouncedHandleContentChange = useDebounceCallback(
    handleContentChange,
    2000
  );

  const saveContent = useCallback(
    (updatedContent: string, debounce: boolean) => {
      if (document && updatedContent !== document.content) {
        setIsContentDirty(true);

        if (debounce) {
          debouncedHandleContentChange(updatedContent);
        } else {
          handleContentChange(updatedContent);
        }
      }
    },
    [document, debouncedHandleContentChange, handleContentChange]
  );

  function getDocumentContentById(index: number) {
    if (!documents) {
      return "";
    }
    if (!documents[index]) {
      return "";
    }
    return documents[index].content ?? "";
  }

  const handleVersionChange = (type: "next" | "prev" | "toggle" | "latest") => {
    if (!documents) {
      return;
    }

    if (type === "latest") {
      setCurrentVersionIndex(documents.length - 1);
      setMode("edit");
    }

    if (type === "toggle") {
      setMode((currentMode) => (currentMode === "edit" ? "diff" : "edit"));
    }

    if (type === "prev") {
      if (currentVersionIndex > 0) {
        setCurrentVersionIndex((index) => index - 1);
      }
    } else if (type === "next" && currentVersionIndex < documents.length - 1) {
      setCurrentVersionIndex((index) => index + 1);
    }
  };

  const [isToolbarVisible, setIsToolbarVisible] = useState(false);

  /*
   * NOTE: if there are no documents, or if
   * the documents are being fetched, then
   * we mark it as the current version.
   */

  const isCurrentVersion =
    documents && documents.length > 0
      ? currentVersionIndex === documents.length - 1
      : true;

  const { width: windowWidth, height: windowHeight } = useWindowSize();
  const isMobile = windowWidth ? windowWidth < 768 : false;
  const isCompactDesktop =
    windowWidth && windowWidth >= 768 && windowWidth < 1180;
  const desktopChatPaneWidth = windowWidth
    ? isCompactDesktop
      ? Math.min(400, Math.max(320, Math.round(windowWidth * 0.34)))
      : Math.min(560, Math.max(440, Math.round(windowWidth * 0.3)))
    : 480;
  const desktopWorkspaceGutter = isCompactDesktop
    ? 12
    : windowWidth && windowWidth >= 1536
      ? 32
      : 20;
  const desktopAvailableWorkspaceWidth = windowWidth
    ? Math.max(windowWidth - desktopChatPaneWidth, 0)
    : 960;
  const desktopWorkspaceWidth = Math.min(
    1180,
    Math.max(desktopAvailableWorkspaceWidth - desktopWorkspaceGutter * 2, 0)
  );
  const desktopWorkspaceOffset =
    desktopChatPaneWidth +
    Math.max(
      (desktopAvailableWorkspaceWidth - desktopWorkspaceWidth) / 2,
      desktopWorkspaceGutter
    );

  const artifactDefinition = artifactDefinitions.find(
    (definition) => definition.kind === artifact.kind
  );

  if (!artifactDefinition) {
    throw new Error("Artifact definition not found!");
  }

  const ArtifactContent = artifactDefinition.content as ComponentType<any>;

  useEffect(() => {
    if (artifact.documentId !== "init" && artifactDefinition.initialize) {
      artifactDefinition.initialize({
        documentId: artifact.documentId,
        setMetadata,
      });
    }
  }, [artifact.documentId, artifactDefinition, setMetadata]);

  return (
    <AnimatePresence>
      {artifact.isVisible && (
        <motion.div
          animate={{ opacity: 1 }}
          className="fixed top-0 left-0 z-50 flex h-dvh w-dvw flex-row bg-transparent"
          data-testid="artifact"
          exit={{ opacity: 0, transition: { delay: 0.4 } }}
          initial={{ opacity: 1 }}
        >
          {!isMobile && (
            <motion.div
              animate={{ width: windowWidth, right: 0 }}
              className="fixed h-dvh bg-background/96 backdrop-blur-sm"
              exit={{
                width: isSidebarOpen ? windowWidth - 256 : windowWidth,
                right: 0,
              }}
              initial={{
                width: isSidebarOpen ? windowWidth - 256 : windowWidth,
                right: 0,
              }}
            />
          )}

          {!isMobile && (
            <motion.div
              animate={{
                opacity: 1,
                width: desktopChatPaneWidth,
                x: 0,
                scale: 1,
                transition: {
                  delay: 0.1,
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                },
              }}
              className="relative h-dvh shrink-0 border-border/60 border-r bg-background/98 backdrop-blur-sm dark:bg-background"
              exit={{
                opacity: 0,
                x: 0,
                scale: 1,
                transition: { duration: 0 },
              }}
              initial={{
                opacity: 0,
                width: desktopChatPaneWidth,
                x: 10,
                scale: 1,
              }}
            >
              <AnimatePresence>
                {!isCurrentVersion && (
                  <motion.div
                    animate={{ opacity: 1 }}
                    className="absolute top-0 left-0 z-50 h-dvh bg-foreground/45"
                    exit={{ opacity: 0 }}
                    initial={{ opacity: 0 }}
                    style={{ width: desktopChatPaneWidth }}
                  />
                )}
              </AnimatePresence>

              <div className="flex h-full flex-col">
                <ArtifactMessages
                  addToolApprovalResponse={addToolApprovalResponse}
                  artifactStatus={artifact.status}
                  feedbackByMessageId={feedbackByMessageId}
                  isReadonly={isReadonly}
                  messages={messages}
                  onFeedbackChange={onFeedbackChange}
                  regenerate={regenerate}
                  setMessages={setMessages}
                  status={status}
                  threadId={threadId}
                />
              </div>
            </motion.div>
          )}

          <motion.div
            animate={
              isMobile
                ? {
                    opacity: 1,
                    x: 0,
                    y: 0,
                    height: windowHeight,
                    width: windowWidth ? windowWidth : "calc(100dvw)",
                    borderRadius: 0,
                    transition: {
                      delay: 0,
                      type: "spring",
                      stiffness: 300,
                      damping: 30,
                      duration: 0.8,
                    },
                  }
                : {
                    opacity: 1,
                    x: desktopWorkspaceOffset,
                    y: 0,
                    height: windowHeight,
                    width: desktopWorkspaceWidth,
                    borderRadius: 0,
                    transition: {
                      delay: 0,
                      type: "spring",
                      stiffness: 300,
                      damping: 30,
                      duration: 0.8,
                    },
                  }
            }
            className="fixed flex h-dvh flex-col overflow-hidden border-border bg-transparent"
            exit={{
              opacity: 0,
              scale: 0.5,
              transition: {
                delay: 0.1,
                type: "spring",
                stiffness: 600,
                damping: 30,
              },
            }}
            initial={
              isMobile
                ? {
                    opacity: 1,
                    x: artifact.boundingBox.left,
                    y: artifact.boundingBox.top,
                    height: artifact.boundingBox.height,
                    width: artifact.boundingBox.width,
                    borderRadius: 50,
                  }
                : {
                    opacity: 1,
                    x: artifact.boundingBox.left,
                    y: artifact.boundingBox.top,
                    height: artifact.boundingBox.height,
                    width: artifact.boundingBox.width,
                    borderRadius: 50,
                  }
            }
          >
            <div className="flex h-full flex-col px-0 py-0 md:px-3 md:py-3 lg:px-5 lg:py-5">
              <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-none bg-background md:rounded-[22px] md:border md:border-border/70 md:bg-background/95 md:shadow-2xl md:shadow-black/20 lg:rounded-[28px] md:dark:bg-muted/95">
                <div className="flex flex-row items-start justify-between p-2 md:px-3 md:pt-3 lg:px-4 lg:pt-4">
                  <div className="flex flex-row items-start gap-4">
                    <ArtifactCloseButton />

                    <div className="flex flex-col">
                      <div className="font-medium">{artifact.title}</div>

                      {isContentDirty ? (
                        <div className="text-muted-foreground text-sm">
                          Saving changes...
                        </div>
                      ) : document ? (
                        <div className="text-muted-foreground text-sm">
                          {"Updated "}
                          <TimeText
                            mode="relative"
                            value={document.createdAt}
                          />
                        </div>
                      ) : (
                        <div className="mt-2 h-3 w-32 animate-pulse rounded-md bg-muted-foreground/20" />
                      )}
                    </div>
                  </div>

                  <ArtifactActions
                    artifact={artifact}
                    currentVersionIndex={currentVersionIndex}
                    handleVersionChange={handleVersionChange}
                    isCurrentVersion={isCurrentVersion}
                    metadata={metadata}
                    mode={mode}
                    setMetadata={setMetadata}
                  />
                </div>

                <div className="flex min-h-0 flex-1 flex-col md:px-3 md:pb-3 lg:px-4 lg:pb-4">
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-[18px] md:border md:border-border/60 md:bg-background lg:rounded-[24px] dark:bg-muted md:dark:bg-background">
                    <div className="min-h-0 max-w-full! flex-1 overflow-y-auto">
                      <ArtifactContent
                        content={
                          isCurrentVersion
                            ? artifact.content
                            : getDocumentContentById(currentVersionIndex)
                        }
                        currentVersionIndex={currentVersionIndex}
                        getDocumentContentById={getDocumentContentById}
                        isCurrentVersion={isCurrentVersion}
                        isInline={false}
                        isLoading={isDocumentsFetching && !artifact.content}
                        metadata={metadata}
                        mode={mode}
                        onSaveContent={saveContent}
                        setMetadata={setMetadata}
                        status={artifact.status}
                        suggestions={[]}
                        title={artifact.title}
                      />

                      <AnimatePresence>
                        {isCurrentVersion && (
                          <Toolbar
                            artifactKind={artifact.kind}
                            isToolbarVisible={isToolbarVisible}
                            sendMessage={sendMessage}
                            setIsToolbarVisible={setIsToolbarVisible}
                            status={status}
                          />
                        )}
                      </AnimatePresence>
                    </div>

                    <AnimatePresence>
                      {!isCurrentVersion && (
                        <VersionFooter
                          currentVersionIndex={currentVersionIndex}
                          documents={documents}
                          handleVersionChange={handleVersionChange}
                        />
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const Artifact = memo(PureArtifact, (prevProps, nextProps) => {
  if (prevProps.status !== nextProps.status) {
    return false;
  }
  if (!equal(prevProps.feedbackByMessageId, nextProps.feedbackByMessageId)) {
    return false;
  }
  if (!equal(prevProps.messages, nextProps.messages.length)) {
    return false;
  }
  if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
    return false;
  }

  return true;
});
