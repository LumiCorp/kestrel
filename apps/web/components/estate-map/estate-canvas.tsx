"use client";

import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Boxes, CircleAlert, Container, Database, Network, Server, UserRound } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";

export type EstateNodeKind =
  | "environment"
  | "gateway"
  | "workspace"
  | "machine"
  | "volume"
  | "project"
  | "person";

export type EstateCanvasNodeData = {
  kind: EstateNodeKind;
  label: string;
  detail: string;
  status?: string | null;
  attention?: boolean;
  environmentId?: string;
};

export type EstateCanvasNode = Node<EstateCanvasNodeData, "estate">;

const icons = {
  environment: Network,
  gateway: Container,
  workspace: Boxes,
  machine: Server,
  volume: Database,
  project: Boxes,
  person: UserRound,
};

function EstateNode({ data, selected }: NodeProps<EstateCanvasNode>) {
  const Icon = icons[data.kind];
  return (
    <div
      className={cn(
        "min-w-48 rounded-xl border bg-background px-3 py-2.5 shadow-sm transition-shadow",
        selected && "ring-2 ring-primary/45",
        data.attention && "border-destructive/60",
      )}
    >
      <Handle className="opacity-0" position={Position.Left} type="target" />
      <div className="flex items-start gap-2">
        <div className="rounded-md bg-muted p-1.5 text-muted-foreground">
          <Icon className="size-3.5" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">{data.label}</p>
          <p className="mt-0.5 truncate text-muted-foreground text-xs">
            {data.detail}
          </p>
        </div>
      </div>
      {data.status ? (
        <p
          className={cn(
            "mt-2 flex items-center gap-1 text-[11px] capitalize",
            data.attention ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {data.attention ? <CircleAlert className="size-3" /> : null}
          {data.status}
        </p>
      ) : null}
      <Handle className="opacity-0" position={Position.Right} type="source" />
    </div>
  );
}

const nodeTypes = { estate: EstateNode };

export function EstateCanvas({
  nodes,
  edges,
  onSelect,
}: {
  nodes: EstateCanvasNode[];
  edges: Edge[];
  onSelect: (node: EstateCanvasNode) => void;
}) {
  return (
    <div className="h-[min(70vh,760px)] min-h-130 overflow-hidden rounded-xl border bg-muted/20">
      <ReactFlow
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        maxZoom={1.3}
        minZoom={0.3}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node)}
        panOnDrag
        proOptions={{ hideAttribution: true }}
        zoomOnDoubleClick={false}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
