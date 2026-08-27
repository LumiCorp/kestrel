"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import {
  CONVERSATION_ATTACHMENT_MAX_COUNT,
  CONVERSATION_ATTACHMENT_MAX_FILE_BYTES,
  CONVERSATION_ATTACHMENT_MAX_TURN_BYTES,
} from "@kestrel-agents/conversation";
import type { UIMessage } from "ai";
import equal from "fast-deep-equal";
import {
  CheckIcon,
  FilmIcon,
  ImagePlusIcon,
  RotateCcwIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type Dispatch,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useLocalStorage, useWindowSize } from "usehooks-ts";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/chatbot/ai-elements/model-selector";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useArtifact } from "@/hooks/use-artifact";
import {
  buildChatModel,
  type ChatModel,
  chatModels,
  DEFAULT_CHAT_MODEL,
  modelsByProvider,
} from "@/lib/ai/models";
import type { ChatSuggestion } from "@/lib/chat/suggestion-catalog";
import type { ThreadConversationState } from "@/lib/turns/client-contract";
import {
  type ComposerPresentation,
  isComposerPrimaryActionBlockedBySetup,
  resolveComposerPresentation,
} from "@/lib/turns/composer-presentation";
import type { KestrelOneInteractionMode } from "@/lib/turns/interaction-mode";
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn, generateUUID } from "@/lib/utils";
import { PromptInputSpeechButton } from "./ai-elements/prompt-input";
import {
  beginKnowledgePromotion,
  finishKnowledgePromotion,
  selectKnowledgePromotionCandidates,
} from "./attachment-knowledge-promotion";
import { ComposerToolbar } from "./composer-toolbar";
import { PromptInput, PromptInputTextarea } from "./elements/prompt-input";
import { ArrowUpIcon, PaperclipIcon, StopIcon } from "./icons";
import type { RuntimeInteractionResponse } from "./interaction-panel";
import { PreviewAttachment } from "./preview-attachment";
import { SuggestedActions } from "./suggested-actions";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import type { VisibilityType } from "./visibility-selector";

type ScopedChatModel = ChatModel & {
  scope?: "environment" | "organization" | "platform";
};

type PendingAttachmentUpload = {
  id: string;
  file: File;
  status: "uploading" | "failed";
};

function ComposerStatusEdge({
  presentation,
  queueVersion,
}: {
  presentation: ComposerPresentation;
  queueVersion: number;
}) {
  const trackClassName = {
    ready: "bg-transparent",
    working: "bg-accent/35",
    attention: "bg-primary",
    error: "bg-destructive",
  }[presentation.tone];

  return (
    <>
      <span
        aria-live="polite"
        className={cn(
          presentation.tone === "attention" || presentation.tone === "error"
            ? "flex px-2 pt-1 font-medium text-xs"
            : "sr-only",
          presentation.tone === "attention" && "text-primary",
          presentation.tone === "error" && "text-destructive"
        )}
        data-queue-version={queueVersion}
        data-testid="composer-state"
        role="status"
      >
        {presentation.label}
      </span>
      {presentation.tone === "ready" ? null : (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden",
            trackClassName
          )}
          data-composer-tone={presentation.tone}
          data-testid="composer-status-edge"
        >
          {presentation.tone === "working" ? (
            <div className="composer-agent-ribbon-sweep absolute inset-y-0 left-[-30%] w-[30%] rounded-full bg-accent" />
          ) : null}
        </div>
      )}
    </>
  );
}

function setCookie(name: string, value: string) {
  const maxAge = 60 * 60 * 24 * 365; // 1 year
  // biome-ignore lint/suspicious/noDocumentCookie: needed for client-side cookie setting
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}`;
}

function extractMarkdownTableFromHtml(html: string) {
  if (!html.toLowerCase().includes("<table")) {
    return null;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const table = doc.querySelector("table");

  if (!table) {
    return null;
  }

  const rows = Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map(
        (cell) => cell.textContent?.replace(/\s+/g, " ").trim() || ""
      )
    )
    .filter((row) => row.length > 0);

  if (rows.length === 0) {
    return null;
  }

  const header = rows[0];
  const divider = header.map(() => "---");
  const body = rows.slice(1);

  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];

  return lines.join("\n");
}

function PureMultimodalInput({
  threadId,
  projectId,
  workspaceMode,
  input,
  setInput,
  status,
  clearError,
  attachments,
  setAttachments,
  messages,
  setMessages,
  sendMessage,
  queueMessage,
  conversationState,
  onInterrupt,
  onRuntimeInteractionResponse,
  className,
  selectedVisibilityType,
  selectedModelId,
  onModelChange,
  interactionMode,
  onInteractionModeChange,
  activeEnvironmentName,
  modelScopeQuery,
  newTurnDisabledReason,
  focusRequest = 0,
}: {
  threadId: string;
  projectId?: string;
  workspaceMode?: "primary" | "isolated";
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  clearError: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  queueMessage?: (
    message: ChatMessage,
    interactionMode: KestrelOneInteractionMode
  ) => void;
  conversationState: ThreadConversationState;
  onInterrupt?: () => Promise<void>;
  onRuntimeInteractionResponse?: (
    response: RuntimeInteractionResponse
  ) => Promise<void>;
  className?: string;
  selectedVisibilityType: VisibilityType;
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
  interactionMode: KestrelOneInteractionMode;
  onInteractionModeChange: (mode: KestrelOneInteractionMode) => void;
  activeEnvironmentName?: string;
  modelScopeQuery?: string;
  newTurnDisabledReason?: string;
  focusRequest?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();
  const { setArtifact } = useArtifact();

  const hasAutoFocused = useRef(false);
  useEffect(() => {
    if (!hasAutoFocused.current && width) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        hasAutoFocused.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [width]);

  useEffect(() => {
    if (focusRequest === 0) return;
    textareaRef.current?.focus();
  }, [focusRequest]);

  const resetHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "";
    }
  }, []);

  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    "input",
    ""
  );
  const [autoPlaySpeech, setAutoPlaySpeech] = useLocalStorage(
    "chat-autoplay-tts",
    false
  );
  const [availableModels, setAvailableModels] =
    useState<ScopedChatModel[]>(chatModels);
  const [imageModels, setImageModels] = useState<ChatModel[]>([]);
  const [videoModels, setVideoModels] = useState<ChatModel[]>([]);
  const [mediaModelsResolved, setMediaModelsResolved] = useState(false);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false);
  const [toolCapabilitiesResolved, setToolCapabilitiesResolved] =
    useState(false);
  const [promotionOpen, setPromotionOpen] = useState(false);
  const [promotionPending, setPromotionPending] = useState(false);
  const promotionSingleFlight = useRef(false);
  const [pendingKnowledgePromotion, setPendingKnowledgePromotion] = useState<
    Attachment[]
  >([]);
  const [mediaDialogOpen, setMediaDialogOpen] = useState(false);
  const [mediaKind, setMediaKind] = useState<"image" | "video">("image");
  const [mediaPrompt, setMediaPrompt] = useState("");
  const [mediaModelId, setMediaModelId] = useState("");
  const [mediaBusy, setMediaBusy] = useState(false);

  useEffect(() => {
    if (textareaRef.current) {
      const domValue = textareaRef.current.value;
      // Prefer DOM value over localStorage to handle hydration
      const finalValue = domValue || localStorageInput || "";
      setInput(finalValue);
    }
    // Only run once after hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localStorageInput, setInput]);

  useEffect(() => {
    setLocalStorageInput(input);
  }, [input, setLocalStorageInput]);

  useEffect(() => {
    let isMounted = true;

    void fetch(
      `/api/models/approved?modality=language${modelScopeQuery ?? ""}`,
      {
        cache: "no-store",
      }
    )
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (!(response.ok && Array.isArray(json.models))) {
          return;
        }

        if (!isMounted) {
          return;
        }

        setAvailableModels(
          json.models.map((model: Record<string, string>) => ({
            id: model.id,
            name: model.name,
            provider: model.provider,
            description: model.description || "Approved model",
            scope: model.scope,
          }))
        );
      })
      .catch(() => {
        // Keep fallback models.
      });

    return () => {
      isMounted = false;
    };
  }, [modelScopeQuery]);

  useEffect(() => {
    let isMounted = true;

    void fetch("/api/runtime/apps", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));

        if (!isMounted) {
          return;
        }

        if (response.ok && Array.isArray(json.capabilities)) {
          setKnowledgeEnabled(
            json.capabilities.includes("searchKnowledgeDocuments")
          );
        }
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }

        setKnowledgeEnabled(false);
      })
      .finally(() => {
        if (isMounted) {
          setToolCapabilitiesResolved(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadMediaModels = async () => {
      try {
        const [imageResponse, videoResponse] = await Promise.all([
          fetch(`/api/models/approved?modality=image${modelScopeQuery ?? ""}`, {
            cache: "no-store",
          }),
          fetch(`/api/models/approved?modality=video${modelScopeQuery ?? ""}`, {
            cache: "no-store",
          }),
        ]);

        const [imageJson, videoJson] = await Promise.all([
          imageResponse.json().catch(() => ({})),
          videoResponse.json().catch(() => ({})),
        ]);

        if (!isMounted) {
          return;
        }

        if (Array.isArray(imageJson.models)) {
          const models = imageJson.models.map(
            (model: Record<string, string>) => ({
              id: model.id,
              name: model.name,
              provider: model.provider,
              description: model.description || "Approved image model",
            })
          );
          setImageModels(models);
          setMediaModelId((current) => current || models[0]?.id || "");
        }

        if (Array.isArray(videoJson.models)) {
          const models = videoJson.models.map(
            (model: Record<string, string>) => ({
              id: model.id,
              name: model.name,
              provider: model.provider,
              description: model.description || "Approved video model",
            })
          );
          setVideoModels(models);
        }
      } catch (_error) {
        // Leave media models empty and allow the empty state to fall back.
      } finally {
        if (isMounted) {
          setMediaModelsResolved(true);
        }
      }
    };

    void loadMediaModels();

    return () => {
      isMounted = false;
    };
  }, [modelScopeQuery]);

  useEffect(() => {
    const models = mediaKind === "image" ? imageModels : videoModels;
    setMediaModelId((current) =>
      models.some((model) => model.id === current)
        ? current
        : (models[0]?.id ?? "")
    );
  }, [imageModels, mediaKind, videoModels]);

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<PendingAttachmentUpload[]>([]);
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const composerPresentation = useMemo(
    () =>
      resolveComposerPresentation({
        attachmentCount: attachments.length,
        canInterrupt: Boolean(
          conversationState.queue.activeTurnId && onInterrupt
        ),
        canQueue: Boolean(queueMessage),
        conversationState,
        hasText: input.trim().length > 0,
        transportStatus: status,
        uploadCount: uploadQueue.length,
      }),
    [
      attachments.length,
      conversationState,
      input,
      onInterrupt,
      queueMessage,
      status,
      uploadQueue.length,
    ]
  );
  const composerPolicy = composerPresentation.submissionPolicy;
  const composerRuntimeQuestion =
    composerPolicy.mode === "answer_interaction"
      ? composerPolicy.interaction
      : null;
  const composerBlockedByInteraction =
    composerPolicy.mode === "blocked_interaction";
  const composerBlockedBySetup = Boolean(
    newTurnDisabledReason && !composerRuntimeQuestion
  );
  const primaryActionBlockedBySetup =
    isComposerPrimaryActionBlockedBySetup(
      composerPresentation.action.kind,
      composerBlockedBySetup
    );
  const shouldQueueSubmission = composerPolicy.mode === "queue_turn";

  useEffect(() => {
    if (composerRuntimeQuestion) {
      textareaRef.current?.focus();
    }
  }, [composerRuntimeQuestion?.requestId]);

  const submitForm = useCallback(async () => {
    const liveInputValue = textareaRef.current?.value ?? input;

    if (composerPresentation.action.disabled) {
      return;
    }

    if (!liveInputValue.trim() && attachments.length === 0) {
      return;
    }

    if (status === "error") {
      clearError();
      return;
    }

    if (composerBlockedByInteraction || composerBlockedBySetup) {
      return;
    }

    if (composerRuntimeQuestion) {
      if (!onRuntimeInteractionResponse) return;
      if (!composerRuntimeQuestion.turnId) {
        toast.error("The pending request is not attached to an active turn.");
        return;
      }
      if (attachments.length > 0) {
        toast.error(
          "Attachments cannot be included in an interaction response."
        );
        return;
      }
      setLocalStorageInput("");
      resetHeight();
      setInput("");
      try {
        await onRuntimeInteractionResponse({
          requestId: composerRuntimeQuestion.requestId,
          eventType: composerRuntimeQuestion.eventType,
          turnId: composerRuntimeQuestion.turnId,
          message: liveInputValue.trim(),
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "The response could not be sent."
        );
        setInput(liveInputValue);
        return;
      }
      return;
    }

    const message: ChatMessage = {
      id: generateUUID(),
      role: "user",
      parts: [
        ...attachments.map((attachment) => ({
          type: "data-kestrel-file" as const,
          data: {
            type: "kestrel-file" as const,
            fileId: attachment.attachmentId,
            filename: attachment.name,
            sizeBytes: attachment.sizeBytes,
            mediaType: attachment.contentType,
            representationKind: attachment.representationStatus,
            status: attachment.status,
          },
        })),
        {
          type: "text",
          text: liveInputValue,
        },
      ],
    };

    if (shouldQueueSubmission) {
      if (!queueMessage) {
        return;
      }
      queueMessage(message, interactionMode);
    } else {
      void sendMessage(message, { body: { interactionMode } });
    }

    setAttachments([]);
    setLocalStorageInput("");
    resetHeight();
    setInput("");

    if (width && width > 768) {
      textareaRef.current?.focus();
    }
  }, [
    input,
    setInput,
    attachments,
    sendMessage,
    queueMessage,
    setAttachments,
    setLocalStorageInput,
    status,
    width,
    resetHeight,
    clearError,
    composerPresentation.action.disabled,
    composerBlockedByInteraction,
    composerBlockedBySetup,
    composerRuntimeQuestion,
    onRuntimeInteractionResponse,
    shouldQueueSubmission,
    interactionMode,
  ]);

  const uploadFile = useCallback(
    async (file: File, uploadId: string): Promise<Attachment | undefined> => {
      const controller = new AbortController();
      uploadControllersRef.current.set(uploadId, controller);
      let draftAttachmentId: string | undefined;
      try {
        const ensuredThread = await fetch("/api/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: threadId,
            ...(projectId ? { projectId } : {}),
            ...(workspaceMode ? { workspaceMode } : {}),
          }),
          signal: controller.signal,
        });
        if (!ensuredThread.ok) {
          const { error } = await ensuredThread.json();
          throw new Error(error || "Thread could not be prepared for upload.");
        }
        const initialized = await fetch("/api/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            filename: file.name,
            sizeBytes: file.size,
            ...(file.type ? { declaredMediaType: file.type } : {}),
          }),
          signal: controller.signal,
        });
        if (!initialized.ok) {
          const { error } = await initialized.json();
          throw new Error(error || "Attachment upload could not be initialized.");
        }
        const draft = await initialized.json();
        draftAttachmentId = draft.fileId;
        const uploaded = await fetch(draft.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
          },
          body: file,
          signal: controller.signal,
        });
        if (!uploaded.ok) {
          const { error } = await uploaded.json();
          throw new Error(error || "Attachment upload failed.");
        }
        const data = await uploaded.json();
        setUploadQueue((current) => current.filter((entry) => entry.id !== uploadId));
        return {
          attachmentId: data.fileId ?? data.attachmentId,
          url: data.downloadUrl,
          name: data.filename,
          contentType: data.detectedMediaType,
          sizeBytes: data.sizeBytes,
          sha256: data.sha256,
          status: "ready",
          representationStatus: data.representation,
          ...(data.metadataOnlyReason ? { metadataOnlyReason: data.metadataOnlyReason } : {}),
          knowledgeEligible: Boolean(data.knowledgeEligible),
        };
      } catch (error) {
        if (draftAttachmentId) {
          void fetch(
            `/api/files/${encodeURIComponent(draftAttachmentId)}?threadId=${encodeURIComponent(threadId)}`,
            { method: "DELETE" },
          );
        }
        if (controller.signal.aborted) {
          setUploadQueue((current) => current.filter((entry) => entry.id !== uploadId));
          return;
        }
        setUploadQueue((current) => current.map((entry) =>
          entry.id === uploadId ? { ...entry, status: "failed" } : entry
        ));
        toast.error(error instanceof Error ? error.message : "Failed to upload file.");
      } finally {
        uploadControllersRef.current.delete(uploadId);
      }
    },
    [projectId, threadId, workspaceMode]
  );

  const enqueueFiles = useCallback(
    async (files: File[]) => {
      if (
        attachments.length + uploadQueue.length + files.length >
        CONVERSATION_ATTACHMENT_MAX_COUNT
      ) {
        toast.error("A message can include at most 20 attachments.");
        return;
      }
      const oversizedFile = files.find(
        (file) => file.size > CONVERSATION_ATTACHMENT_MAX_FILE_BYTES
      );
      if (oversizedFile) {
        toast.error(`${oversizedFile.name} exceeds the 100 MiB file limit.`);
        return;
      }
      const totalBytes =
        attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) +
        uploadQueue.reduce((sum, upload) => sum + upload.file.size, 0) +
        files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > CONVERSATION_ATTACHMENT_MAX_TURN_BYTES) {
        toast.error("Attachments must total at most 500 MiB per message.");
        return;
      }

      const pending = files.map((file) => ({
        id: generateUUID(),
        file,
        status: "uploading" as const,
      }));
      setUploadQueue((current) => [...current, ...pending]);
      const uploadedAttachments = await Promise.all(
        pending.map(({ file, id }) => uploadFile(file, id))
      );
      const successful = uploadedAttachments.filter(
        (attachment): attachment is Attachment => Boolean(attachment)
      );
      if (successful.length > 0) {
        setAttachments((current) => [...current, ...successful]);
      }
      const promotionCandidates = selectKnowledgePromotionCandidates(successful);
      if (promotionCandidates.length > 0) {
        setPendingKnowledgePromotion(promotionCandidates);
        setPromotionOpen(true);
      }
    },
    [attachments, setAttachments, uploadFile, uploadQueue]
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      void enqueueFiles(files);
    },
    [enqueueFiles]
  );

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const clipboardData = event.clipboardData;
      const items = clipboardData?.items;
      if (!(items && clipboardData)) {
        return;
      }

      const fileItems = Array.from(items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);

      if (fileItems.length > 0) {
        event.preventDefault();
        void enqueueFiles(fileItems);

        return;
      }

      const html = clipboardData.getData("text/html");
      const markdownTable = extractMarkdownTableFromHtml(html);

      if (markdownTable && textareaRef.current) {
        event.preventDefault();
        const textarea = textareaRef.current;
        const start = textarea.selectionStart ?? input.length;
        const end = textarea.selectionEnd ?? input.length;
        const nextValue =
          input.slice(0, start) + markdownTable + input.slice(end);
        setInput(nextValue);
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd =
            start + markdownTable.length;
        });
      }
    },
    [enqueueFiles, input, setInput]
  );

  // Add paste event listener to textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.addEventListener("paste", handlePaste);
    return () => textarea.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  const pollMediaJob = useCallback(
    async (jobId: string, kind: "image" | "video") => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const response = await fetch(`/api/media/jobs/${jobId}`, {
          cache: "no-store",
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(json.error || "Media generation failed.");
        }
        const job = json.job as {
          artifactId: string | null;
          status: string;
          kind: "image" | "video";
        };

        if (job.status === "succeeded" && job.artifactId) {
          setArtifact({
            documentId: job.artifactId,
            title: job.kind === "image" ? "Generated image" : "Generated video",
            kind,
            content: "",
            isVisible: true,
            status: "idle",
            boundingBox: {
              top: 0,
              left: 0,
              width: 0,
              height: 0,
            },
          });
          return;
        }

        if (job.status === "failed") {
          throw new Error("Media generation failed.");
        }
      }

      throw new Error(
        "Media generation is still running. Try again in a moment."
      );
    },
    [setArtifact]
  );

  const handleSuggestedAction = useCallback(
    (suggestion: ChatSuggestion) => {
      if (suggestion.kind === "prompt") {
        sendMessage(
          {
            role: "user",
            parts: [{ type: "text", text: suggestion.prompt }],
          },
          { body: { interactionMode } }
        );
        return;
      }

      setMediaKind(suggestion.mediaKind);
      setMediaPrompt(suggestion.prompt);
      setMediaDialogOpen(true);
    },
    [interactionMode, sendMessage]
  );

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      {!composerBlockedBySetup &&
        messages.length === 0 &&
        attachments.length === 0 &&
        uploadQueue.length === 0 &&
        mediaModelsResolved &&
        toolCapabilitiesResolved && (
          <SuggestedActions
            imageEnabled={imageModels.length > 0}
            knowledgeEnabled={knowledgeEnabled}
            onSuggestionSelect={handleSuggestedAction}
            selectedVisibilityType={selectedVisibilityType}
            threadId={threadId}
            videoEnabled={videoModels.length > 0}
          />
        )}

      <input
        className="-top-4 -left-4 pointer-events-none fixed size-0.5 opacity-0"
        multiple
        onChange={handleFileChange}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />

      <PromptInput
        className="relative overflow-hidden rounded-xl border border-border bg-background p-3 shadow-xs transition-all duration-200 focus-within:border-border hover:border-muted-foreground/50"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
          }
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (files.length > 0) {
            event.preventDefault();
            void enqueueFiles(files);
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submitForm();
        }}
      >
        <ComposerStatusEdge
          presentation={composerPresentation}
          queueVersion={conversationState.queue.version}
        />

        {(attachments.length > 0 || uploadQueue.length > 0) && (
          <div
            className="flex flex-row items-end gap-2 overflow-x-scroll"
            data-testid="attachments-preview"
          >
            {attachments.map((attachment) => (
              <PreviewAttachment
                attachment={attachment}
                key={attachment.attachmentId}
                onRemove={() => {
                  void fetch(
                    `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
                    { method: "DELETE" }
                  );
                  setAttachments((currentAttachments) =>
                    currentAttachments.filter((a) => a.attachmentId !== attachment.attachmentId)
                  );
                  if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                  }
                }}
              />
            ))}

            {uploadQueue.map((upload) => (
              <PreviewAttachment
                attachment={{
                  attachmentId: upload.id,
                  url: "",
                  name: upload.file.name,
                  contentType: upload.file.type,
                  sizeBytes: upload.file.size,
                  sha256: "",
                  status: "ready",
                  representationStatus: "metadata_only",
                }}
                isUploading={upload.status === "uploading"}
                key={upload.id}
                onRemove={upload.status === "uploading" ? () => {
                  uploadControllersRef.current.get(upload.id)?.abort();
                  setUploadQueue((current) =>
                    current.filter((entry) => entry.id !== upload.id)
                  );
                } : () => {
                  setUploadQueue((current) =>
                    current.filter((entry) => entry.id !== upload.id)
                  );
                }}
                onRetry={upload.status === "failed" ? () => {
                  setUploadQueue((current) => current.map((entry) =>
                    entry.id === upload.id ? { ...entry, status: "uploading" } : entry
                  ));
                  void uploadFile(upload.file, upload.id).then((attachment) => {
                    if (attachment) {
                      setAttachments((current) => [...current, attachment]);
                      const promotionCandidates = selectKnowledgePromotionCandidates([attachment]);
                      if (promotionCandidates.length > 0) {
                        setPendingKnowledgePromotion(promotionCandidates);
                        setPromotionOpen(true);
                      }
                    }
                  });
                } : undefined}
              />
            ))}
          </div>
        )}
        <div className="flex flex-row items-start gap-1 sm:gap-2">
          <PromptInputTextarea
            className="grow resize-none overflow-y-auto border-0! border-none! bg-transparent p-2 text-base outline-none ring-0 [-ms-overflow-style:none] [scrollbar-width:none] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 [&::-webkit-scrollbar]:hidden"
            data-testid="multimodal-input"
            disabled={composerBlockedByInteraction || composerBlockedBySetup}
            maxHeight={200}
            minHeight={44}
            onChange={handleInput}
            onSubmitOnEnter={() => void submitForm()}
            placeholder={
              composerRuntimeQuestion
                ? "Reply to the agent..."
                : composerBlockedByInteraction
                  ? "Respond to the request above..."
                  : composerBlockedBySetup
                    ? newTurnDisabledReason
                  : "Send a message..."
            }
            ref={textareaRef}
            rows={1}
            value={input}
          />
        </div>
        {composerRuntimeQuestion && onInterrupt ? (
          <div className="flex justify-end px-2">
            <Button
              disabled={status === "submitted" || status === "streaming"}
              onClick={() => void onInterrupt()}
              size="sm"
              type="button"
              variant="outline"
            >
              End waiting turn
            </Button>
          </div>
        ) : null}
        <ComposerToolbar
          activeEnvironmentName={activeEnvironmentName}
          capabilityControls={
            <>
              <Button
                aria-label="Generate an image"
                className="size-10 rounded-lg p-0 transition-colors hover:bg-accent"
                data-testid="media-image-button"
                disabled={imageModels.length === 0 || composerBlockedBySetup}
                onClick={() => {
                  setMediaKind("image");
                  setMediaDialogOpen(true);
                }}
                size="icon"
                title="Generate an image"
                type="button"
                variant="ghost"
              >
                <ImagePlusIcon className="size-4" />
              </Button>
              <Button
                aria-label="Generate a video"
                className="size-10 rounded-lg p-0 transition-colors hover:bg-accent"
                disabled={videoModels.length === 0 || composerBlockedBySetup}
                onClick={() => {
                  setMediaKind("video");
                  setMediaDialogOpen(true);
                }}
                size="icon"
                title="Generate a video"
                type="button"
                variant="ghost"
              >
                <FilmIcon className="size-4" />
              </Button>
              <Button
                aria-label={
                  autoPlaySpeech
                    ? "Disable automatic response playback"
                    : "Enable automatic response playback"
                }
                className="size-10 rounded-lg p-0 transition-colors hover:bg-accent"
                onClick={() => setAutoPlaySpeech((current) => !current)}
                size="icon"
                title={
                  autoPlaySpeech
                    ? "Disable automatic response playback"
                    : "Enable automatic response playback"
                }
                type="button"
                variant="ghost"
              >
                {autoPlaySpeech ? (
                  <Volume2Icon className="size-4" />
                ) : (
                  <VolumeXIcon className="size-4" />
                )}
              </Button>
              <AttachmentsButton
                disabled={composerBlockedByInteraction || composerBlockedBySetup}
                fileInputRef={fileInputRef}
                selectedModelId={selectedModelId}
              />
              <PromptInputSpeechButton
                className="size-10 rounded-lg p-0 transition-colors hover:bg-accent"
                disabled={composerBlockedByInteraction || composerBlockedBySetup}
                onTranscriptionChange={setInput}
                textareaRef={textareaRef}
              />
            </>
          }
          interactionMode={interactionMode}
          modeDisabled={composerBlockedBySetup}
          modelControl={
            <ModelSelectorCompact
              availableModels={availableModels}
              className="w-full max-w-[140px] sm:max-w-[200px] lg:w-[200px]"
              onModelChange={onModelChange}
              selectedModelId={selectedModelId}
            />
          }
          onInteractionModeChange={onInteractionModeChange}
          primaryAction={
            <ComposerActionButton
              clearError={clearError}
              disabled={primaryActionBlockedBySetup}
              onInterrupt={onInterrupt}
              onSubmit={submitForm}
              presentation={composerPresentation}
              setMessages={setMessages}
            />
          }
        />
      </PromptInput>

      <Dialog
        onOpenChange={(open) => {
          if (!promotionPending) setPromotionOpen(open);
        }}
        open={promotionOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {projectId ? "Add these files to Project Knowledge?" : "Add these files to Organization Knowledge?"}
            </DialogTitle>
            <DialogDescription>
              This publishes the existing files for reusable retrieval. It does not upload another copy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {pendingKnowledgePromotion.map((attachment) => (
              <div
                className="rounded-lg border px-3 py-2 text-sm"
                key={attachment.pathname || attachment.url}
              >
                {attachment.name}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              disabled={promotionPending}
              onClick={() => {
                setPromotionOpen(false);
                setPendingKnowledgePromotion([]);
              }}
              variant="outline"
            >
              Chat only
            </Button>
            <Button
              disabled={promotionPending}
              onClick={async () => {
                if (!beginKnowledgePromotion(promotionSingleFlight)) return;
                setPromotionPending(true);
                try {
                  const uploads = pendingKnowledgePromotion.map((attachment) => ({
                    fileId: attachment.attachmentId,
                    projectId: projectId ?? null,
                  }));
                  const response = await fetch(
                    "/api/knowledge/documents/promote",
                    {
                      method: "POST",
                      headers: {
                        "content-type": "application/json",
                      },
                      body: JSON.stringify({ uploads }),
                    }
                  );
                  const json = await response.json().catch(() => ({}));
                  if (!response.ok) {
                    throw new Error(json.error || "Knowledge import failed.");
                  }
                  toast.success("Added attachments to Knowledge.");
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Knowledge import failed."
                  );
                } finally {
                  finishKnowledgePromotion(promotionSingleFlight);
                  setPromotionPending(false);
                  setPromotionOpen(false);
                  setPendingKnowledgePromotion([]);
                }
              }}
            >
              {projectId ? "Add to Project" : "Add to Organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setMediaDialogOpen} open={mediaDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mediaKind === "image" ? "Generate image" : "Generate video"}
            </DialogTitle>
            <DialogDescription>
              This creates a chat artifact using an approved {mediaKind} model.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <ModelSelectorCompact
              availableModels={
                mediaKind === "image" ? imageModels : videoModels
              }
              onModelChange={setMediaModelId}
              selectedModelId={mediaModelId}
            />
            <Textarea
              className="min-h-28 rounded-xl border border-border p-3"
              data-testid="media-prompt-input"
              onChange={(event) => setMediaPrompt(event.target.value)}
              placeholder={`Describe the ${mediaKind} you want to generate...`}
              value={mediaPrompt}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => setMediaDialogOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              data-testid="media-generate-submit"
              disabled={!(mediaPrompt.trim() && mediaModelId) || mediaBusy}
              onClick={async () => {
                try {
                  setMediaBusy(true);
                  const response = await fetch("/api/media/generate", {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({
                      threadId,
                      kind: mediaKind,
                      prompt: mediaPrompt,
                      modelId: mediaModelId,
                    }),
                  });
                  const json = await response.json().catch(() => ({}));
                  if (!response.ok) {
                    throw new Error(
                      json.error || `Failed to generate ${mediaKind}.`
                    );
                  }
                  const job = json.job as {
                    id: string;
                    artifactId: string | null;
                    status: string;
                    kind: "image" | "video";
                  };
                  if (job.artifactId) {
                    setArtifact({
                      documentId: job.artifactId,
                      title:
                        job.kind === "image"
                          ? "Generated image"
                          : "Generated video",
                      kind: job.kind,
                      content: "",
                      isVisible: true,
                      status: job.status === "succeeded" ? "idle" : "streaming",
                      boundingBox: {
                        top: 0,
                        left: 0,
                        width: 0,
                        height: 0,
                      },
                    });
                  }
                  if (job.status !== "succeeded") {
                    void pollMediaJob(job.id, job.kind);
                  }
                  toast.success(
                    job.status === "succeeded"
                      ? `${mediaKind} generated.`
                      : `${mediaKind} generation started.`
                  );
                  setMediaDialogOpen(false);
                  setMediaPrompt("");
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : `Failed to generate ${mediaKind}.`
                  );
                } finally {
                  setMediaBusy(false);
                }
              }}
            >
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) {
      return false;
    }
    if (prevProps.status !== nextProps.status) {
      return false;
    }
    if (!equal(prevProps.attachments, nextProps.attachments)) {
      return false;
    }
    if (!equal(prevProps.messages, nextProps.messages)) {
      return false;
    }
    if (!equal(prevProps.conversationState, nextProps.conversationState)) {
      return false;
    }
    if (
      prevProps.activeEnvironmentName !== nextProps.activeEnvironmentName ||
      prevProps.modelScopeQuery !== nextProps.modelScopeQuery ||
      prevProps.newTurnDisabledReason !== nextProps.newTurnDisabledReason ||
      prevProps.threadId !== nextProps.threadId
    ) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }
    if (prevProps.selectedModelId !== nextProps.selectedModelId) {
      return false;
    }
    if (prevProps.interactionMode !== nextProps.interactionMode) {
      return false;
    }
    if (prevProps.focusRequest !== nextProps.focusRequest) {
      return false;
    }

    return true;
  }
);

function PureAttachmentsButton({
  disabled,
  fileInputRef,
  selectedModelId,
}: {
  disabled: boolean;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  selectedModelId: string;
}) {
  const isReasoningModel =
    selectedModelId.includes("reasoning") || selectedModelId.includes("think");

  return (
    <Button
      aria-label="Attach files"
      className="size-10 rounded-lg p-0 transition-colors hover:bg-accent"
      data-testid="attachments-button"
      disabled={disabled || isReasoningModel}
      onClick={(event) => {
        event.preventDefault();
        fileInputRef.current?.click();
      }}
      size="icon"
      title="Attach files"
      type="button"
      variant="ghost"
    >
      <PaperclipIcon size={16} style={{ width: 16, height: 16 }} />
    </Button>
  );
}

const AttachmentsButton = memo(PureAttachmentsButton);

function PureModelSelectorCompact({
  availableModels,
  className,
  selectedModelId,
  onModelChange,
}: {
  availableModels: ScopedChatModel[];
  className?: string;
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedModelFallback = buildChatModel(selectedModelId);
  const mergedModels: ScopedChatModel[] = Array.from(
    new Map(
      ([selectedModelFallback, ...availableModels] as ScopedChatModel[]).map(
        (model) => [model.id, model]
      )
    ).values()
  );
  const groupedModels = mergedModels.reduce(
    (acc, model) => {
      const group = model.scope ?? model.provider;
      if (!acc[group]) {
        acc[group] = [];
      }

      acc[group].push(model);
      return acc;
    },
    {} as Record<string, typeof availableModels>
  );

  const selectedModel =
    mergedModels.find((m) => m.id === selectedModelId) ??
    mergedModels.find((m) => m.id === DEFAULT_CHAT_MODEL) ??
    mergedModels[0];
  const [provider] = selectedModel.id.split("/");

  // Provider display names
  const providerNames: Record<string, string> = {
    environment: "Environment models",
    organization: "Organization models",
    platform: "Platform models",
    anthropic: "Anthropic",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    replicate: "Replicate",
    google: "Google",
    xai: "xAI",
    reasoning: "Reasoning",
  };

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          className={cn("h-8 w-[200px] justify-between px-2", className)}
          data-testid="model-selector-trigger"
          type="button"
          variant="ghost"
        >
          {provider && <ModelSelectorLogo provider={provider} />}
          <ModelSelectorName>{selectedModel.name}</ModelSelectorName>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          {Object.entries(
            Object.keys(groupedModels).length > 0
              ? groupedModels
              : modelsByProvider
          ).map(([providerKey, providerModels]) => (
            <ModelSelectorGroup
              heading={providerNames[providerKey] ?? providerKey}
              key={providerKey}
            >
              {providerModels.map((model) => {
                const logoProvider = model.id.split("/")[0];
                return (
                  <ModelSelectorItem
                    key={model.id}
                    onSelect={() => {
                      onModelChange?.(model.id);
                      setCookie("chat-model", model.id);
                      setOpen(false);
                    }}
                    value={model.id}
                  >
                    <ModelSelectorLogo provider={logoProvider} />
                    <ModelSelectorName>{model.name}</ModelSelectorName>
                    {model.id === selectedModel.id && (
                      <CheckIcon className="ml-auto size-4" />
                    )}
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

const ModelSelectorCompact = memo(PureModelSelectorCompact);

function PureComposerActionButton({
  clearError,
  disabled,
  onInterrupt,
  onSubmit,
  presentation,
  setMessages,
}: {
  clearError: () => void;
  disabled?: boolean;
  onInterrupt?: () => Promise<void>;
  onSubmit: () => Promise<void>;
  presentation: ComposerPresentation;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
}) {
  const action = presentation.action;
  const isResetAction = action.kind === "reset";
  const isStopAction = action.kind === "stop";
  const actionLabel = isResetAction
    ? "Reset failed response"
    : isStopAction
      ? "Interrupt agent at the next safe boundary"
      : action.kind === "queue"
        ? "Queue message"
        : action.kind === "respond"
          ? "Send response"
          : "Send message";

  return (
    <Button
      aria-label={actionLabel}
      className={cn(
        "size-10 rounded-full p-0 transition-colors duration-200 disabled:bg-muted disabled:text-muted-foreground",
        isStopAction
          ? "bg-background text-foreground hover:bg-accent"
          : isResetAction
            ? "bg-foreground text-background hover:bg-foreground/90"
            : "bg-primary text-primary-foreground hover:bg-primary/90"
      )}
      data-testid={
        isStopAction
          ? "stop-button"
          : isResetAction
            ? "reset-button"
            : "send-button"
      }
      disabled={action.disabled || disabled}
      onClick={(event) => {
        event.preventDefault();
        if (isResetAction) {
          clearError();
          setMessages((messages) => messages);
          return;
        }
        if (isStopAction) {
          void onInterrupt?.();
          return;
        }
        void onSubmit();
      }}
      size="icon"
      title={actionLabel}
      type="button"
      variant={isStopAction ? "outline" : "default"}
    >
      {isStopAction ? (
        <StopIcon size={14} />
      ) : isResetAction ? (
        <RotateCcwIcon size={16} />
      ) : (
        <ArrowUpIcon size={16} />
      )}
    </Button>
  );
}

const ComposerActionButton = memo(PureComposerActionButton);
