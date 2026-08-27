import {
  collaboratorStateLabel,
  type CollaboratorGroup,
} from "@kestrel-agents/conversation";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { keepFocusInsideDialog } from "./dialogFocus";

export function CollaboratorInspector({
  groups,
  open,
  onClose,
  canAsk,
  onAsk,
  width,
  onResize,
  modal,
}: {
  groups: readonly CollaboratorGroup[];
  open: boolean;
  onClose: () => void;
  canAsk: boolean;
  onAsk: (group: CollaboratorGroup) => void;
  width: number;
  onResize: (width: number) => void;
  modal: boolean;
}) {
  const [selectedDialogId, setSelectedDialogId] = useState<string | undefined>(groups[0]?.dialogId);
  const panelRef = useRef<HTMLElement>(null);
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null);
  const selected = groups.find((group) => group.dialogId === selectedDialogId) ?? groups[0];
  const openGroups = groups.filter((group) => group.lifecycle === "open");
  const archivedGroups = groups.filter((group) => group.lifecycle === "closed");

  useEffect(() => {
    if (selected !== undefined) return;
    setSelectedDialogId(groups[0]?.dialogId);
  }, [groups, selected]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const constrainWidth = () => {
      if (window.innerWidth >= 980) onResize(clampInspectorWidth(width));
    };
    constrainWidth();
    window.addEventListener("resize", constrainWidth);
    return () => window.removeEventListener("resize", constrainWidth);
  }, [onResize, width]);

  if (!open) return null;
  return (
    <aside
      aria-label="Collaborators"
      aria-modal={modal ? true : undefined}
      className="collaborator-inspector"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (modal) keepFocusInsideDialog(event.nativeEvent, panelRef.current);
      }}
      ref={panelRef}
      role={modal ? "dialog" : undefined}
      tabIndex={-1}
    >
      <div
        aria-label="Resize collaborator inspector"
        aria-orientation="vertical"
        aria-valuemax={Math.min(480, Math.floor(window.innerWidth * 0.4))}
        aria-valuemin={300}
        aria-valuenow={width}
        className="collaborator-inspector-resize"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const change = event.key === "ArrowLeft" ? 20 : -20;
          onResize(clampInspectorWidth(width + change));
        }}
        onPointerDown={(event) => {
          resizeStartRef.current = { pointerX: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = resizeStartRef.current;
          if (start === null) return;
          onResize(clampInspectorWidth(start.width + start.pointerX - event.clientX));
        }}
        onPointerUp={(event) => {
          resizeStartRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        role="separator"
        tabIndex={0}
      />
      <header className="collaborator-inspector-header">
        <div>
          <strong>Collaborators</strong>
          <span>Private conversations Kestrel uses in this conversation.</span>
        </div>
        <button aria-label="Close collaborators" className="icon-button" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </header>
      <div className="collaborator-inspector-body">
        <nav aria-label="Collaborator list" className="collaborator-list">
          <CollaboratorList groups={openGroups} label="Open" onSelect={setSelectedDialogId} selectedDialogId={selected?.dialogId} />
          <CollaboratorList groups={archivedGroups} label="Archived" onSelect={setSelectedDialogId} selectedDialogId={selected?.dialogId} />
        </nav>
        <section aria-label={selected?.name ?? "Collaborator details"} className="collaborator-detail">
          {selected === undefined ? <p>No collaborator history is available.</p> : (
            <>
              <header>
                <div>
                  <strong>{selected.name}</strong>
                  <span role="status">{collaboratorStateLabel(selected)}</span>
                  {selected.latestEvent === "replied" ? <small>{selected.name} replied</small> : null}
                </div>
                {canAsk ? <button className="secondary-button" onClick={() => onAsk(selected)} type="button">Ask Kestrel</button> : null}
              </header>
              <ol>
                {selected.messages.map((message) => (
                  <li key={message.messageId}>
                    <strong>{message.sender === "kestrel" ? "Kestrel" : message.sender === "collaborator" ? selected.name : "System"}</strong>
                    <p>{message.text}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}

function clampInspectorWidth(width: number): number {
  return Math.max(300, Math.min(480, Math.min(Math.floor(window.innerWidth * 0.4), width)));
}

function CollaboratorList({
  groups,
  label,
  selectedDialogId,
  onSelect,
}: {
  groups: readonly CollaboratorGroup[];
  label: string;
  selectedDialogId: string | undefined;
  onSelect: (dialogId: string) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <section>
      <h2>{label}</h2>
      {groups.map((group) => (
        <button
          aria-current={selectedDialogId === group.dialogId ? "true" : undefined}
          className={selectedDialogId === group.dialogId ? "active" : ""}
          key={group.dialogId}
          onClick={() => onSelect(group.dialogId)}
          type="button"
        >
          <strong>{group.name}</strong>
          <span>{collaboratorStateLabel(group)}</span>
        </button>
      ))}
    </section>
  );
}
