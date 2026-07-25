import { Activity, CircleAlert, Inbox } from "lucide-react";
import React, { type PointerEvent as ReactPointerEvent } from "react";

import type {
  DesktopCapabilityId,
  DesktopOperatorInboxItem,
} from "../../src/contracts";
import type { RendererThread } from "./state";

export function ContextSidebar(props: {
  thread: RendererThread;
  activeRun: boolean;
  inboxItems: DesktopOperatorInboxItem[];
  activity: string;
  error?: string | undefined;
  errorCapability?: DesktopCapabilityId | undefined;
  onOpenSettings: (target?: DesktopCapabilityId | undefined) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const actionableItems = props.inboxItems.filter((item) => item.actionable);

  return (
    <aside id="context-sidebar" className="inspector contextual-sidebar" aria-label="Conversation context">
      <div
        className="sidebar-resize-handle"
        onPointerDown={props.onResizeStart}
        aria-hidden="true"
      />
      <div className="context-sidebar-scroll">
        <section className="inspector-section compact-section">
          <div className="section-heading">
            <span>Conversation</span>
          </div>
          <p className="context-title">{props.thread.title}</p>
          <p className="compact-note">{props.activeRun ? "A run is in progress." : "No run in progress."}</p>
        </section>

        <section className="inspector-section compact-section" aria-live="polite">
          <div className="section-heading">
            <Activity size={14} aria-hidden="true" />
            <span>Activity</span>
          </div>
          <p className="context-title">{props.activity}</p>
          {props.error !== undefined ? (
            <div className="context-exception" role="alert">
              <CircleAlert size={15} aria-hidden="true" />
              <div>
                <strong>Attention needed</strong>
                <p>{props.error}</p>
                {props.errorCapability !== undefined ? (
                  <button type="button" onClick={() => props.onOpenSettings(props.errorCapability)}>
                    Open Settings
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        {actionableItems.length > 0 ? (
          <section className="inspector-section compact-section">
            <div className="section-heading">
              <Inbox size={14} aria-hidden="true" />
              <span>Needs your input</span>
              <small>{actionableItems.length}</small>
            </div>
            <div className="context-inbox-list">
              {actionableItems.map((item) => (
                <article key={item.itemId} className="context-inbox-item">
                  <strong>{item.title}</strong>
                  {item.detail !== undefined ? <p>{item.detail}</p> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
