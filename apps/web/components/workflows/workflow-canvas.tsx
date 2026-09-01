"use client";

import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  reconnectEdge,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import {
  Bot,
  CircleStop,
  GitMerge,
  Play,
  ShieldCheck,
  Unlink,
  Wrench,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowNode,
} from "@/lib/workflows/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import "@xyflow/react/dist/style.css";

type CanvasData = {
  workflowNode: WorkflowNode;
  status?: string | null;
};
type CanvasNode = Node<CanvasData, "workflow">;

const icons = {
  trigger: Play,
  kestrel: Bot,
  tool: Wrench,
  gate: ShieldCheck,
  join: GitMerge,
  output: CircleStop,
};

const nodeStyles = {
  trigger: {
    card: "border-emerald-500/45 bg-gradient-to-br from-emerald-500/12 via-background to-background",
    icon: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  kestrel: {
    card: "border-violet-500/50 bg-gradient-to-br from-violet-500/15 via-background to-background",
    icon: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
  tool: {
    card: "border-amber-500/45 bg-gradient-to-br from-amber-500/12 via-background to-background",
    icon: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  gate: {
    card: "border-cyan-500/45 bg-gradient-to-br from-cyan-500/12 via-background to-background",
    icon: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  },
  join: {
    card: "border-blue-500/45 bg-gradient-to-br from-blue-500/12 via-background to-background",
    icon: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  },
  output: {
    card: "border-rose-500/45 bg-gradient-to-br from-rose-500/12 via-background to-background",
    icon: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  },
} as const;

function detail(node: WorkflowNode) {
  if (node.kind === "kestrel") return node.config.instructions;
  if (node.kind === "tool") return node.config.toolName;
  if (node.kind === "gate") return `${node.config.path || "input"} ${node.config.operator.replaceAll("_", " ")}`;
  if (node.kind === "join") return "Wait for all inputs";
  if (node.kind === "trigger") {
    return node.config.mode === "schedule"
      ? `${node.config.cronExpression} · ${node.config.timeZone}`
      : "Run manually";
  }
  return "Collect final result";
}

function WorkflowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const Icon = icons[data.workflowNode.kind];
  const styles = nodeStyles[data.workflowNode.kind];
  return (
    <div
      aria-label={`${data.workflowNode.label}, ${data.workflowNode.kind} step`}
      className={cn(
        "group w-60 rounded-2xl border p-3.5 shadow-md backdrop-blur-sm transition-[box-shadow,border-color,transform]",
        styles.card,
        selected && "-translate-y-0.5 shadow-lg ring-2 ring-primary/55",
        data.status === "failed" && "border-destructive",
      )}
    >
      {data.workflowNode.kind !== "trigger" ? <Handle position={Position.Top} type="target" /> : null}
      <div className="flex items-start gap-2">
        <span className={cn("rounded-xl p-2", styles.icon)}><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate font-medium text-sm">{data.workflowNode.label}</p>
            {data.status ? <span className="text-[10px] text-muted-foreground uppercase">{data.status.replaceAll("_", " ")}</span> : null}
          </div>
          <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">{detail(data.workflowNode)}</p>
          <p className="mt-2 font-medium text-[9px] text-muted-foreground uppercase tracking-[0.16em]">
            {data.workflowNode.kind === "kestrel" ? "Kestrel work" : data.workflowNode.kind}
          </p>
        </div>
      </div>
      {data.workflowNode.kind !== "output" ? <Handle position={Position.Bottom} type="source" /> : null}
    </div>
  );
}

const nodeTypes = { workflow: WorkflowNodeCard };
const defaultEdgeOptions = { interactionWidth: 28 };
const editableDeleteKeys = ["Backspace", "Delete"];

function toCanvasNodes(definition: WorkflowDefinition, statuses?: Record<string, string>): CanvasNode[] {
  return definition.nodes.map((workflowNode) => ({
    id: workflowNode.id,
    type: "workflow",
    position: workflowNode.position,
    data: { workflowNode, status: statuses?.[workflowNode.id] },
  }));
}

export function WorkflowCanvas({
  definition,
  editable = false,
  statuses,
  onChange,
  onSelect,
  onOpenNode,
}: {
  definition: WorkflowDefinition;
  editable?: boolean;
  statuses?: Record<string, string>;
  onChange?: (definition: WorkflowDefinition) => void;
  onSelect?: (nodeId: string) => void;
  onOpenNode?: (nodeId: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  const isDark = themeMounted && resolvedTheme === "dark";
  const [nodes, setNodes] = useNodesState<CanvasNode>(toCanvasNodes(definition, statuses));
  const [edges, setEdges] = useEdgesState<Edge>(definition.edges);
  const publishRequested = useRef(false);
  const selectedEdge = editable
    ? edges.find((edge) => edge.selected)
    : undefined;

  useEffect(() => setThemeMounted(true), []);

  useEffect(() => {
    publishRequested.current = false;
    setNodes(toCanvasNodes(definition, statuses));
    setEdges(definition.edges);
  }, [definition, setEdges, setNodes, statuses]);

  useEffect(() => {
    if (!publishRequested.current) return;
    publishRequested.current = false;
    onChange?.({
      version: 1,
      nodes: nodes.map((node) => ({ ...node.data.workflowNode, position: node.position })),
      edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    });
  }, [edges, nodes, onChange]);

  function connect(connection: Connection) {
    publishRequested.current = true;
    setEdges((current) => addEdge({ ...connection, id: `${connection.source}-${connection.target}-${crypto.randomUUID()}` }, current));
  }

  function reconnect(oldEdge: Edge, connection: Connection) {
    publishRequested.current = true;
    setEdges((current) =>
      reconnectEdge(oldEdge, connection, current, { shouldReplaceId: false }),
    );
  }

  function disconnect(edgeId: string) {
    publishRequested.current = true;
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
  }

  return (
    <div
      className="h-full min-h-0 w-full overflow-hidden bg-muted/20"
      data-testid="workflow-canvas"
    >
      <ReactFlow
        className="[&_.react-flow__controls-button:hover]:!bg-accent [&_.react-flow__controls-button]:!border-border [&_.react-flow__controls-button]:!bg-background [&_.react-flow__controls-button]:!fill-foreground [&_.react-flow__controls-button]:!text-foreground [&_.react-flow__controls-button_svg]:!fill-foreground [&_.react-flow__controls]:!bg-background [&_.react-flow__controls]:!border-border [&_.react-flow__controls]:overflow-hidden [&_.react-flow__controls]:rounded-xl [&_.react-flow__controls]:border [&_.react-flow__controls]:shadow-lg [&_.react-flow__controls]:backdrop-blur-md"
        colorMode={isDark ? "dark" : "light"}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={editable ? editableDeleteKeys : null}
        edges={edges}
        edgesFocusable={editable}
        edgesReconnectable={editable}
        elevateEdgesOnSelect={editable}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        maxZoom={1.5}
        minZoom={0.25}
        nodes={nodes}
        nodesConnectable={editable}
        nodesDraggable={editable}
        nodeTypes={nodeTypes}
        onConnect={connect}
        onEdgesChange={(changes) => {
          if (changes.some((change) => change.type !== "select")) {
            publishRequested.current = true;
          }
          setEdges((current) => applyEdgeChanges(changes, current));
        }}
        onNodeClick={(_, node) => onSelect?.(node.id)}
        onNodeDoubleClick={(_, node) => onOpenNode?.(node.id)}
        onNodesChange={(changes) => {
          if (changes.some((change) => change.type !== "dimensions" && change.type !== "select")) {
            publishRequested.current = true;
          }
          setNodes((current) => applyNodeChanges(changes, current));
        }}
        onReconnect={editable ? reconnect : undefined}
        panOnDrag
        proOptions={{ hideAttribution: true }}
        reconnectRadius={20}
        zoomOnDoubleClick={false}
      >
        <Background gap={22} size={1} />
        <Controls position="bottom-left" />
        {selectedEdge ? (
          <Panel
            className="!mt-20 flex items-center gap-2 rounded-xl border bg-background/92 p-1.5 shadow-lg backdrop-blur-xl"
            position="top-center"
          >
            <span className="hidden px-2 text-muted-foreground text-xs sm:inline">
              Drag either endpoint to reconnect
            </span>
            <Button
              aria-label="Disconnect selected connection"
              className="nodrag nopan"
              onClick={(event) => {
                event.stopPropagation();
                disconnect(selectedEdge.id);
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              size="sm"
              variant="ghost"
            >
              <Unlink className="size-4" /> Disconnect
            </Button>
          </Panel>
        ) : null}
        <MiniMap
          bgColor={isDark ? "#18181b" : "#fafafa"}
          className="!m-3 !border-border !bg-background overflow-hidden rounded-xl border shadow-lg backdrop-blur-md"
          maskColor={isDark ? "rgba(9, 9, 11, 0.72)" : "rgba(244, 244, 245, 0.76)"}
          nodeColor={(node) => {
            const workflowNode = (node.data as CanvasData).workflowNode;
            if (workflowNode.kind === "trigger") return "#10b981";
            if (workflowNode.kind === "kestrel") return "#8b5cf6";
            if (workflowNode.kind === "tool") return "#f59e0b";
            if (workflowNode.kind === "gate") return "#06b6d4";
            if (workflowNode.kind === "join") return "#3b82f6";
            return "#f43f5e";
          }}
          pannable
          position="bottom-right"
          style={{ height: 76, width: 116 }}
          zoomable
        />
      </ReactFlow>
    </div>
  );
}
