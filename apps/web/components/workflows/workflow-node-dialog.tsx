"use client";

import {
  Bot,
  Braces,
  CircleStop,
  Clock3,
  GitMerge,
  Play,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { WorkflowNode } from "@/lib/workflows/contracts";
import { cn } from "@/lib/utils";

export type WorkflowToolOption = {
  name: string;
  label: string;
  description: string;
  appName: string;
};

const nodePresentation = {
  trigger: {
    icon: Play,
    label: "Trigger",
    description: "Choose how this workflow starts.",
    accent: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300",
  },
  kestrel: {
    icon: Bot,
    label: "Kestrel work",
    description: "Give Kestrel one clear outcome to produce.",
    accent: "bg-violet-500/12 text-violet-600 dark:text-violet-300",
  },
  tool: {
    icon: Wrench,
    label: "Tool call",
    description: "Call one tool that this project is allowed to use.",
    accent: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  },
  gate: {
    icon: ShieldCheck,
    label: "Gate",
    description: "Continue only when the incoming result passes this check.",
    accent: "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
  },
  join: {
    icon: GitMerge,
    label: "Join",
    description: "Wait for every connected branch before continuing.",
    accent: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
  },
  output: {
    icon: CircleStop,
    label: "Output",
    description: "Collect the final result returned by the workflow.",
    accent: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  },
} as const;

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-xs leading-relaxed">{children}</p>;
}

export function WorkflowNodeDialog({
  enabled,
  node,
  onDelete,
  onEnabledChange,
  onOpenChange,
  onUpdate,
  open,
  tools,
  toolsLoading,
}: {
  enabled: boolean;
  node: WorkflowNode | null;
  onDelete: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onOpenChange: (open: boolean) => void;
  onUpdate: (update: (node: WorkflowNode) => WorkflowNode) => void;
  open: boolean;
  tools: WorkflowToolOption[];
  toolsLoading: boolean;
}) {
  if (!node) return null;
  const presentation = nodePresentation[node.kind];
  const Icon = presentation.icon;
  const selectedTool =
    node.kind === "tool"
      ? tools.find((tool) => tool.name === node.config.toolName)
      : null;
  const hasUnavailableTool =
    node.kind === "tool" && Boolean(node.config.toolName) && !selectedTool;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[min(760px,calc(100dvh-2rem))] overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b bg-muted/30 px-6 py-5 pr-14">
          <div className="flex items-start gap-3">
            <span className={cn("rounded-xl p-2.5", presentation.accent)}>
              <Icon className="size-5" />
            </span>
            <div className="space-y-1">
              <DialogTitle>{presentation.label}</DialogTitle>
              <DialogDescription>{presentation.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 overflow-y-auto px-6 py-1">
          <div className="space-y-2">
            <Label htmlFor="workflow-node-label">Step name</Label>
            <Input
              id="workflow-node-label"
              maxLength={120}
              onChange={(event) =>
                onUpdate((current) => ({ ...current, label: event.target.value }))
              }
              value={node.label}
            />
            <FieldHelp>Use a short name that makes the graph easy to scan.</FieldHelp>
          </div>

          {node.kind === "kestrel" ? (
            <div className="space-y-2">
              <Label htmlFor="workflow-node-instructions">Work instructions</Label>
              <Textarea
                className="min-h-44 resize-y"
                id="workflow-node-instructions"
                onChange={(event) =>
                  onUpdate((current) =>
                    current.kind === "kestrel"
                      ? { ...current, config: { instructions: event.target.value } }
                      : current,
                  )
                }
                placeholder="Describe the outcome, useful context, and any limits."
                value={node.config.instructions}
              />
              <FieldHelp>
                Kestrel expands this coarse step into its internal model and tool calls when it runs.
              </FieldHelp>
            </div>
          ) : null}

          {node.kind === "tool" ? (
            <>
              <div className="space-y-2">
                <Label>Project tool</Label>
                <Select
                  disabled={toolsLoading || tools.length === 0}
                  onValueChange={(toolName) =>
                    onUpdate((current) =>
                      current.kind === "tool"
                        ? { ...current, config: { ...current.config, toolName } }
                        : current,
                    )
                  }
                  value={selectedTool?.name ?? ""}
                >
                  <SelectTrigger
                    aria-label="Project tool"
                    className="h-auto min-h-10 py-2"
                  >
                    <SelectValue
                      placeholder={toolsLoading ? "Loading project tools…" : "Choose an allowed tool"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {tools.map((tool) => (
                      <SelectItem key={tool.name} value={tool.name}>
                        <span className="flex min-w-0 flex-col py-0.5">
                          <span className="font-medium">{tool.label}</span>
                          <span className="text-muted-foreground text-xs">{tool.appName}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hasUnavailableTool ? (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-amber-700 text-xs dark:text-amber-300">
                    “{node.config.toolName}” is not currently allowed for this project. Choose an available tool before saving.
                  </p>
                ) : selectedTool ? (
                  <FieldHelp>{selectedTool.description}</FieldHelp>
                ) : toolsLoading ? null : (
                  <FieldHelp>No enabled tools are available for this project.</FieldHelp>
                )}
              </div>
              <div className="space-y-2">
                <Label className="flex items-center gap-2" htmlFor="workflow-tool-input">
                  <Braces className="size-3.5 text-muted-foreground" /> JSON input
                </Label>
                <Textarea
                  className="min-h-40 resize-y font-mono text-xs"
                  defaultValue={JSON.stringify(node.config.input, null, 2)}
                  id="workflow-tool-input"
                  key={`${node.id}-${node.config.toolName}`}
                  onBlur={(event) => {
                    try {
                      const value = JSON.parse(event.target.value) as unknown;
                      if (!(value && typeof value === "object" && !Array.isArray(value))) {
                        throw new Error("Tool input must be a JSON object.");
                      }
                      onUpdate((current) =>
                        current.kind === "tool"
                          ? { ...current, config: { ...current.config, input: value as Record<string, unknown> } }
                          : current,
                      );
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Tool input must be valid JSON.");
                    }
                  }}
                  spellCheck={false}
                />
                <FieldHelp>The object is passed to the selected tool exactly as written.</FieldHelp>
              </div>
            </>
          ) : null}

          {node.kind === "gate" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="workflow-gate-path">Result path</Label>
                <Input
                  id="workflow-gate-path"
                  onChange={(event) =>
                    onUpdate((current) =>
                      current.kind === "gate"
                        ? { ...current, config: { ...current.config, path: event.target.value } }
                        : current,
                    )
                  }
                  placeholder="summarize-risk.text"
                  value={node.config.path}
                />
                <FieldHelp>Reference an upstream step ID and a field from its result.</FieldHelp>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="workflow-gate-operator">Check</Label>
                  <Select
                    onValueChange={(operator: "exists" | "equals" | "not_equals") =>
                      onUpdate((current) =>
                        current.kind === "gate"
                          ? { ...current, config: { ...current.config, operator } }
                          : current,
                      )
                    }
                    value={node.config.operator}
                  >
                    <SelectTrigger id="workflow-gate-operator"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="exists">Has a value</SelectItem>
                      <SelectItem value="equals">Equals</SelectItem>
                      <SelectItem value="not_equals">Does not equal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {node.config.operator !== "exists" ? (
                  <div className="space-y-2">
                    <Label htmlFor="workflow-gate-value">Expected JSON value</Label>
                    <Input
                      defaultValue={JSON.stringify(node.config.value ?? null)}
                      id="workflow-gate-value"
                      key={`${node.id}-${node.config.operator}`}
                      onBlur={(event) => {
                        try {
                          const value = JSON.parse(event.target.value) as unknown;
                          onUpdate((current) =>
                            current.kind === "gate"
                              ? { ...current, config: { ...current.config, value } }
                              : current,
                          );
                        } catch {
                          toast.error("Expected value must be valid JSON.");
                        }
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {node.kind === "trigger" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="workflow-trigger-mode">Start workflow</Label>
                <Select
                  onValueChange={(mode: "manual" | "schedule") =>
                    onUpdate((current) =>
                      current.kind === "trigger"
                        ? {
                            ...current,
                            config:
                              mode === "manual"
                                ? { mode }
                                : {
                                    mode,
                                    cronExpression: "0 9 * * 1-5",
                                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                                  },
                          }
                        : current,
                    )
                  }
                  value={node.config.mode}
                >
                  <SelectTrigger id="workflow-trigger-mode"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manually</SelectItem>
                    <SelectItem value="schedule">On a schedule</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {node.config.mode === "schedule" ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2" htmlFor="workflow-trigger-cron">
                        <Clock3 className="size-3.5 text-muted-foreground" /> Cron expression
                      </Label>
                      <Input
                        id="workflow-trigger-cron"
                        onChange={(event) =>
                          onUpdate((current) =>
                            current.kind === "trigger" && current.config.mode === "schedule"
                              ? { ...current, config: { ...current.config, cronExpression: event.target.value } }
                              : current,
                          )
                        }
                        value={node.config.cronExpression ?? ""}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="workflow-trigger-time-zone">Time zone</Label>
                      <Input
                        id="workflow-trigger-time-zone"
                        onChange={(event) =>
                          onUpdate((current) =>
                            current.kind === "trigger" && current.config.mode === "schedule"
                              ? { ...current, config: { ...current.config, timeZone: event.target.value } }
                              : current,
                          )
                        }
                        value={node.config.timeZone ?? ""}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-xl border bg-muted/30 p-4">
                    <div>
                      <Label htmlFor="workflow-enabled">Schedule enabled</Label>
                      <FieldHelp>Allow Kestrel to start this workflow automatically.</FieldHelp>
                    </div>
                    <Switch checked={enabled} id="workflow-enabled" onCheckedChange={onEnabledChange} />
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {node.kind === "join" ? (
            <div className="rounded-xl border bg-blue-500/6 p-4">
              <div className="flex gap-3">
                <GitMerge className="mt-0.5 size-4 text-blue-600 dark:text-blue-300" />
                <div>
                  <p className="font-medium text-sm">Wait for every branch</p>
                  <FieldHelp>
                    Connect at least two incoming steps. The next step starts after all connected branches finish.
                  </FieldHelp>
                </div>
              </div>
            </div>
          ) : null}

          {node.kind === "output" ? (
            <div className="rounded-xl border bg-rose-500/6 p-4">
              <p className="font-medium text-sm">Workflow result</p>
              <FieldHelp>
                Connect the final step here. Its result becomes the named workflow’s output.
              </FieldHelp>
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t bg-muted/20 px-6 py-4">
          {node.kind !== "trigger" && node.kind !== "output" ? (
            <Button className="sm:mr-auto" onClick={onDelete} variant="ghost">
              <Trash2 className="size-4" /> Delete step
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
