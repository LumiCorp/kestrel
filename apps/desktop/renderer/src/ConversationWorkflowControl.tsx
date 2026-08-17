import { KESTREL_STANDARD_APP_MANIFESTS } from "@kestrel-agents/protocol";
import { ChevronDown, Workflow } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import type { DesktopMcpServerConfig } from "../../src/contracts";
import { isDesktopWorkflowReady } from "./workflowAvailability";

interface ConversationWorkflowControlProps {
  selectedIds: readonly string[];
  servers: readonly DesktopMcpServerConfig[];
  onChange: (ids: string[]) => void;
  onSetup: (workflowId: string) => void;
}

const WORKFLOWS = KESTREL_STANDARD_APP_MANIFESTS.filter(
  (manifest) => manifest.category === "workflow",
);

export function ConversationWorkflowControl({
  selectedIds,
  servers,
  onChange,
  onSetup,
}: ConversationWorkflowControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = new Set(selectedIds);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="composer-workflows" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="composer-workflows-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <Workflow size={15} aria-hidden="true" />
        <span>Workflows{selected.size > 0 ? ` (${selected.size})` : ""}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="composer-workflows-popover" role="dialog" aria-label="Conversation workflows">
          <div>
            <strong>Conversation workflows</strong>
            <small>Changes apply to the next submitted or queued message.</small>
          </div>
          {WORKFLOWS.map((workflow) => {
            const checked = selected.has(workflow.id);
            const ready = isDesktopWorkflowReady(workflow, servers);
            return (
              <div className="composer-workflow-option" key={workflow.id}>
                <label>
                  <input
                    checked={checked}
                    disabled={!ready && !checked}
                    type="checkbox"
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...new Set([...selectedIds, workflow.id])]
                          : selectedIds.filter((id) => id !== workflow.id),
                      )
                    }
                  />
                  <span>
                    <strong>{workflow.name}</strong>
                    <small>{ready ? workflow.description : "Unavailable — required Apps are missing"}</small>
                  </span>
                </label>
                {!ready ? (
                  <button className="text-button" type="button" onClick={() => onSetup(workflow.id)}>
                    Set up in Apps
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {selected.size > 0 ? (
        <div className="composer-workflow-chips" aria-label="Selected workflows">
          {WORKFLOWS.filter((workflow) => selected.has(workflow.id)).map((workflow) => (
            <span key={workflow.id}>{workflow.name}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
