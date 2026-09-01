"use client";

import {
  ArrowLeft,
  Bot,
  GitBranch,
  GitMerge,
  Play,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createStarterWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
  validateWorkflowDefinition,
} from "@/lib/workflows/contracts";
import { isWorkflowModelSupported } from "@/lib/workflows/model-policy";
import { cn } from "@/lib/utils";
import { WorkflowCanvas } from "./workflow-canvas";
import {
  WorkflowNodeDialog,
  type WorkflowToolOption,
} from "./workflow-node-dialog";

type ProjectOption = {
  id: string;
  name: string;
  canCreateWorkflow: boolean;
};

type WorkflowModel = {
  id: string;
  name: string;
  provider: string;
  rawModelId: string;
  isDefault: boolean;
};

type ProjectAppsResponse = {
  apps?: Array<{
    enabled: boolean;
    dependencyReady: boolean;
    app: {
      displayName: string;
      connectionRequirement: "required" | "optional" | "none";
    };
    attachedConnections: Array<{ status: string }>;
    capabilities: Array<{
      displayName: string;
      description: string;
      enabled: boolean;
      resourceReady: boolean;
      runtimeName: string | null;
      inputSchema: Record<string, unknown>;
      workflowUse: "native" | "action" | "hidden";
      descriptorContractRevision: string | null;
    }>;
  }>;
  error?: string;
};

export type EditableWorkflow = {
  id: string;
  project: { id: string; name: string };
  title: string;
  description: string;
  modelId: string;
  enabled: boolean;
  activeVersionId: string | null;
  state: "Draft" | "Active" | "Needs attention";
  attentionMessage: string | null;
  currentVersion: number;
  definition: WorkflowDefinition;
  permissions: { canEdit: boolean; canRun: boolean; canDelete: boolean };
};

const addableKinds = ["kestrel", "tool", "gate", "join"] as const;

function ActivationToolSummary({
  node,
  definition,
}: {
  node: Extract<WorkflowNode, { kind: "tool" }>;
  definition: WorkflowDefinition;
}) {
  const input = node.config.input;
  if (node.config.toolName === "exec_command") {
    const command = typeof input.command === "string" ? input.command : "Command unavailable";
    const cwd = typeof input.cwd === "string" ? input.cwd : ".";
    const envNames = Array.isArray(input.envNames)
      ? input.envNames.filter((name): name is string => typeof name === "string")
      : input.env && typeof input.env === "object" && !Array.isArray(input.env)
        ? Object.keys(input.env)
        : [];
    return (
      <div className="rounded-lg border px-3 py-2" key={node.id}>
        <p className="font-medium">{node.label}</p>
        <p className="line-clamp-2 break-all font-mono text-muted-foreground text-xs" title={command}>
          {command}
        </p>
        <p className="mt-1 text-muted-foreground text-xs">
          Folder: {cwd} · Environment: {envNames.length ? envNames.join(", ") : "None"}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border px-3 py-2" key={node.id}>
      <p className="font-medium">{node.label}</p>
      <p className="text-muted-foreground text-xs">{node.config.toolName}</p>
      <p className="truncate font-mono text-muted-foreground text-xs" title={JSON.stringify(input)}>
        {JSON.stringify(input)}
      </p>
      {Object.entries(node.config.inputBindings).map(([pointer, binding]) => {
        const source = definition.nodes.find((candidate) => candidate.id === binding.sourceNodeId);
        return <p className="mt-1 w-fit rounded-full bg-muted px-2 py-0.5 text-xs" key={pointer}>
          {pointer.slice(1).replaceAll("/", " › ")} · {source?.label ?? "Kestrel step"} → Response text
        </p>;
      })}
    </div>
  );
}

const palette = {
  kestrel: {
    icon: Bot,
    label: "Kestrel",
    help: "Add a coarse Kestrel work step",
    className: "text-violet-600 hover:bg-violet-500/12 dark:text-violet-300",
  },
  tool: {
    icon: Wrench,
    label: "Action",
    help: "Add a consequential project action",
    className: "text-amber-700 hover:bg-amber-500/12 dark:text-amber-300",
  },
  gate: {
    icon: ShieldCheck,
    label: "Gate",
    help: "Add a result condition",
    className: "text-cyan-700 hover:bg-cyan-500/12 dark:text-cyan-300",
  },
  join: {
    icon: GitMerge,
    label: "Join",
    help: "Wait for connected branches",
    className: "text-blue-700 hover:bg-blue-500/12 dark:text-blue-300",
  },
} as const;

function newNode(kind: (typeof addableKinds)[number], index: number): WorkflowNode {
  const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
  const position = {
    x: 340,
    y: 80 + index * 180,
  };
  if (kind === "kestrel") {
    return {
      id,
      kind,
      label: "Kestrel step",
      position,
      config: { instructions: "Describe the work Kestrel should complete." },
    };
  }
  if (kind === "tool") {
    return {
      id,
      kind,
      label: "Action",
      position,
      config: { toolName: "", input: {}, inputBindings: {} },
    };
  }
  if (kind === "gate") {
    return {
      id,
      kind,
      label: "Check result",
      position,
      config: { path: "", operator: "exists" },
    };
  }
  return { id, kind, label: "Wait for branches", position, config: { mode: "all" } };
}

function replaceNode(
  definition: WorkflowDefinition,
  node: WorkflowNode,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((candidate) =>
      candidate.id === node.id ? node : candidate,
    ),
  };
}

function toolsFromApps(response: ProjectAppsResponse): WorkflowToolOption[] {
  const tools = new Map<string, WorkflowToolOption>();
  for (const configuration of response.apps ?? []) {
    const hasConnection =
      configuration.app.connectionRequirement !== "required" ||
      configuration.attachedConnections.some(
        (connection) =>
          connection.status === "connected" || connection.status === "degraded",
      );
    if (!(configuration.enabled && configuration.dependencyReady && hasConnection)) {
      continue;
    }
    for (const capability of configuration.capabilities) {
      if (capability.workflowUse !== "action") continue;
      if (
        !(
          capability.enabled &&
          capability.resourceReady &&
          capability.runtimeName
        )
      ) {
        continue;
      }
      tools.set(capability.runtimeName, {
        name: capability.runtimeName,
        label: capability.displayName,
        description: capability.description,
        appName: configuration.app.displayName,
        inputSchema: capability.inputSchema,
      });
    }
  }
  return [...tools.values()].sort((left, right) =>
    `${left.appName} ${left.label}`.localeCompare(`${right.appName} ${right.label}`),
  );
}

function upstreamKestrelSources(definition: WorkflowDefinition, targetNodeId: string | undefined) {
  if (!targetNodeId) return [];
  const incoming = new Map<string, string[]>();
  for (const node of definition.nodes) incoming.set(node.id, []);
  for (const edge of definition.edges) incoming.get(edge.target)?.push(edge.source);
  const ancestors = new Set<string>();
  const pending = [...(incoming.get(targetNodeId) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    pending.push(...(incoming.get(current) ?? []));
  }
  return definition.nodes
    .filter((candidate) => candidate.kind === "kestrel" && ancestors.has(candidate.id))
    .map((candidate) => ({ id: candidate.id, label: candidate.label }));
}

export function WorkflowEditor({
  initialWorkflow,
  projects,
}: {
  initialWorkflow: EditableWorkflow | null;
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const initialModelId = initialWorkflow?.modelId ?? null;
  const editableProjects = projects.filter(
    (project) => project.canCreateWorkflow,
  );
  const [projectId, setProjectId] = useState(
    initialWorkflow?.project.id ?? editableProjects[0]?.id ?? "",
  );
  const [title, setTitle] = useState(
    initialWorkflow?.title ?? "Untitled workflow",
  );
  const [description, setDescription] = useState(
    initialWorkflow?.description ?? "",
  );
  const [modelId, setModelId] = useState(initialWorkflow?.modelId ?? "");
  const [enabled, setEnabled] = useState(initialWorkflow?.enabled ?? false);
  const [activationOpen, setActivationOpen] = useState(false);
  const [definition, setDefinition] = useState<WorkflowDefinition>(
    initialWorkflow?.definition ?? createStarterWorkflowDefinition(),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [models, setModels] = useState<WorkflowModel[]>([]);
  const [modelWarning, setModelWarning] = useState("");
  const [tools, setTools] = useState<WorkflowToolOption[]>([]);
  const [nativeAccess, setNativeAccess] = useState<Array<{ app: string; capabilities: string[] }>>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(!initialWorkflow);
  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const selected = useMemo(
    () => definition.nodes.find((node) => node.id === selectedId) ?? null,
    [definition.nodes, selectedId],
  );
  const selectedProject = editableProjects.find(
    (project) => project.id === projectId,
  );
  const selectedModel = models.find((model) => model.id === modelId);
  const scheduled =
    definition.nodes.find((node) => node.kind === "trigger")?.config.mode ===
    "schedule";

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void fetch(
      `/api/models/approved?modality=language&projectId=${encodeURIComponent(projectId)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as {
          models?: WorkflowModel[];
          error?: string;
        };
        if (!(response.ok && result.models)) {
          throw new Error(result.error ?? "Models could not be loaded.");
        }
        const supportedModels = result.models.filter(isWorkflowModelSupported);
        setModels(supportedModels);
        setModelId((current) =>
          supportedModels.some((model) => model.id === current)
            ? current
            : initialModelId && current === initialModelId
              ? ""
              : (supportedModels.find((model) => model.isDefault)?.id ??
                supportedModels[0]?.id ??
                ""),
        );
        const savedModel = initialModelId
          ? result.models.find((model) => model.id === initialModelId)
          : null;
        const savedModelNeedsReplacement = Boolean(
          initialModelId &&
            !supportedModels.some((model) => model.id === initialModelId),
        );
        setModelWarning(
          savedModelNeedsReplacement
            ? savedModel && !isWorkflowModelSupported(savedModel)
              ? "This workflow uses GLM-5.2, which is not supported. Choose another model before saving or running it."
              : "This workflow's saved model is no longer available. Choose another model before saving or running it."
            : "",
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          toast.error(
            error instanceof Error ? error.message : "Models could not be loaded.",
          );
        }
      });
    return () => controller.abort();
  }, [initialModelId, projectId]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setToolsLoading(true);
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/apps`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as ProjectAppsResponse;
        if (!response.ok) {
          throw new Error(result.error ?? "Project tools could not be loaded.");
        }
        setTools(toolsFromApps(result));
        setNativeAccess((result.apps ?? []).flatMap((app) => {
          const capabilities = app.capabilities
            .filter((capability) => capability.enabled && capability.resourceReady && capability.workflowUse === "native")
            .map((capability) => capability.displayName);
          return app.enabled && app.dependencyReady && capabilities.length
            ? [{ app: app.app.displayName, capabilities }]
            : [];
        }));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setTools([]);
          setNativeAccess([]);
          toast.error(
            error instanceof Error
              ? error.message
              : "Project tools could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setToolsLoading(false);
      });
    return () => controller.abort();
  }, [projectId]);

  function updateSelected(update: (node: WorkflowNode) => WorkflowNode) {
    if (!selected) return;
    setDefinition((current) => replaceNode(current, update(selected)));
  }

  function addNode(kind: (typeof addableKinds)[number]) {
    const node = newNode(kind, definition.nodes.length);
    setDefinition((current) => ({
      ...current,
      nodes: [...current.nodes, node],
    }));
    setSelectedId(node.id);
    setNodeDialogOpen(true);
  }

  function openNode(nodeId: string) {
    setSelectedId(nodeId);
    setNodeDialogOpen(true);
  }

  function removeSelected() {
    if (!selected || selected.kind === "trigger" || selected.kind === "output") {
      return;
    }
    setDefinition((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== selected.id),
      edges: current.edges.filter(
        (edge) => edge.source !== selected.id && edge.target !== selected.id,
      ),
    }));
    setNodeDialogOpen(false);
    setSelectedId(null);
  }

  async function generate() {
    if (!(projectId && modelId && generatePrompt.trim())) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/workflows/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description: generatePrompt, modelId }),
        },
      );
      const result = (await response.json()) as {
        definition?: WorkflowDefinition;
        error?: string;
      };
      if (!(response.ok && result.definition)) {
        throw new Error(
          result.error ?? "Kestrel could not generate the graph.",
        );
      }
      setDefinition(result.definition);
      setSelectedId(null);
      setGeneratorOpen(false);
      toast.success("Graph generated. Review and save it.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Kestrel could not generate the graph.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!(projectId && modelId && title.trim())) return;
    try {
      validateWorkflowDefinition(definition);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The graph is invalid.",
      );
      return;
    }
    setBusy(true);
    try {
      const url = initialWorkflow
        ? `/api/projects/${encodeURIComponent(initialWorkflow.project.id)}/workflows/${encodeURIComponent(initialWorkflow.id)}`
        : `/api/projects/${encodeURIComponent(projectId)}/workflows`;
      const response = await fetch(url, {
        method: initialWorkflow ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          modelId,
          enabled: Boolean(scheduled && enabled),
          definition,
        }),
      });
      const result = (await response.json()) as {
        workflow?: { id: string };
        error?: string;
      };
      if (!(response.ok && result.workflow)) {
        throw new Error(result.error ?? "Workflow could not be saved.");
      }
      toast.success(
        initialWorkflow ? "Draft saved." : "Workflow draft created.",
      );
      router.push(`/workflows/${result.workflow.id}`);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Workflow could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!initialWorkflow) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(initialWorkflow.project.id)}/workflows/${encodeURIComponent(initialWorkflow.id)}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: crypto.randomUUID(), input: {} }),
        },
      );
      const result = (await response.json()) as {
        runId?: string;
        error?: string;
      };
      if (!(response.ok && result.runId)) {
        throw new Error(result.error ?? "Workflow could not start.");
      }
      router.push(`/workflows/runs/${result.runId}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Workflow could not start.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!initialWorkflow) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(initialWorkflow.project.id)}/workflows/${encodeURIComponent(initialWorkflow.id)}/activate`,
        { method: "POST" },
      );
      const result = (await response.json()) as { workflow?: unknown; error?: string };
      if (!(response.ok && result.workflow)) {
        throw new Error(result.error ?? "Workflow could not be activated.");
      }
      setActivationOpen(false);
      toast.success("Workflow activated.");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Workflow could not be activated.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="relative h-full min-h-150 w-full overflow-hidden bg-background"
      data-testid="workflow-editor"
    >
      <WorkflowCanvas
        definition={definition}
        editable
        onChange={setDefinition}
        onOpenNode={openNode}
        onSelect={setSelectedId}
      />

      <header className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-3 sm:inset-x-4 sm:top-4">
        <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-2xl border bg-background/88 p-1.5 pr-3 shadow-lg backdrop-blur-xl">
          <Button asChild size="icon" variant="ghost">
            <Link href="/workflows">
              <ArrowLeft className="size-4" />
              <span className="sr-only">Back to workflows</span>
            </Link>
          </Button>
          <span className="hidden rounded-xl bg-violet-500/12 p-2 text-violet-600 sm:inline-flex dark:text-violet-300">
            <GitBranch className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="max-w-48 truncate font-semibold text-sm sm:max-w-72 sm:text-base">
                {title || "Untitled workflow"}
              </h1>
              {initialWorkflow ? (
                <Badge className="hidden sm:inline-flex" variant="outline">
                  {initialWorkflow.state} · v{initialWorkflow.currentVersion}
                </Badge>
              ) : null}
            </div>
            <p className="hidden truncate text-muted-foreground text-xs sm:block">
              {selectedProject?.name ?? "Choose a project"}
              {selectedModel ? ` · ${selectedModel.name}` : ""}
            </p>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2 rounded-2xl border bg-background/88 p-1.5 shadow-lg backdrop-blur-xl">
          {initialWorkflow?.permissions.canRun ? (
            <Button disabled={busy || !selectedModel || !initialWorkflow.activeVersionId} onClick={() => void run()} size="sm" variant="ghost">
              <Play className="size-4" />
              <span className="hidden sm:inline">Run</span>
            </Button>
          ) : null}
          {initialWorkflow?.permissions.canEdit ? (
            <Button
              disabled={busy || !selectedModel}
              onClick={() => setActivationOpen(true)}
              size="sm"
              variant="outline"
            >
              <ShieldCheck className="size-4" />
              <span className="hidden sm:inline">Review &amp; activate</span>
            </Button>
          ) : null}
          <Button onClick={() => setDetailsOpen(true)} size="sm" variant="ghost">
            <SlidersHorizontal className="size-4" />
            <span className="hidden sm:inline">Details</span>
          </Button>
          <Button
            disabled={busy || !modelId || Boolean(initialWorkflow && !initialWorkflow.permissions.canEdit)}
            onClick={() => void save()}
            size="sm"
          >
            <Save className="size-4" />
            <span className="hidden sm:inline">Save draft</span>
            <span className="sr-only sm:hidden">Save draft</span>
          </Button>
        </div>
      </header>

      <div
        aria-label="Workflow tools"
        className="-translate-y-1/2 absolute top-1/2 left-3 z-20 flex flex-col gap-1 rounded-2xl border bg-background/90 p-1.5 shadow-xl backdrop-blur-xl sm:left-4"
        role="toolbar"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Generate workflow"
              className="text-primary hover:bg-primary/10"
              onClick={() => setGeneratorOpen(true)}
              size="icon"
              variant="ghost"
            >
              <WandSparkles className="size-4.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={10}>Describe and generate</TooltipContent>
        </Tooltip>
        <span className="mx-2 my-1 h-px bg-border" />
        {addableKinds.map((kind) => {
          const item = palette[kind];
          const Icon = item.icon;
          return (
            <Tooltip key={kind}>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Add ${item.label} step`}
                  className={cn("relative", item.className)}
                  onClick={() => addNode(kind)}
                  size="icon"
                  variant="ghost"
                >
                  <Icon className="size-4.5" />
                  <span className="absolute right-1 bottom-0.5 text-[10px] leading-none">+</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={10}>{item.help}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-36 sm:bottom-4">
        <p className="hidden rounded-full border bg-background/80 px-3 py-1.5 text-muted-foreground text-xs shadow-sm backdrop-blur-md sm:block">
          Double-click a step to configure · Drag steps to arrange · Select a connection to rewire
        </p>
      </div>

      <Sheet onOpenChange={setDetailsOpen} open={detailsOpen}>
        <SheetContent className="w-[min(92vw,390px)] gap-0 sm:max-w-[390px]">
          <SheetHeader className="border-b px-5 py-5 pr-14">
            <SheetTitle>Workflow details</SheetTitle>
            <SheetDescription>
              Name the workflow and choose its project and model.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-5 p-5">
              <div className="space-y-2">
                <Label>Project</Label>
                <Select
                  disabled={Boolean(initialWorkflow)}
                  onValueChange={setProjectId}
                  value={projectId}
                >
                  <SelectTrigger aria-label="Project"><SelectValue placeholder="Choose project" /></SelectTrigger>
                  <SelectContent>
                    {editableProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  This project controls which models and tools the workflow can use.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="workflow-title">Name</Label>
                <Input
                  id="workflow-title"
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  value={title}
                />
              </div>
              <div className="space-y-2">
                <Label>Model</Label>
                <Select onValueChange={setModelId} value={modelId}>
                  <SelectTrigger aria-label="Model"><SelectValue placeholder="Choose model" /></SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Kestrel steps use this model unless the workflow definition says otherwise.
                </p>
                {modelWarning ? (
                  <p className="text-destructive text-xs">{modelWarning}</p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor="workflow-description">Description</Label>
                <Textarea
                  className="min-h-28 resize-y"
                  id="workflow-description"
                  maxLength={2000}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What this workflow does and when to use it."
                  value={description}
                />
              </div>
            </div>
          </ScrollArea>
          <SheetFooter className="border-t p-4">
            <Button
              disabled={busy || !modelId || Boolean(initialWorkflow && !initialWorkflow.permissions.canEdit)}
              onClick={() => void save()}
            >
              <Save className="size-4" /> Save draft
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Dialog onOpenChange={setActivationOpen} open={activationOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Review &amp; activate version {initialWorkflow?.currentVersion}</DialogTitle>
            <DialogDescription>
              Confirm the workspace access and configured actions this version can use.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3 rounded-xl border bg-muted/30 p-3">
              <div>
                <p className="text-muted-foreground text-xs">Model</p>
                <p className="font-medium">{selectedModel?.name ?? modelId}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Environment</p>
                <p className="font-medium">{selectedProject?.name ?? "Project"} default</p>
              </div>
            </div>
            <div className="rounded-xl border bg-muted/30 p-3">
              <p className="font-medium">Project files</p>
              <p className="text-muted-foreground">
                Kestrel can read and edit files in one isolated Project copy shared by every step in this run.
              </p>
            </div>
            <div className="rounded-xl border bg-muted/30 p-3">
              <p className="font-medium">Kestrel access</p>
              {nativeAccess.length ? nativeAccess.map((group) => (
                <p className="text-muted-foreground" key={group.app}>
                  {group.app}: {group.capabilities.join(", ")}
                </p>
              )) : <p className="text-muted-foreground">No additional App access.</p>}
            </div>
            <div className="space-y-2">
              <p className="font-medium">Configured actions</p>
              {definition.nodes.filter((node) => node.kind === "tool").length ? (
                definition.nodes.filter((node) => node.kind === "tool").map((node) => (
                  <ActivationToolSummary definition={definition} key={node.id} node={node} />
                ))
              ) : (
                <p className="text-muted-foreground">No external actions are configured.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setActivationOpen(false)} variant="ghost">Cancel</Button>
            <Button disabled={busy} onClick={() => void activate()}>
              Activate workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setGeneratorOpen} open={generatorOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="overflow-hidden p-0 sm:max-w-2xl"
        >
          <DialogHeader className="border-b bg-gradient-to-br from-violet-500/12 via-background to-background px-6 py-6 pr-14">
            <DialogTitle>Generate a workflow</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 px-6 py-2">
            <Label htmlFor="workflow-generate">Describe the steps</Label>
            <Textarea
              autoFocus
              className="min-h-40 resize-y text-sm leading-relaxed"
              id="workflow-generate"
              onChange={(event) => setGeneratePrompt(event.target.value)}
              placeholder="Every weekday, gather open issues, have Kestrel summarize risk, require a non-empty summary, then produce the report."
              value={generatePrompt}
            />
            <div className="flex flex-wrap gap-2 text-muted-foreground text-xs">
              <Badge variant="outline">{selectedProject?.name ?? "No project"}</Badge>
              <Badge variant="outline">{selectedModel?.name ?? "Choose model"}</Badge>
            </div>
          </div>
          <DialogFooter className="border-t bg-muted/20 px-6 py-4">
            <Button onClick={() => setGeneratorOpen(false)} variant="ghost">Start manually</Button>
            <Button
              disabled={busy || !generatePrompt.trim() || !modelId}
              onClick={() => void generate()}
            >
              <Sparkles className="size-4" />
              {busy ? "Generating…" : "Generate graph"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WorkflowNodeDialog
        enabled={enabled}
        node={selected}
        onDelete={removeSelected}
        onEnabledChange={setEnabled}
        onOpenChange={setNodeDialogOpen}
        onUpdate={updateSelected}
        open={nodeDialogOpen}
        tools={tools}
        toolsLoading={toolsLoading}
        bindingSources={upstreamKestrelSources(definition, selected?.id)}
      />
    </div>
  );
}
