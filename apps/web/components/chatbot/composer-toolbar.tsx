"use client";

import type { ReactNode } from "react";
import {
  KESTREL_ONE_INTERACTION_MODES,
  type KestrelOneInteractionMode,
} from "@/lib/turns/interaction-mode";
import { cn } from "@/lib/utils";
import { PromptInputToolbar } from "./elements/prompt-input";

export function ComposerToolbar({
  activeEnvironmentName,
  capabilityControls,
  className,
  interactionMode,
  modeDisabled,
  modelControl,
  onInteractionModeChange,
  onRuntimeChange,
  primaryAction,
  runtimeDisabled,
  runtimeId,
  hydraEnabled,
  runtimeReadiness,
}: {
  activeEnvironmentName?: string;
  capabilityControls: ReactNode;
  className?: string;
  interactionMode: KestrelOneInteractionMode;
  modeDisabled: boolean;
  modelControl: ReactNode;
  onInteractionModeChange: (mode: KestrelOneInteractionMode) => void;
  onRuntimeChange: (runtimeId: "kestrel" | "codex" | "claude") => void;
  primaryAction: ReactNode;
  runtimeDisabled: boolean;
  runtimeId: "kestrel" | "codex" | "claude";
  hydraEnabled: boolean;
  runtimeReadiness?: Partial<Record<"codex" | "claude", {
    availability: "loading" | "ready" | "auth_required" | "version_mismatch" | "unavailable";
    reason?: string | undefined;
  }>>;
}) {
  return (
    <PromptInputToolbar
      className={cn(
        "flex flex-col items-stretch gap-2 border-0 p-0 shadow-none lg:flex-row lg:items-center",
        className
      )}
    >
      <div
        className="flex min-w-0 items-center gap-2"
        data-testid="composer-context-controls"
      >
        <div
          aria-label="Interaction mode"
          className="flex shrink-0 items-center rounded-lg bg-muted p-0.5"
          role="group"
        >
          {KESTREL_ONE_INTERACTION_MODES.map((mode) => (
            <button
              aria-pressed={interactionMode === mode}
              className={cn(
                "h-7 rounded-md px-2 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                interactionMode === mode
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
              data-testid={`interaction-mode-${mode}`}
              disabled={modeDisabled}
              key={mode}
              onClick={() => onInteractionModeChange(mode)}
              type="button"
            >
              {mode === "chat" ? "Chat" : mode === "plan" ? "Plan" : "Build"}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="conversation-runtime">Runtime</label>
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          disabled={runtimeDisabled}
          id="conversation-runtime"
          onChange={(event) => {
            const value = event.target.value;
            if (value === "kestrel" || value === "codex" || value === "claude") {
              onRuntimeChange(value);
            }
          }}
          value={runtimeId}
        >
          <option value="kestrel">Kestrel</option>
          <option
            disabled={!hydraEnabled || runtimeReadiness?.codex?.availability !== "ready"}
            title={runtimeReadiness?.codex?.reason}
            value="codex"
          >Codex{runtimeReadiness?.codex?.availability === "loading" ? " (checking…)" : ""}</option>
          <option
            disabled={!hydraEnabled || runtimeReadiness?.claude?.availability !== "ready"}
            title={runtimeReadiness?.claude?.reason}
            value="claude"
          >Claude Code{runtimeReadiness?.claude?.availability === "loading" ? " (checking…)" : ""}</option>
        </select>
        {activeEnvironmentName ? (
          <span className="hidden max-w-40 shrink-0 truncate rounded-md border px-2 py-1 text-muted-foreground text-xs sm:inline">
            Environment: {activeEnvironmentName}
          </span>
        ) : null}
        <div className="min-w-0 flex-1 lg:flex-none">{modelControl}</div>
      </div>

      <div
        className="flex min-w-0 items-center gap-1 lg:ml-auto"
        data-testid="composer-capability-controls"
      >
        {capabilityControls}
        <div className="ml-auto shrink-0 lg:ml-0">{primaryAction}</div>
      </div>
    </PromptInputToolbar>
  );
}
