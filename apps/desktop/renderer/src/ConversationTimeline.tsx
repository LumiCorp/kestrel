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
  useId,
  useRef,
  useState,
} from "react";

import { MessageContent } from "./MessageContent";
import type {
  DesktopConversationTimelineItem,
  DesktopRunStreamItem,
} from "./runStream";

export function ConversationTimeline(props: {
  items: readonly DesktopConversationTimelineItem[];
  active: boolean;
  waiting?: boolean | undefined;
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
  const activityGroups = groupTimelineActivity(props.items);
  const activityGroupByStart = new Map(
    activityGroups.map((group) => [group.startIndex, group]),
  );
  const latestActivityGroup = activityGroups.at(-1);
  const latestProgressItems = latestActivityGroup?.items.filter(
    (item) => item.kind === "agent_progress",
  ) ?? [];
  const lastRunIndex = latestActivityGroup?.endIndex ?? -1;
  const terminalAssistantIndex = props.items.findIndex(
    (entry, index) =>
      index > lastRunIndex &&
      entry.type === "transcript" &&
      entry.line.dialog === undefined &&
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
  const latestProgress =
    latestProgressItems.at(-1)?.text ??
    (props.active
      ? props.activity === "Cancelling"
        ? "Stopping the active run…"
        : "Kestrel is working…"
      : "");
  const terminalTransition = transitionLabel({
    items: props.items,
    active: props.active,
    waiting: props.waiting === true,
    hasFinalizedAnswer: terminalAssistantIndex >= 0,
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
          if (entry.type === "run_stream") {
            const group = activityGroupByStart.get(index);
            if (group === undefined) return null;
            const progressItems = group.items.filter(
              (item) => item.kind === "agent_progress",
            );
            const operationalItems = group.items.filter(
              (item) => item.kind !== "agent_progress",
            );
            const groupActive = props.active && group === latestActivityGroup;
            return (
              <Fragment key={group.id}>
                {progressItems.length > 0 ? (
                  <AgentProgressDisclosure
                    active={groupActive}
                    items={progressItems}
                  />
                ) : null}
                {operationalItems.length > 0 ? (
                  <OperationalDetails groupId={group.id} items={operationalItems} />
                ) : null}
              </Fragment>
            );
          }

          if (entry.line.dialog !== undefined) return null;

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
              <MessageEntry
                entry={entry}
                supplement={props.messageSupplement?.(entry)}
              />
              {transition}
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
        {props.active && latestProgressItems.length === 0 ? (
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

function groupTimelineActivity(
  items: readonly DesktopConversationTimelineItem[],
): Array<{
  id: string;
  startIndex: number;
  endIndex: number;
  items: DesktopRunStreamItem[];
}> {
  const groups: Array<{
    id: string;
    startIndex: number;
    endIndex: number;
    items: DesktopRunStreamItem[];
  }> = [];
  let index = 0;
  while (index < items.length) {
    const entry = items[index];
    if (entry?.type !== "run_stream") {
      index += 1;
      continue;
    }
    const startIndex = index;
    const runId = entry.item.runId;
    const groupItems: DesktopRunStreamItem[] = [];
    while (index < items.length) {
      const candidate = items[index];
      if (
        candidate?.type !== "run_stream" ||
        candidate.item.runId !== runId
      ) {
        break;
      }
      groupItems.push(candidate.item);
      index += 1;
    }
    groups.push({
      id: `run-activity:${runId ?? startIndex}`,
      startIndex,
      endIndex: index - 1,
      items: groupItems,
    });
  }
  return groups;
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
      ? `Collaborator: ${entry.line.dialog.name}`
      : entry.line.dialog?.sender === "kestrel"
        ? "Kestrel"
        : entry.line.role === "user"
          ? "You"
          : entry.line.role === "assistant"
            ? "Kestrel"
            : "System";
  const dialogLifecycle = entry.line.dialog?.dialogStatus === "closed"
    ? "Closed"
    : entry.line.dialog?.dialogActivity === "working"
      ? "Working"
      : entry.line.dialog?.dialogActivity === "waiting"
        ? "Waiting for input"
        : entry.line.dialog?.dialogActivity === "interrupted"
          ? "Interrupted"
          : entry.line.dialog === undefined ? undefined : "Idle";

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
          {dialogLifecycle !== undefined ? <span className="timeline-entry-dialog-status">{dialogLifecycle}</span> : null}
          {entry.line.dialog?.status === "failed" ? <span className="timeline-entry-dialog-failure">Needs attention</span> : null}
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

function AgentProgressDisclosure({
  active,
  items,
}: {
  active: boolean;
  items: readonly DesktopRunStreamItem[];
}) {
  return (
    <li className={`timeline-entry timeline-entry-progress ${active ? "is-current" : ""}`}>
      <TimelineMarker kind="progress" />
      <details
        className="timeline-progress"
        open={active}
        onToggle={(event) => {
          if (active && event.currentTarget.open === false) {
            event.currentTarget.open = true;
          }
        }}
      >
        <summary>
          <Activity size={14} />
          <span>
            {active
              ? "Agent progress"
              : `Agent progress · ${items.length} ${items.length === 1 ? "update" : "updates"}`}
          </span>
          {active ? <span aria-label="Agent is working" className="timeline-progress-pulse" /> : null}
        </summary>
        <ol>
          {items.map((item) => (
            <li key={item.id}>
              <span>{item.text.length > 0 ? item.text : "Working…"}</span>
              <time dateTime={item.timestamp}>{formatMessageTime(item.timestamp)}</time>
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function OperationalDetails({
  groupId,
  items,
}: {
  groupId: string;
  items: readonly DesktopRunStreamItem[];
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  if (items.length === 0) return null;
  const toggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen === false) {
      requestAnimationFrame(() => {
        toggleRef.current?.scrollIntoView({ block: "nearest" });
      });
    }
  };
  return (
    <li className="timeline-entry timeline-entry-details" data-activity-group={groupId}>
      <TimelineMarker kind="details" />
      <div className={`timeline-details ${open ? "is-open" : ""}`}>
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className="timeline-details-toggle"
          onClick={toggle}
          ref={toggleRef}
          type="button"
        >
          <span>Details</span>
          <small aria-label={`${items.length} operational ${items.length === 1 ? "event" : "events"}`}>
            {items.length}
          </small>
        </button>
        {open ? (
          <ol id={contentId}>
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
        ) : null}
      </div>
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
  waiting: boolean;
  hasFinalizedAnswer: boolean;
  activity: string;
  error?: string | undefined;
}): string | undefined {
  if (input.active || input.waiting || input.items.every((entry) => entry.type !== "run_stream")) {
    return undefined;
  }
  if (input.error !== undefined || input.activity === "Run failed") {
    return "Run failed";
  }
  if (input.activity === "Cancelled") return "Run stopped";
  return input.hasFinalizedAnswer ? "Completed" : undefined;
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
