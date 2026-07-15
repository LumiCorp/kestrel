"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import equal from "fast-deep-equal";
import {
  CheckIcon,
  FilmIcon,
  ImagePlusIcon,
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
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn, generateUUID } from "@/lib/utils";
import { PromptInputSpeechButton } from "./ai-elements/prompt-input";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "./elements/prompt-input";
import { ArrowUpIcon, PaperclipIcon, StopIcon } from "./icons";
import { PreviewAttachment } from "./preview-attachment";
import { SuggestedActions } from "./suggested-actions";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import type { VisibilityType } from "./visibility-selector";

type ScopedChatModel = ChatModel & {
  scope?: "environment" | "organization" | "platform";
};

type ComposerActivity = {
  label: string;
  tone: "ready" | "working" | "streaming" | "attention" | "error";
};

function getComposerActivity(input: {
  messages: UIMessage[];
  status: UseChatHelpers<ChatMessage>["status"];
  conversationState: ThreadConversationState;
}): ComposerActivity | null {
  const activeTurn = input.conversationState.turns.find(
    (turn) => turn.id === input.conversationState.queue.activeTurnId
  );
  const pendingInteraction = input.conversationState.interactions.find(
    (interaction) => interaction.status === "pending"
  );
  const queuedCount = input.conversationState.turns.filter(
    (turn) => turn.status === "queued"
  ).length;

  if (pendingInteraction) {
    return {
      label:
        pendingInteraction.kind === "approval" ||
        pendingInteraction.kind === "mcp_sampling"
          ? "Waiting for approval"
          : "Waiting for your response",
      tone: "attention",
    };
  }

  if (activeTurn?.cancelRequestedAt) {
    return {
      label: "Interrupt requested · stopping at a safe boundary",
      tone: "attention",
    };
  }

  if (input.status === "error") {
    return {
      label: "Agent error",
      tone: "error",
    };
  }

  if (input.conversationState.queue.pauseReason === "turn_failed") {
    return {
      label: "Agent failed · queue paused",
      tone: "error",
    };
  }

  if (input.conversationState.queue.pauseReason === "turn_cancelled") {
    return {
      label: "Turn interrupted · queue paused",
      tone: "attention",
    };
  }

  if (activeTurn && input.status === "ready") {
    return {
      label:
        queuedCount > 0
          ? `Agent working · ${queuedCount} queued`
          : "Agent working",
      tone: "working",
    };
  }

  if (input.status === "ready") {
    return { label: "Ready", tone: "ready" };
  }

  const latestAssistantMessage = [...input.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const parts = latestAssistantMessage?.parts ?? [];

  const activeToolPart = [...parts].reverse().find((part) => {
    if (
      !(
        (part.type === "dynamic-tool" || part.type.startsWith("tool-")) &&
        "state" in part
      )
    ) {
      return false;
    }

    if (typeof part.state !== "string") {
      return false;
    }

    return [
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
    ].includes(part.state);
  });

  if (
    activeToolPart &&
    "state" in activeToolPart &&
    activeToolPart.state === "approval-requested"
  ) {
    return {
      label: "Waiting for approval",
      tone: "attention",
    };
  }

  if (activeToolPart) {
    switch (activeToolPart.type) {
      case "tool-searchKnowledgeDocuments":
        return {
          label: "Searching documents",
          tone: "working",
        };
      case "tool-bash":
      case "tool-bash_batch":
        return {
          label: "Inspecting sources",
          tone: "working",
        };
      case "tool-requestSuggestions":
        return {
          label: "Generating suggestions",
          tone: "working",
        };
      case "tool-createDocument":
      case "tool-updateDocument":
        return {
          label: "Updating document",
          tone: "working",
        };
      default:
        return {
          label: "Agent working",
          tone: "working",
        };
    }
  }

  const hasStreamingReasoning = parts.some(
    (part) =>
      part.type === "reasoning" && "state" in part && part.state === "streaming"
  );

  if (hasStreamingReasoning || input.status === "submitted") {
    return {
      label: "Thinking",
      tone: "working",
    };
  }

  if (input.status === "streaming") {
    return {
      label: "Writing answer",
      tone: "streaming",
    };
  }

  return {
    label: "Agent working",
    tone: "working",
  };
}

function ComposerActivityRibbon({
  activity,
  queueVersion,
}: {
  activity: ComposerActivity | null;
  queueVersion: number;
}) {
  if (!activity) {
    return null;
  }

  const trackClassName = {
    ready: "bg-transparent",
    working: "bg-primary/12",
    streaming: "bg-sky-500/12",
    attention: "bg-amber-500/15",
    error: "bg-destructive/15",
  }[activity.tone];

  const coreClassName = {
    ready: "from-transparent via-transparent to-transparent",
    working:
      "from-transparent via-primary/95 to-transparent shadow-[0_0_12px_rgba(0,108,255,0.7)]",
    streaming:
      "from-transparent via-sky-400/95 to-transparent shadow-[0_0_14px_rgba(56,189,248,0.8)]",
    attention:
      "from-transparent via-amber-400/95 to-transparent shadow-[0_0_14px_rgba(251,191,36,0.8)]",
    error:
      "from-transparent via-red-500/95 to-transparent shadow-[0_0_14px_rgba(239,68,68,0.8)]",
  }[activity.tone];

  return (
    <>
      <span aria-live="polite" className="sr-only" role="status">
        {activity.label}
      </span>
      <div
        className="px-2 pb-1 text-muted-foreground text-xs"
        data-queue-version={queueVersion}
        data-testid="composer-state"
      >
        {activity.label}
      </div>
      {activity.tone === "ready" ? null : (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-3 top-0 z-10 h-[2px] overflow-hidden rounded-full",
            trackClassName
          )}
        >
          <div
            className={cn(
              "composer-agent-ribbon-sweep absolute inset-y-[-2px] left-[-34%] w-[30%] rounded-full bg-gradient-to-r blur-[4px]",
              coreClassName
            )}
          />
          <div
            className={cn(
              "composer-agent-ribbon-sweep absolute inset-y-0 left-[-22%] w-[18%] rounded-full bg-gradient-to-r",
              coreClassName
            )}
          />
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
  className,
  selectedVisibilityType,
  selectedModelId,
  onModelChange,
  activeEnvironmentName,
  modelScopeQuery,
}: {
  threadId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  clearError: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  queueMessage?: (message: ChatMessage) => void;
  conversationState: ThreadConversationState;
  onInterrupt?: () => Promise<void>;
  className?: string;
  selectedVisibilityType: VisibilityType;
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
  activeEnvironmentName?: string;
  modelScopeQuery?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();
  const { setArtifact } = useArtifact();

  const adjustHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "44px";
    }
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight();
    }
  }, [adjustHeight]);

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

  const resetHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "44px";
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
      adjustHeight();
    }
    // Only run once after hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustHeight, localStorageInput, setInput]);

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
  const [uploadQueue, setUploadQueue] = useState<string[]>([]);
  const composerActivity = useMemo(
    () =>
      getComposerActivity({
        messages,
        status,
        conversationState,
      }),
    [conversationState, messages, status]
  );
  const activeTurn = conversationState.turns.find(
    (turn) => turn.id === conversationState.queue.activeTurnId
  );

  const submitForm = useCallback(() => {
    const liveInputValue = textareaRef.current?.value ?? input;

    if (!liveInputValue.trim() && attachments.length === 0) {
      return;
    }

    if (status === "error") {
      clearError();
      return;
    }

    const message: ChatMessage = {
      id: generateUUID(),
      role: "user",
      parts: [
        ...attachments.map((attachment) => ({
          type: "file" as const,
          url: attachment.url,
          name: attachment.name,
          mediaType: attachment.contentType,
        })),
        {
          type: "text",
          text: liveInputValue,
        },
      ],
    };

    if (status === "submitted" || status === "streaming") {
      if (!queueMessage) {
        return;
      }
      queueMessage(message);
    } else {
      sendMessage(message);
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
  ]);

  const uploadFile = useCallback(
    async (file: File): Promise<Attachment | undefined> => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("threadId", threadId);

      try {
        const response = await fetch(`/api/threads/${threadId}/uploads`, {
          method: "PUT",
          body: formData,
        });

        if (response.ok) {
          const data = await response.json();
          const { url, pathname, contentType, knowledgeEligible, name } = data;

          return {
            url,
            name: name || pathname,
            contentType,
            pathname,
            knowledgeEligible: Boolean(knowledgeEligible),
          };
        }
        const { error } = await response.json();
        toast.error(error);
      } catch (_error) {
        toast.error("Failed to upload file, please try again!");
      }
    },
    [threadId]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);

      setUploadQueue(files.map((file) => file.name));

      try {
        const uploadPromises = files.map((file) => uploadFile(file));
        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment): attachment is Attachment => Boolean(attachment)
        );
        const promotionCandidates = successfullyUploadedAttachments.filter(
          (attachment): attachment is Attachment =>
            Boolean(attachment.knowledgeEligible && attachment.pathname)
        );

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...successfullyUploadedAttachments,
        ]);

        if (promotionCandidates.length > 0) {
          setPendingKnowledgePromotion(promotionCandidates);
          setPromotionOpen(true);
        }
      } catch (error) {
        console.error("Error uploading files!", error);
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, uploadFile]
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
        setUploadQueue((prev) => [
          ...prev,
          ...fileItems.map((file) => file.name),
        ]);

        try {
          const uploadedAttachments = await Promise.all(
            fileItems.map((file) => uploadFile(file))
          );
          const successfullyUploadedAttachments = uploadedAttachments.filter(
            (attachment): attachment is Attachment => Boolean(attachment)
          );
          const promotionCandidates = successfullyUploadedAttachments.filter(
            (attachment) => attachment.knowledgeEligible && attachment.pathname
          );

          setAttachments((curr) => [
            ...curr,
            ...successfullyUploadedAttachments,
          ]);

          if (promotionCandidates.length > 0) {
            setPendingKnowledgePromotion(promotionCandidates);
            setPromotionOpen(true);
          }
        } catch (error) {
          console.error("Error uploading pasted files:", error);
          toast.error("Failed to upload pasted files");
        } finally {
          setUploadQueue([]);
        }

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
    [input, setAttachments, setInput, uploadFile]
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
        sendMessage({
          role: "user",
          parts: [{ type: "text", text: suggestion.prompt }],
        });
        return;
      }

      setMediaKind(suggestion.mediaKind);
      setMediaPrompt(suggestion.prompt);
      setMediaDialogOpen(true);
    },
    [sendMessage]
  );

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      {messages.length === 0 &&
        attachments.length === 0 &&
        uploadQueue.length === 0 &&
        mediaModelsResolved &&
        toolCapabilitiesResolved && (
          <SuggestedActions
            imageEnabled={imageModels.length > 0}
            knowledgeEnabled={knowledgeEnabled}
            onSuggestionSelect={handleSuggestedAction}
            selectedVisibilityType={selectedVisibilityType}
            sendMessage={sendMessage}
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
        onSubmit={(event) => {
          event.preventDefault();
          submitForm();
        }}
      >
        <ComposerActivityRibbon
          activity={composerActivity}
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
                key={attachment.url}
                onRemove={() => {
                  setAttachments((currentAttachments) =>
                    currentAttachments.filter((a) => a.url !== attachment.url)
                  );
                  if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                  }
                }}
              />
            ))}

            {uploadQueue.map((filename) => (
              <PreviewAttachment
                attachment={{
                  url: "",
                  name: filename,
                  contentType: "",
                }}
                isUploading={true}
                key={filename}
              />
            ))}
          </div>
        )}
        <div className="flex flex-row items-start gap-1 sm:gap-2">
          <PromptInputTextarea
            className="grow resize-none border-0! border-none! bg-transparent p-2 text-base outline-none ring-0 [-ms-overflow-style:none] [scrollbar-width:none] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 [&::-webkit-scrollbar]:hidden"
            data-testid="multimodal-input"
            disableAutoResize={true}
            maxHeight={200}
            minHeight={44}
            onChange={handleInput}
            onSubmitOnEnter={submitForm}
            placeholder="Send a message..."
            ref={textareaRef}
            rows={1}
            value={input}
          />
        </div>
        <PromptInputToolbar className="border-top-0! border-t-0! p-0 shadow-none dark:border-0 dark:border-transparent!">
          <PromptInputTools className="gap-0 sm:gap-0.5">
            {activeEnvironmentName ? (
              <span className="hidden max-w-40 truncate rounded-md border px-2 py-1 text-muted-foreground text-xs sm:inline">
                Environment: {activeEnvironmentName}
              </span>
            ) : null}
            <AttachmentsButton
              fileInputRef={fileInputRef}
              selectedModelId={selectedModelId}
              status={status}
            />
            <PromptInputSpeechButton
              className="aspect-square h-8 rounded-lg p-1 transition-colors hover:bg-accent"
              disabled={status !== "ready"}
              onTranscriptionChange={setInput}
              textareaRef={textareaRef}
            />
            <ModelSelectorCompact
              availableModels={availableModels}
              onModelChange={onModelChange}
              selectedModelId={selectedModelId}
            />
            <Button
              aria-label="Generate an image"
              className="aspect-square h-8 rounded-lg p-1 transition-colors hover:bg-accent"
              data-testid="media-image-button"
              disabled={imageModels.length === 0}
              onClick={() => {
                setMediaKind("image");
                setMediaDialogOpen(true);
              }}
              type="button"
              variant="ghost"
            >
              <ImagePlusIcon className="size-4" />
            </Button>
            <Button
              aria-label="Generate a video"
              className="aspect-square h-8 rounded-lg p-1 transition-colors hover:bg-accent"
              disabled={videoModels.length === 0}
              onClick={() => {
                setMediaKind("video");
                setMediaDialogOpen(true);
              }}
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
              className="aspect-square h-8 rounded-lg p-1 transition-colors hover:bg-accent"
              onClick={() => setAutoPlaySpeech((current) => !current)}
              type="button"
              variant="ghost"
            >
              {autoPlaySpeech ? (
                <Volume2Icon className="size-4" />
              ) : (
                <VolumeXIcon className="size-4" />
              )}
            </Button>
          </PromptInputTools>

          {status === "error" ? (
            <ComposerActionButton
              clearError={clearError}
              setMessages={setMessages}
              status={status}
            />
          ) : (
            <>
              {activeTurn && onInterrupt ? (
                <Button
                  aria-label="Interrupt agent at the next safe boundary"
                  className="size-8 rounded-full"
                  disabled={Boolean(activeTurn.cancelRequestedAt)}
                  onClick={() => void onInterrupt()}
                  title="Interrupt at the next safe boundary"
                  type="button"
                  variant="outline"
                >
                  <StopIcon size={14} />
                </Button>
              ) : null}
              <PromptInputSubmit
                className="size-8 rounded-full bg-primary text-primary-foreground transition-colors duration-200 hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
                data-testid="send-button"
                disabled={
                  (!input.trim() && attachments.length === 0) ||
                  uploadQueue.length > 0 ||
                  ((status === "submitted" || status === "streaming") &&
                    !queueMessage)
                }
                onClick={submitForm}
                status={status}
              >
                <ArrowUpIcon size={14} />
              </PromptInputSubmit>
            </>
          )}
        </PromptInputToolbar>
      </PromptInput>

      <Dialog onOpenChange={setPromotionOpen} open={promotionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add these files to Knowledge too?</DialogTitle>
            <DialogDescription>
              These files are already attached to the chat. You can also import
              them into the Knowledge Library for reusable retrieval.
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
              onClick={() => {
                setPromotionOpen(false);
                setPendingKnowledgePromotion([]);
              }}
              variant="outline"
            >
              Chat only
            </Button>
            <Button
              onClick={async () => {
                try {
                  const uploads = pendingKnowledgePromotion
                    .map((attachment) => attachment.pathname)
                    .filter((pathname): pathname is string => Boolean(pathname))
                    .map((pathname) => ({ pathname }));
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
                  setPromotionOpen(false);
                  setPendingKnowledgePromotion([]);
                }
              }}
            >
              Chat + Knowledge
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

    return true;
  }
);

function PureAttachmentsButton({
  fileInputRef,
  status,
  selectedModelId,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  status: UseChatHelpers<ChatMessage>["status"];
  selectedModelId: string;
}) {
  const isReasoningModel =
    selectedModelId.includes("reasoning") || selectedModelId.includes("think");

  return (
    <Button
      className="aspect-square h-8 rounded-lg p-1 transition-colors hover:bg-accent"
      data-testid="attachments-button"
      disabled={status !== "ready" || isReasoningModel}
      onClick={(event) => {
        event.preventDefault();
        fileInputRef.current?.click();
      }}
      type="button"
      variant="ghost"
    >
      <PaperclipIcon size={14} style={{ width: 14, height: 14 }} />
    </Button>
  );
}

const AttachmentsButton = memo(PureAttachmentsButton);

function PureModelSelectorCompact({
  availableModels,
  selectedModelId,
  onModelChange,
}: {
  availableModels: ScopedChatModel[];
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
          className="h-8 w-[200px] justify-between px-2"
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
  status,
  clearError,
  setMessages,
}: {
  status: UseChatHelpers<ChatMessage>["status"];
  clearError: () => void;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
}) {
  const isResetAction = status === "error";

  if (!isResetAction) {
    return null;
  }

  return (
    <Button
      aria-label="Reset failed response"
      className="size-7 rounded-full bg-foreground p-1 text-background transition-colors duration-200 hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
      data-testid="reset-button"
      onClick={(event) => {
        event.preventDefault();
        clearError();
        setMessages((messages) => messages);
      }}
      type="button"
    >
      <StopIcon size={14} />
    </Button>
  );
}

const ComposerActionButton = memo(PureComposerActionButton);
