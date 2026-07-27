import {
  Activity,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  Info,
  ListTree,
  Square,
  UserRound,
} from "lucide-react";
import React, {
  Fragment,
  type ReactNode,
  type RefObject,
} from "react";

import { MessageContent } from "./MessageContent";
import type {
  DesktopConversationTimelineItem,
  DesktopRunStreamItem,
} from "./runStream";

export function ConversationTimeline(props: {
  items: readonly DesktopConversationTimelineItem[];
  active: boolean;
  activity: string;
  error?: string | undefined;
  systemError?: string | undefined;
  errorAction?: ReactNode;
  messageSupplement?: (
    entry: Extract<DesktopConversationTimelineItem, { type: "transcript" }>,
  ) => ReactNode;
  tail?: ReactNode;
  endRef: RefObject<HTMLDivElement | null>;
  showNewActivity?: boolean | undefined;
  onFollowNewActivity?: (() => void) | undefined;
}) {
  const operationalItems = props.items.flatMap((entry) =>
    entry.type === "run_stream" && entry.item.kind !== "assistant"
      ? [entry.item]
      : [],
  );
  const progressItems = props.items.flatMap((entry) =>
    entry.type === "run_stream" && entry.item.kind === "assistant"
      ? [entry.item]
      : [],
  );
  const lastRunIndex = findLastIndex(
    props.items,
    (entry) => entry.type === "run_stream",
  );
  const terminalAssistantIndex = props.items.findIndex(
    (entry, index) =>
      index > lastRunIndex &&
      entry.type === "transcript" &&
      entry.line.role === "assistant",
  );
  const terminalState =
    props.error !== undefined
      ? "failed"
      : props.activity === "Cancelled"
        ? "cancelled"
        : "completed";
  const lastRunEntry = props.items[lastRunIndex];
  const terminalTimestamp =
    lastRunEntry?.type === "run_stream" ? lastRunEntry.item.timestamp : "";
  const latestProgressId = progressItems.at(-1)?.id;
  const latestProgress =
    progressItems.at(-1)?.text ??
    (props.active
      ? props.activity === "Cancelling"
        ? "Stopping the active run…"
        : "Kestrel is working…"
      : "");
  const terminalTransition = transitionLabel({
    items: props.items,
    active: props.active,
    activity: props.activity,
    error: props.error,
  });

  return (
    <section
      className={`conversation-timeline ${props.items.length === 0 ? "conversation-timeline-empty" : ""}`}
      aria-label="Conversation timeline"
    >
      {props.items.length === 0 ? (
        <div className="empty-transcript">
          <span className="brand-mark large">K</span>
          <h1>New conversation</h1>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {latestProgress}
      </p>
      <ol
        className={`conversation-timeline-list ${props.items.length === 0 ? "is-empty" : ""}`}
      >
        {props.items.map((entry, index) => {
          if (
            entry.type === "run_stream" &&
            entry.item.kind !== "assistant"
          ) {
            return index === lastRunIndex ? (
              <OperationalDetails
                key="operational-details"
                items={operationalItems}
              />
            ) : null;
          }

          if (entry.type === "run_stream") {
            return (
              <Fragment key={entry.id}>
                <ProgressEntry
                  item={entry.item}
                  current={props.active && entry.item.id === latestProgressId}
                />
                {index === lastRunIndex ? (
                  <OperationalDetails items={operationalItems} />
                ) : null}
              </Fragment>
            );
          }

          const transition =
            index === terminalAssistantIndex &&
            terminalTransition !== undefined ? (
              <TransitionEntry
                key={`transition:${entry.id}`}
                label={terminalTransition}
                timestamp={entry.line.timestamp}
                state={terminalState}
              />
            ) : null;

          return (
            <Fragment key={entry.id}>
              {transition}
              <MessageEntry
                entry={entry}
                supplement={props.messageSupplement?.(entry)}
              />
            </Fragment>
          );
        })}
        {terminalTransition !== undefined && terminalAssistantIndex < 0 ? (
          <TransitionEntry
            label={terminalTransition}
            timestamp={terminalTimestamp}
            state={terminalState}
          />
        ) : null}
        {props.active && progressItems.length === 0 ? (
          <li className="timeline-entry timeline-entry-progress is-current">
            <TimelineMarker kind="progress" />
            <div className="timeline-entry-content">
              <div className="timeline-entry-meta">
                <strong>Kestrel</strong>
                <span>Working</span>
              </div>
              <p className="timeline-progress-text">
                {props.activity === "Cancelling"
                  ? "Stopping the active run…"
                  : "Kestrel is working…"}
              </p>
            </div>
          </li>
        ) : null}
        {props.error !== undefined || props.systemError !== undefined ? (
          <li
            className="timeline-entry timeline-entry-attention timeline-entry-failed"
            role="alert"
          >
            <TimelineMarker kind="failed" />
            <div className="timeline-entry-content">
              <div className="timeline-entry-meta">
                <strong>Run needs attention</strong>
              </div>
              {props.error !== undefined ? (
                <p className="timeline-attention-copy">{props.error}</p>
              ) : null}
              {props.systemError !== undefined ? (
                <p className="timeline-attention-copy">{props.systemError}</p>
              ) : null}
              {props.errorAction}
            </div>
          </li>
        ) : null}
        {props.tail}
      </ol>
      {props.showNewActivity ? (
        <button
          className="timeline-new-activity"
          type="button"
          onClick={props.onFollowNewActivity}
        >
          New activity
        </button>
      ) : null}
      <div ref={props.endRef} />
    </section>
  );
}

function MessageEntry({
  entry,
  supplement,
}: {
  entry: Extract<DesktopConversationTimelineItem, { type: "transcript" }>;
  supplement?: ReactNode;
}) {
  const sender =
    entry.line.dialog?.sender === "collaborator"
      ? entry.line.dialog.name
      : entry.line.dialog?.sender === "kestrel"
        ? "Kestrel"
        : entry.line.role === "user"
          ? "You"
          : entry.line.role === "assistant"
            ? "Kestrel"
            : "System";

  return (
    <li
      className={`timeline-entry timeline-entry-message timeline-entry-${entry.line.role}`}
    >
      <TimelineMarker
        kind={
          entry.line.role === "user"
            ? "user"
            : entry.line.role === "assistant"
              ? "assistant"
              : "system"
        }
      />
      <article className="timeline-entry-content">
        <div className="timeline-entry-meta">
          <strong>{sender}</strong>
          <time dateTime={entry.line.timestamp}>
            {formatMessageTime(entry.line.timestamp)}
          </time>
        </div>
        <MessageContent messageRole={entry.line.role} text={entry.line.text} />
        {supplement}
      </article>
    </li>
  );
}

function ProgressEntry({
  item,
  current,
}: {
  item: DesktopRunStreamItem;
  current: boolean;
}) {
  return (
    <li
      className={`timeline-entry timeline-entry-progress ${current ? "is-current" : ""}`}
    >
      <TimelineMarker kind="progress" />
      <div className="timeline-entry-content">
        <div className="timeline-entry-meta">
          <strong>{item.label}</strong>
          <time dateTime={item.timestamp}>{formatMessageTime(item.timestamp)}</time>
        </div>
        <MessageContent
          messageRole="assistant"
          text={item.text.length > 0 ? item.text : "Working…"}
        />
      </div>
    </li>
  );
}

function OperationalDetails({
  items,
}: {
  items: readonly DesktopRunStreamItem[];
}) {
  if (items.length === 0) return null;
  return (
    <li className="timeline-entry timeline-entry-details">
      <TimelineMarker kind="details" />
      <details className="timeline-details">
        <summary>
          <span>Details</span>
          <small aria-label={`${items.length} operational ${items.length === 1 ? "event" : "events"}`}>
            {items.length}
          </small>
        </summary>
        <ol>
          {items.map((item) => (
            <li
              className={`timeline-detail timeline-detail-${item.kind} timeline-detail-${item.status}`}
              key={item.id}
            >
              <div>
                <strong>{item.label}</strong>
                <time dateTime={item.timestamp}>
                  {formatMessageTime(item.timestamp)}
                </time>
              </div>
              <p>
                {item.text.length > 0
                  ? item.text
                  : item.kind === "reasoning"
                    ? "Provider returned no visible reasoning detail."
                    : "No visible detail."}
              </p>
              {item.kind === "tool" && item.toolInput !== undefined ? (
                <pre
                  aria-label={`${item.toolName ?? "Tool"} input`}
                  className="timeline-detail-tool-input"
                >
                  <code>{formatToolInput(item.toolInput)}</code>
                </pre>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function TransitionEntry({
  label,
  timestamp,
  state,
}: {
  label: string;
  timestamp: string;
  state: "completed" | "failed" | "cancelled";
}) {
  return (
    <li className={`timeline-entry timeline-entry-transition state-${state}`}>
      <TimelineMarker kind={state} />
      <div className="timeline-entry-content">
        <div className="timeline-entry-meta">
          <strong>{label}</strong>
          <time dateTime={timestamp}>{formatMessageTime(timestamp)}</time>
        </div>
      </div>
    </li>
  );
}

export function TimelineMarker({
  kind,
}: {
  kind:
    | "user"
    | "assistant"
    | "system"
    | "progress"
    | "details"
    | "completed"
    | "failed"
    | "cancelled"
    | "attention"
    | "queue";
}) {
  const icon =
    kind === "user" ? (
      <UserRound size={14} />
    ) : kind === "assistant" ? (
      <Bot size={14} />
    ) : kind === "progress" ? (
      <Activity size={14} />
    ) : kind === "details" ? (
      <ListTree size={14} />
    ) : kind === "completed" ? (
      <Check size={14} />
    ) : kind === "failed" || kind === "attention" ? (
      <CircleAlert size={14} />
    ) : kind === "cancelled" ? (
      <Square size={12} />
    ) : kind === "queue" ? (
      <Clock3 size={14} />
    ) : (
      <Info size={14} />
    );
  return (
    <span
      className={`timeline-marker timeline-marker-${kind}`}
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}

function transitionLabel(input: {
  items: readonly DesktopConversationTimelineItem[];
  active: boolean;
  activity: string;
  error?: string | undefined;
}): string | undefined {
  if (input.active || input.items.every((entry) => entry.type !== "run_stream")) {
    return undefined;
  }
  if (input.error !== undefined || input.activity === "Run failed") {
    return "Run failed";
  }
  if (input.activity === "Cancelled") return "Run stopped";
  return "Work completed";
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatToolInput(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "Tool input could not be displayed.";
  }
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}
