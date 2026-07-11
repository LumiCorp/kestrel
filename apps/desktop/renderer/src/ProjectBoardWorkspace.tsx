import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  Play,
  Save,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";

import type {
  DesktopProjectAction,
  DesktopProjectSnapshotResponse,
} from "../../src/contracts";

type ProjectSnapshot = DesktopProjectSnapshotResponse["snapshot"];
type ProjectBoard = ProjectSnapshot["board"];
type ProjectBoardCard = ProjectBoard["cards"][string];
type ProjectBoardLane = ProjectBoardCard["lane"];
type BoardAction = Extract<DesktopProjectAction, { type: `board.${string}` }>;

interface ProjectBoardWorkspaceProps {
  sessionId: string;
  board: ProjectBoard;
  actionPending: boolean;
  onAction: (action: DesktopProjectAction) => Promise<boolean>;
  onInspectThread: (threadId: string) => void;
}

const BOARD_LANES: Array<{ id: ProjectBoardLane; label: string }> = [
  { id: "idea", label: "Ideas" },
  { id: "planned", label: "Planned" },
  { id: "wip", label: "In progress" },
  { id: "testing", label: "Testing" },
  { id: "done", label: "Done" },
];

export function ProjectBoardWorkspace({
  sessionId,
  board,
  actionPending,
  onAction,
  onInspectThread,
}: ProjectBoardWorkspaceProps) {
  const [wipLimit, setWipLimit] = useState(String(board.settings.wipLimit));
  const [confirmation, setConfirmation] = useState<{
    cardId: string;
    kind: "delete" | "done";
  }>();

  useEffect(() => {
    setWipLimit(String(board.settings.wipLimit));
  }, [board.settings.wipLimit]);

  const cards = useMemo(
    () => Object.values(board.cards).sort(compareBoardCards),
    [board.cards],
  );

  async function configureAutopilot(enabled: boolean): Promise<void> {
    const base = boardActionBase(sessionId, board.boardVersion);
    await onAction({
      ...base,
      type: "board.autopilot.configure",
      autopilotEnabled: enabled,
      ...(enabled ? { autopilotConfirmedAt: base.actionTs } : {}),
    });
  }

  async function updateWipLimit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const parsed = Number(wipLimit);
    if (Number.isInteger(parsed) === false || parsed <= 0) {
      return;
    }
    await onAction({
      ...boardActionBase(sessionId, board.boardVersion),
      type: "board.autopilot.configure",
      wipLimit: parsed,
    });
  }

  async function runBoardAction(action: BoardAction): Promise<boolean> {
    const succeeded = await onAction(action);
    if (succeeded) {
      setConfirmation(undefined);
    }
    return succeeded;
  }

  return (
    <>
      <section className="board-controls" aria-label="Product board controls">
        <label className="board-autopilot-toggle">
          <input
            type="checkbox"
            checked={board.settings.autopilotEnabled}
            disabled={actionPending}
            onChange={(event) => void configureAutopilot(event.target.checked)}
          />
          <span>Autopilot</span>
        </label>
        <form className="board-wip-limit" onSubmit={(event) => void updateWipLimit(event)}>
          <label htmlFor="mission-board-wip-limit">WIP limit</label>
          <input
            id="mission-board-wip-limit"
            type="number"
            min={1}
            step={1}
            value={wipLimit}
            onChange={(event) => setWipLimit(event.target.value)}
          />
          <button
            className="icon-button"
            type="submit"
            title="Save WIP limit"
            aria-label="Save WIP limit"
            disabled={actionPending || Number(wipLimit) === board.settings.wipLimit}
          >
            <Save size={14} />
          </button>
        </form>
        <button
          className="icon-button"
          type="button"
          title="Run one autopilot cycle"
          aria-label="Run one autopilot cycle"
          disabled={actionPending || board.settings.autopilotEnabled === false}
          onClick={() => void onAction({
            ...boardActionBase(sessionId, board.boardVersion),
            type: "board.autopilot.tick",
          })}
        >
          <Play size={14} />
        </button>
        <span className="board-version">Board v{board.boardVersion}</span>
      </section>

      {cards.length === 0 ? (
        <div className="mission-empty">
          <span>No cards on this project board</span>
        </div>
      ) : (
        <section className="mission-lanes board-lanes" aria-label="Product board lanes">
          {BOARD_LANES.map((lane) => {
            const laneCards = cards.filter((card) => card.lane === lane.id);
            return (
              <section className="mission-lane board-lane" key={lane.id} aria-label={`${lane.label} cards`}>
                <header>
                  <span>{lane.label}</span>
                  <strong>{laneCards.length}</strong>
                </header>
                <div className="mission-task-list">
                  {laneCards.map((card) => (
                    <BoardCard
                      key={card.id}
                      actionPending={actionPending}
                      boardVersion={board.boardVersion}
                      card={card}
                      confirmation={confirmation?.cardId === card.id ? confirmation.kind : undefined}
                      sessionId={sessionId}
                      onAction={runBoardAction}
                      onCancelConfirmation={() => setConfirmation(undefined)}
                      onInspectThread={onInspectThread}
                      onRequestConfirmation={(kind) => setConfirmation({ cardId: card.id, kind })}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </section>
      )}
    </>
  );
}

function BoardCard({
  card,
  sessionId,
  boardVersion,
  actionPending,
  confirmation,
  onAction,
  onInspectThread,
  onRequestConfirmation,
  onCancelConfirmation,
}: {
  card: ProjectBoardCard;
  sessionId: string;
  boardVersion: number;
  actionPending: boolean;
  confirmation: "delete" | "done" | undefined;
  onAction: (action: BoardAction) => Promise<boolean>;
  onInspectThread: (threadId: string) => void;
  onRequestConfirmation: (kind: "delete" | "done") => void;
  onCancelConfirmation: () => void;
}) {
  const base = boardActionBase(sessionId, boardVersion);
  const latestEvidence = card.evidence.at(-1);

  return (
    <article className={`mission-task board-card board-card-${card.lane}`}>
      <div className="mission-task-heading">
        <span>{card.id}</span>
        <span>{card.activeClaim?.kind ?? card.lane}</span>
      </div>
      <h2>{card.title}</h2>
      <p>{card.prompt}</p>
      <div className="mission-task-meta">
        <span>{card.lane.replaceAll("_", " ")}</span>
        {card.activeClaim !== undefined ? (
          <code title={card.activeClaim.threadId}>{truncateId(card.activeClaim.threadId)}</code>
        ) : null}
      </div>
      {latestEvidence !== undefined ? (
        <div className="mission-evidence" title={latestEvidence.summary}>
          <span>{latestEvidence.summary}</span>
          <time>{formatTime(latestEvidence.timestamp)}</time>
        </div>
      ) : null}
      <div className="mission-task-actions">
        {card.activeClaim !== undefined ? (
          <BoardActionButton
            disabled={actionPending}
            label="Inspect runtime thread"
            icon={<ExternalLink size={14} />}
            onClick={async () => onInspectThread(card.activeClaim!.threadId)}
          />
        ) : null}
        {confirmation !== undefined ? (
          <>
            <BoardActionButton
              disabled={actionPending}
              label={confirmation === "delete" ? "Confirm delete card" : "Confirm mark card done"}
              icon={<Check size={14} />}
              onClick={() => onAction(confirmation === "delete"
                ? { ...base, type: "board.card.delete", cardId: card.id }
                : {
                    ...base,
                    type: "board.card.manual_done",
                    cardId: card.id,
                    reason: "Marked done from Desktop Mission Control.",
                  })}
            />
            <BoardActionButton
              disabled={actionPending}
              label="Cancel confirmation"
              icon={<X size={14} />}
              onClick={async () => onCancelConfirmation()}
            />
          </>
        ) : (
          <BoardCardActions
            actionPending={actionPending}
            base={base}
            card={card}
            onAction={onAction}
            onRequestConfirmation={onRequestConfirmation}
          />
        )}
      </div>
    </article>
  );
}

function BoardCardActions({
  card,
  base,
  actionPending,
  onAction,
  onRequestConfirmation,
}: {
  card: ProjectBoardCard;
  base: ReturnType<typeof boardActionBase>;
  actionPending: boolean;
  onAction: (action: BoardAction) => Promise<boolean>;
  onRequestConfirmation: (kind: "delete" | "done") => void;
}) {
  if (card.lane === "done") {
    return null;
  }
  return (
    <>
      {card.lane === "idea" ? (
        <BoardActionButton
          disabled={actionPending}
          label="Move card to planned"
          icon={<ArrowRight size={14} />}
          onClick={() => onAction({
            ...base,
            type: "board.card.move",
            cardId: card.id,
            targetLane: "planned",
          })}
        />
      ) : null}
      {card.lane === "planned" ? (
        <>
          <BoardActionButton
            disabled={actionPending}
            label="Move card to ideas"
            icon={<ArrowLeft size={14} />}
            onClick={() => onAction({
              ...base,
              type: "board.card.move",
              cardId: card.id,
              targetLane: "idea",
            })}
          />
          <BoardActionButton
            disabled={actionPending}
            label="Start card implementation"
            icon={<Play size={14} />}
            onClick={() => onAction({
              ...base,
              type: "board.card.start_implementation",
              cardId: card.id,
            })}
          />
        </>
      ) : null}
      {card.lane === "wip" ? (
        card.activeClaim !== undefined ? (
          <BoardActionButton
            disabled={actionPending}
            label="Stop card implementation"
            icon={<Square size={13} fill="currentColor" />}
            onClick={() => onAction({
              ...base,
              type: "board.card.thread_stopped",
              cardId: card.id,
            })}
          />
        ) : (
          <BoardActionButton
            disabled={actionPending}
            label="Return card to planned"
            icon={<ArrowLeft size={14} />}
            onClick={() => onAction({
              ...base,
              type: "board.card.move",
              cardId: card.id,
              targetLane: "planned",
            })}
          />
        )
      ) : null}
      {card.lane === "testing" ? (
        card.activeClaim?.kind === "testing" ? (
          <>
            <BoardActionButton
              disabled={actionPending}
              label="Pass card testing"
              icon={<Check size={14} />}
              onClick={() => onAction({
                ...base,
                type: "board.card.testing_verdict",
                cardId: card.id,
                testingVerdict: "pass",
              })}
            />
            <BoardActionButton
              disabled={actionPending}
              label="Fail card testing"
              icon={<X size={14} />}
              onClick={() => onAction({
                ...base,
                type: "board.card.testing_verdict",
                cardId: card.id,
                testingVerdict: "fail",
              })}
            />
            <BoardActionButton
              disabled={actionPending}
              label="Stop card testing"
              icon={<Square size={13} fill="currentColor" />}
              onClick={() => onAction({
                ...base,
                type: "board.card.thread_stopped",
                cardId: card.id,
              })}
            />
          </>
        ) : (
          <BoardActionButton
            disabled={actionPending}
            label="Start card testing"
            icon={<Play size={14} />}
            onClick={() => onAction({
              ...base,
              type: "board.card.start_testing",
              cardId: card.id,
            })}
          />
        )
      ) : null}
      {(card.lane === "idea" || card.lane === "planned") && card.activeClaim === undefined ? (
        <BoardActionButton
          disabled={actionPending}
          label="Delete card"
          icon={<Trash2 size={14} />}
          onClick={async () => onRequestConfirmation("delete")}
        />
      ) : null}
      <BoardActionButton
        disabled={actionPending}
        label="Mark card done"
        icon={<Check size={14} />}
        onClick={async () => onRequestConfirmation("done")}
      />
    </>
  );
}

function BoardActionButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => Promise<unknown>;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {icon}
    </button>
  );
}

function boardActionBase(sessionId: string, boardVersion: number) {
  return {
    sessionId,
    actionId: crypto.randomUUID(),
    actionTs: new Date().toISOString(),
    expectedBoardVersion: boardVersion,
    source: "operator" as const,
  };
}

function compareBoardCards(left: ProjectBoardCard, right: ProjectBoardCard): number {
  return left.order - right.order
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function truncateId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
}
