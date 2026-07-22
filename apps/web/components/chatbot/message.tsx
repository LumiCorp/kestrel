"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { ActivityIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ThreadTurnView } from "@/lib/turns/client-contract";
import type { ChatMessage, MessageFeedback } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import { MessageContent } from "./elements/message";
import { Response } from "./elements/response";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "./elements/tool";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { MessageEditor } from "./message-editor";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";
import { Weather, type WeatherAtLocation } from "./weather";

type ToolLikePart = Extract<ChatMessage["parts"][number], { type: string }> & {
  type: string;
  state?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: {
    id: string;
    approved?: boolean;
    reason?: string;
  };
};

const isToolLikePart = (
  part: ChatMessage["parts"][number]
): part is ToolLikePart =>
  part.type === "dynamic-tool" || part.type.startsWith("tool-");

const isIncompleteToolState = (state: string | undefined) =>
  state === "input-streaming" || state === "input-available";

function renderStructuredData(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }

  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const isKestrelPresentationPart = (part: ChatMessage["parts"][number]) =>
  part.type.startsWith("data-kestrel-");

function turnActivityLabel(status: ThreadTurnView["status"] | undefined) {
  if (status === "queued") return "Activity details · Queued";
  if (status === "running") return "Activity details · Working";
  if (status === "waiting_for_input")
    return "Activity details · Needs response";
  if (status === "completed") return "Activity details · Completed";
  if (status === "failed") return "Activity details · Failed";
  if (status === "cancelled") return "Activity details · Interrupted";
  return "Activity details";
}

const shouldRenderActivityDetail = (part: ChatMessage["parts"][number]) => {
  if (!isKestrelPresentationPart(part)) return false;
  if (
    part.type === "data-kestrel-agent-progress" ||
    part.type === "data-kestrel-citation" ||
    part.type === "data-kestrel-artifact"
  ) {
    return false;
  }
  if (part.type !== "data-kestrel-provider-reasoning") return true;
  return (
    part.data.event === "unavailable" ||
    (part.data.event === "delta" &&
      part.data.contentState === "live" &&
      Boolean(part.data.delta))
  );
};

export function KestrelActivityTimeline({
  parts,
  isLoading,
  turnStatus,
}: {
  parts: ChatMessage["parts"];
  isLoading: boolean;
  turnStatus?: ThreadTurnView["status"];
}) {
  const agentProgressParts = parts.filter(
    (part) => part.type === "data-kestrel-agent-progress",
  );
  const detailParts = parts.filter(shouldRenderActivityDetail);
  if (agentProgressParts.length === 0 && detailParts.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="kestrel-activity-timeline">
      {agentProgressParts.length > 0 ? (
        <section className="not-prose" data-testid="kestrel-agent-progress">
          <div className="flex items-center gap-1 px-2 py-1 text-muted-foreground text-xs">
            <ActivityIcon className="size-3.5" />
            <span>Agent progress</span>
            {isLoading ? (
              <span
                aria-label="Agent is working"
                className="ml-1 size-1.5 animate-pulse rounded-full bg-primary"
              />
            ) : null}
          </div>
          <ol className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-2.5 text-muted-foreground text-xs leading-relaxed">
            {agentProgressParts.map((part) => (
              <li className="whitespace-pre-wrap" key={part.data.id}>
                {part.data.text}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {detailParts.length > 0 ? (
        <details className="rounded-lg border bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 font-medium text-muted-foreground text-xs">
            {turnActivityLabel(turnStatus)}
          </summary>
          <ol className="space-y-2 border-t px-3 py-3 text-xs">
            {detailParts.map((part, index) => {
              const key = `timeline-${index}`;
              if (part.type === "data-kestrel-progress") {
                return (
                  <li key={key}>
                    <span className="font-medium">{part.data.phase}</span>
                    <span className="ml-2 text-muted-foreground">
                      {part.data.text}
                    </span>
                  </li>
                );
              }
              if (part.type === "data-kestrel-provider-reasoning") {
                if (part.data.event === "unavailable") {
                  return (
                    <li key={key}>
                      <span className="font-medium">Provider reasoning</span>
                      <span className="ml-2 text-muted-foreground">
                        Unavailable for this model
                      </span>
                    </li>
                  );
                }
                if (
                  part.data.event !== "delta" ||
                  part.data.contentState !== "live" ||
                  !part.data.delta
                ) {
                  return null;
                }
                return (
                  <li className="whitespace-pre-wrap" key={key}>
                    <span className="font-medium">{part.data.label}</span>
                    <span className="ml-2 text-muted-foreground">
                      {part.data.delta}
                    </span>
                  </li>
                );
              }
              if (part.type === "data-kestrel-tool") {
                return (
                  <li key={key}>
                    <span className="font-medium">
                      {part.data.displayName ?? part.data.toolName}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {part.data.phase === "started"
                        ? "Started"
                        : part.data.phase === "completed"
                          ? "Completed"
                          : (part.data.error?.message ?? "Failed")}
                    </span>
                  </li>
                );
              }
              if (part.type === "data-kestrel-citation") {
                return null;
              }
              if (part.type === "data-kestrel-artifact") {
                return null;
              }
              if (part.type === "data-kestrel-interaction") {
                return (
                  <li key={key}>
                    <span className="font-medium">Response requested</span>
                    <span className="ml-2 text-muted-foreground">
                      {part.data.status === "pending"
                        ? "Waiting for you"
                        : part.data.status === "resolved"
                          ? "Response received"
                          : "Cancelled"}
                    </span>
                  </li>
                );
              }
              if (part.type === "data-kestrel-status") {
                const failed = [
                  "failed",
                  "cancelled",
                  "contract_failure",
                ].includes(part.data.status);
                return (
                  <li
                    className={
                      failed ? "text-destructive" : "text-muted-foreground"
                    }
                    key={key}
                    role={failed ? "alert" : undefined}
                  >
                    {part.data.status === "contract_failure"
                      ? "Response contract failed"
                      : part.data.status === "waiting"
                        ? "Paused for your response"
                        : part.data.status === "completed"
                          ? "Run segment completed"
                          : part.data.status.replaceAll("_", " ")}
                    {part.data.errorMessage
                      ? `: ${part.data.errorMessage}`
                      : ""}
                  </li>
                );
              }
              return null;
            })}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

function renderGenericToolPart(input: {
  part: ToolLikePart;
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  isLoading: boolean;
  customOutput?: ReactNode;
  deniedDescription?: string;
}) {
  const {
    part,
    addToolApprovalResponse,
    isLoading,
    customOutput,
    deniedDescription,
  } = input;
  const key = part.toolCallId ?? `${part.type}-${part.state ?? "tool"}`;
  const approvalId = part.approval?.id;
  const isDenied =
    part.state === "output-denied" ||
    (part.state === "approval-responded" && part.approval?.approved === false);
  const shouldRenderInput =
    part.input !== undefined &&
    part.state !== "input-streaming" &&
    part.state !== "output-denied";

  let output: ReactNode = null;
  let errorText: string | undefined;

  if (isDenied) {
    output = (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        {deniedDescription ?? "This tool call was denied."}
      </div>
    );
  } else if (
    part.state === "approval-responded" &&
    part.approval?.approved === true
  ) {
    output = (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        Approval recorded. Waiting for the tool to continue.
      </div>
    );
  } else if (part.state === "output-error") {
    errorText = part.errorText ?? "The tool returned an error.";
  } else if (part.state === "output-available") {
    output =
      customOutput ??
      ("error" in ((part.output ?? {}) as Record<string, unknown>) ? (
        <div className="rounded border p-2 text-red-500">
          Error:{" "}
          {String(
            ((part.output ?? {}) as Record<string, unknown>).error ??
              "Unknown tool error"
          )}
        </div>
      ) : (
        renderStructuredData(part.output)
      ));
  } else if (!isLoading && isIncompleteToolState(part.state)) {
    output = (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        This tool call did not finish. Regenerate the response to retry it.
      </div>
    );
  }

  return (
    <Tool defaultOpen={true} key={key}>
      <ToolHeader
        state={(part.state ?? "input-streaming") as never}
        type={part.type as never}
      />
      <ToolContent>
        {shouldRenderInput ? <ToolInput input={part.input} /> : null}
        {part.state === "approval-requested" && approvalId ? (
          <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
            <button
              className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => {
                addToolApprovalResponse({
                  id: approvalId,
                  approved: false,
                  reason: `User denied ${part.type}`,
                });
              }}
              type="button"
            >
              Deny
            </button>
            <button
              className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
              onClick={() => {
                addToolApprovalResponse({
                  id: approvalId,
                  approved: true,
                });
              }}
              type="button"
            >
              Allow
            </button>
          </div>
        ) : null}
        {errorText || output ? (
          <ToolOutput errorText={errorText} output={output} />
        ) : null}
      </ToolContent>
    </Tool>
  );
}

const PurePreviewMessage = ({
  addToolApprovalResponse,
  threadId,
  message,
  feedback,
  onFeedbackChange,
  isLoading,
  setMessages,
  regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  hideKestrelActivity = false,
  shouldAutoplaySpeech = false,
  selectedLanguageModelId,
  ttsAvailable = true,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  threadId: string;
  message: ChatMessage;
  feedback: MessageFeedback | undefined;
  onFeedbackChange: (
    messageId: string,
    feedback: "positive" | "negative" | null
  ) => void;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  hideKestrelActivity?: boolean;
  shouldAutoplaySpeech?: boolean;
  selectedLanguageModelId?: string;
  ttsAvailable?: boolean;
}) => {
  const [mode, setMode] = useState<"view" | "edit">("view");

  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );
  const kestrelPresentationParts = message.parts.filter(
    isKestrelPresentationPart
  );

  useDataStream();

  return (
    <div
      className="group/message fade-in w-full animate-in duration-200"
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn("flex w-full items-start gap-2 md:gap-3", {
          "justify-end": message.role === "user" && mode !== "edit",
          "justify-start": message.role === "assistant",
        })}
      >
        {message.role === "assistant" && (
          <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
            <SparklesIcon size={14} />
          </div>
        )}

        <div
          className={cn("flex flex-col", {
            "gap-2 md:gap-4": message.parts?.some(
              (p) => p.type === "text" && p.text?.trim()
            ),
            "w-full":
              (message.role === "assistant" &&
                (message.parts?.some(
                  (p) => p.type === "text" && p.text?.trim()
                ) ||
                  message.parts?.some((p) => isToolLikePart(p)) ||
                  message.parts?.some((p) => isKestrelPresentationPart(p)))) ||
              mode === "edit",
            "max-w-[calc(100%-2.5rem)] sm:max-w-[min(fit-content,80%)]":
              message.role === "user" && mode !== "edit",
            "max-w-3xl md:max-w-[48rem]":
              message.role === "assistant" && mode !== "edit",
          })}
        >
          {message.role === "user" && message.metadata?.authorName && (
            <p className="px-1 text-right text-muted-foreground text-xs">
              {message.metadata.authorName}
            </p>
          )}
          {message.role === "user" && message.metadata?.deliveryState && (
            <p
              className="px-1 text-right text-muted-foreground text-xs"
              data-testid="message-delivery-state"
            >
              {message.metadata.deliveryState === "sending"
                ? "Adding to queue…"
                : "Queued — runs next"}
            </p>
          )}
          {attachmentsFromMessage.length > 0 && (
            <div
              className="flex flex-row justify-end gap-2"
              data-testid={"message-attachments"}
            >
              {attachmentsFromMessage.map((attachment) => (
                <PreviewAttachment
                  attachment={{
                    name: attachment.filename ?? "file",
                    contentType: attachment.mediaType,
                    url: attachment.url,
                  }}
                  key={attachment.url}
                />
              ))}
            </div>
          )}

          {message.role === "assistant" && !hideKestrelActivity ? (
            <KestrelActivityTimeline
              isLoading={isLoading}
              parts={kestrelPresentationParts}
            />
          ) : null}

          {message.parts?.map((part, index) => {
            const { type } = part;
            const key = `message-${message.id}-part-${index}`;

            if (part.type === "data-kestrel-citation") {
              return (
                <aside
                  className="rounded-lg border bg-muted/20 px-3 py-2 text-sm"
                  key={key}
                >
                  <span className="font-medium">Knowledge source</span>{" "}
                  {part.data.url ? (
                    <a
                      className="underline underline-offset-2"
                      href={part.data.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {part.data.title}
                    </a>
                  ) : (
                    <span>{part.data.title}</span>
                  )}
                </aside>
              );
            }

            if (part.type === "data-kestrel-artifact") {
              return (
                <aside
                  className="rounded-lg border bg-muted/20 px-3 py-2 text-sm"
                  key={key}
                >
                  <span className="font-medium">Artifact</span>{" "}
                  {part.data.url ? (
                    <a
                      className="underline underline-offset-2"
                      href={part.data.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {part.data.title}
                    </a>
                  ) : (
                    <span>{part.data.title}</span>
                  )}
                </aside>
              );
            }

            if (part.type === "data-kestrel-dialog-message") {
              const dialog = part.data;
              return (
                <div
                  className="space-y-1"
                  data-dialog-id={dialog.dialogId}
                  data-testid="dialog-message"
                  key={key}
                >
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="font-semibold">
                      {dialog.sender === "collaborator" ? dialog.name : dialog.sender === "kestrel" ? "Kestrel" : "System"}
                    </span>
                  </div>
                  <div className={dialog.status === "failed" ? "whitespace-pre-wrap text-destructive" : "whitespace-pre-wrap"}>
                    {dialog.text}
                  </div>
                </div>
              );
            }

            if (isKestrelPresentationPart(part)) {
              return null;
            }

            if (type === "reasoning") {
              const hasContent = part.text?.trim().length > 0;
              if (hasContent) {
                const isStreaming =
                  "state" in part && part.state === "streaming";
                return (
                  <MessageReasoning
                    isLoading={isLoading || isStreaming}
                    key={key}
                    reasoning={part.text}
                    terminalStatus={message.metadata?.kestrelTerminalStatus}
                  />
                );
              }
            }

            if (type === "text") {
              if (mode === "view") {
                return (
                  <div key={key}>
                    <MessageContent
                      className={cn({
                        "wrap-break-word w-fit rounded-2xl bg-message-user px-3 py-2 text-right text-message-user-foreground":
                          message.role === "user",
                        "max-w-none bg-transparent px-0 py-0 text-left":
                          message.role === "assistant",
                      })}
                      data-testid="message-content"
                    >
                      <Response
                        className={cn({
                          "text-pretty": message.role === "assistant",
                          "text-message-user-foreground":
                            message.role === "user",
                        })}
                      >
                        {sanitizeText(part.text)}
                      </Response>
                    </MessageContent>
                  </div>
                );
              }

              if (mode === "edit") {
                return (
                  <div
                    className="flex w-full flex-row items-start gap-3"
                    key={key}
                  >
                    <div className="size-8" />
                    <div className="min-w-0 flex-1">
                      <MessageEditor
                        key={message.id}
                        message={message}
                        regenerate={regenerate}
                        setMessages={setMessages}
                        setMode={setMode}
                      />
                    </div>
                  </div>
                );
              }
            }

            if (isToolLikePart(part)) {
              let customOutput: ReactNode | undefined;
              let deniedDescription: string | undefined;
              const widthClass =
                type === "tool-getWeather" ? "w-[min(100%,450px)]" : undefined;

              if (
                type === "tool-getWeather" &&
                part.state === "output-available"
              ) {
                customOutput = (
                  <Weather
                    weatherAtLocation={part.output as WeatherAtLocation}
                  />
                );
                deniedDescription = "Weather lookup was denied.";
              }

              if (
                type === "tool-createDocument" &&
                part.state === "output-available" &&
                part.output &&
                !("error" in (part.output as Record<string, unknown>))
              ) {
                customOutput = (
                  <DocumentPreview
                    isReadonly={isReadonly}
                    result={part.output}
                  />
                );
              }

              if (
                type === "tool-updateDocument" &&
                part.state === "output-available" &&
                part.output &&
                !("error" in (part.output as Record<string, unknown>))
              ) {
                customOutput = (
                  <div className="relative">
                    <DocumentPreview
                      args={{
                        ...(part.output as Record<string, unknown>),
                        isUpdate: true,
                      }}
                      isReadonly={isReadonly}
                      result={part.output}
                    />
                  </div>
                );
              }

              if (
                type === "tool-requestSuggestions" &&
                part.state === "output-available" &&
                part.output &&
                !("error" in (part.output as Record<string, unknown>))
              ) {
                const suggestionResult = part.output as {
                  id: string;
                  title: string;
                  kind: "text" | "code" | "image" | "sheet" | "video";
                };
                customOutput = (
                  <DocumentToolResult
                    isReadonly={isReadonly}
                    result={suggestionResult}
                    type="request-suggestions"
                  />
                );
              }

              if (
                type === "tool-searchKnowledgeDocuments" &&
                part.state === "output-available" &&
                part.output &&
                "results" in (part.output as Record<string, unknown>)
              ) {
                const results = Array.isArray(
                  (part.output as { results?: unknown[] }).results
                )
                  ? (part.output as { results: Array<Record<string, any>> })
                      .results
                  : [];
                customOutput = (
                  <div className="space-y-3 p-3">
                    {results.length > 0 ? (
                      results.map((result) => (
                        <div
                          className="rounded border bg-background p-3"
                          key={result.documentId}
                        >
                          <div className="font-medium text-sm">
                            <a
                              className="underline"
                              href={result.url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {result.title || result.filename}
                            </a>
                          </div>
                          <div className="mt-1 text-muted-foreground text-xs">
                            score {Number(result.maxScore ?? 0).toFixed(3)} ·{" "}
                            {result.excerptCount} relevant excerpt
                            {result.excerptCount === 1 ? "" : "s"}
                          </div>
                          <div className="mt-2 space-y-2 text-xs">
                            {Array.isArray(result.excerpts) &&
                            result.excerpts.length > 0 ? (
                              result.excerpts.map(
                                (excerpt: Record<string, any>) => (
                                  <div
                                    className="rounded bg-muted/40 p-2"
                                    key={`${result.documentId}-${excerpt.chunkIndex}`}
                                  >
                                    <div className="text-muted-foreground">
                                      excerpt score{" "}
                                      {Number(excerpt.score ?? 0).toFixed(3)}
                                      {excerpt.pageNumber
                                        ? ` · page ${excerpt.pageNumber}`
                                        : ""}
                                      {excerpt.sectionTitle
                                        ? ` · ${excerpt.sectionTitle}`
                                        : ""}
                                    </div>
                                    <div className="mt-1 whitespace-pre-wrap">
                                      {excerpt.text}
                                    </div>
                                  </div>
                                )
                              )
                            ) : (
                              <div className="text-muted-foreground">
                                No excerpts returned.
                              </div>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                            {Array.isArray(result.citations)
                              ? result.citations.map(
                                  (citation: Record<string, any>) => (
                                    <a
                                      className="rounded border px-2 py-1 underline"
                                      href={citation.url}
                                      key={`${result.documentId}-${citation.label}`}
                                      rel="noreferrer"
                                      target="_blank"
                                    >
                                      {citation.label}
                                    </a>
                                  )
                                )
                              : null}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-muted-foreground text-xs">
                        No document matches returned.
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div className={widthClass} key={part.toolCallId ?? key}>
                  {renderGenericToolPart({
                    part,
                    addToolApprovalResponse,
                    isLoading,
                    customOutput,
                    deniedDescription,
                  })}
                </div>
              );
            }

            return null;
          })}

          {!isReadonly && (
            <MessageActions
              feedback={feedback}
              isLoading={isLoading}
              key={`action-${message.id}`}
              message={message}
              onFeedbackChange={onFeedbackChange}
              selectedLanguageModelId={selectedLanguageModelId}
              setMode={setMode}
              shouldAutoplaySpeech={shouldAutoplaySpeech}
              threadId={threadId}
              ttsAvailable={ttsAvailable}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export const PreviewMessage = PurePreviewMessage;

export const ThinkingMessage = () => (
  <div
    className="group/message fade-in w-full animate-in duration-300"
    data-role="assistant"
    data-testid="message-assistant-loading"
  >
    <div className="flex items-start justify-start gap-3">
      <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
        <div className="animate-pulse">
          <SparklesIcon size={14} />
        </div>
      </div>

      <div className="flex w-full flex-col gap-2 md:gap-4">
        <div className="flex items-center gap-1 p-0 text-muted-foreground text-sm">
          <span className="animate-pulse">Thinking</span>
          <span className="inline-flex">
            <span className="animate-bounce [animation-delay:0ms]">.</span>
            <span className="animate-bounce [animation-delay:150ms]">.</span>
            <span className="animate-bounce [animation-delay:300ms]">.</span>
          </span>
        </div>
      </div>
    </div>
  </div>
);
