"use client";

import { useEffect, useState } from "react";
import type { Edge } from "@xyflow/react";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  OrganizationSystemsMapSnapshot,
} from "@/lib/organizations/systems-map";
import {
  mergeProviderEstateStates,
  type ProviderEnvironmentState,
} from "@/lib/organizations/systems-map-provider-state";
import {
  EstateCanvas,
  type EstateCanvasNode,
  type EstateCanvasNodeData,
} from "./estate-canvas";

type Selection = EstateCanvasNodeData & { id: string };

export function OrganizationEstateMap({
  snapshot,
}: {
  snapshot: OrganizationSystemsMapSnapshot;
}) {
  const [providerStates, setProviderStates] = useState<ProviderEnvironmentState[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh(environmentId?: string) {
    setRefreshing(true);
    try {
      const response = await fetch(
        `/api/organization/systems-map${environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : ""}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const body = (await response.json()) as {
        providerStates: ProviderEnvironmentState[];
      };
      setProviderStates((current) => mergeProviderEstateStates(current, body.providerStates));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const { nodes, edges } = buildEstateGraph(snapshot, providerStates);
  const selectedEnvironmentId = selection?.environmentId;
  const selectedEnvironment = selectedEnvironmentId
    ? snapshot.environments.find((environment) => environment.id === selectedEnvironmentId)
    : null;
  const providerState = selectedEnvironmentId
    ? providerStates.find((state) => state.environmentId === selectedEnvironmentId)
    : null;
  const selectedPerson = selection?.kind === "person"
    ? snapshot.people.find((person) => `person:${person.id}` === selection.id)
    : null;
  const selectedProjects = selectedPerson
    ? snapshot.projects.filter(
        (project) =>
          project.memberIds.includes(selectedPerson.id) ||
          project.activeMemberIds.includes(selectedPerson.id),
      )
    : [];
  const attentionCount = snapshot.environments.filter((environment) => {
    const provider = providerStates.find((state) => state.environmentId === environment.id);
    return needsAttention(environment.status) || provider?.status === "unavailable" || Boolean(
      provider && (provider.missingMachineCount > 0 || provider.missingVolumeCount > 0 || provider.unlinkedMachineCount > 0 || provider.unlinkedVolumeCount > 0),
    );
  }).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-medium text-muted-foreground text-sm">Organization / Systems map</p>
          <h1 className="mt-1 font-semibold text-3xl tracking-tight">
            {snapshot.organization.name} estate
          </h1>
          <p className="mt-2 max-w-3xl text-muted-foreground text-sm">
            Read-only map of Kestrel-managed environments, workspaces, machines,
            volumes, projects, and members. Provider state refreshes when this map opens or an environment is selected.
          </p>
          <p className="mt-2 text-muted-foreground text-sm">
            {snapshot.environments.length} environments · {attentionCount} need attention · {snapshot.projects.length} projects · {snapshot.people.length} people
          </p>
        </div>
        <Button disabled={refreshing} onClick={() => void refresh()} variant="outline">
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
          Refresh provider state
        </Button>
      </header>

      {snapshot.environments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-medium">No Kestrel-managed estate yet.</p>
            <p className="max-w-md text-muted-foreground text-sm">
              Create an Environment to establish the gateway, workspaces, machines, and volumes shown on this map.
            </p>
            <Button asChild>
              <Link href="/organization">Create environment</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <EstateCanvas
          edges={edges}
          nodes={nodes}
          onSelect={(node) => {
            setSelection({ id: node.id, ...node.data });
            if (node.data.environmentId) void refresh(node.data.environmentId);
          }}
        />
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">{selection?.label ?? "Select a system"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {selection ? (
              <>
                <p className="text-muted-foreground">{selection.detail}</p>
                {selection.status ? <Badge variant={selection.attention ? "destructive" : "outline"}>{selection.status}</Badge> : null}
                {selectedEnvironment ? (
                  <div className="space-y-2 border-t pt-3">
                    <p className="font-medium">Provider confirmation</p>
                    <p className="text-muted-foreground text-xs">
                      {providerState?.status === "live"
                        ? `Live at ${formatDate(providerState.checkedAt)}`
                        : providerState?.lastKnownAt
                          ? `Last provider-confirmed ${formatDate(providerState.lastKnownAt)}`
                          : selectedEnvironment.lastHealthAt
                            ? `Last confirmed by Kestrel ${formatDate(selectedEnvironment.lastHealthAt)}`
                            : "No provider confirmation recorded yet."}
                    </p>
                    {providerState?.message ? <p className="text-muted-foreground text-xs">{providerState.message}</p> : null}
                    {providerState && (providerState.missingMachineCount > 0 || providerState.missingVolumeCount > 0) ? (
                      <p className="text-destructive text-xs">
                        Kestrel expects {providerState.missingMachineCount} machine(s) and {providerState.missingVolumeCount} volume(s) that the provider did not return.
                      </p>
                    ) : null}
                    {providerState && (providerState.unlinkedMachineCount > 0 || providerState.unlinkedVolumeCount > 0) ? (
                      <p className="text-destructive text-xs">
                        Provider inventory contains {providerState.unlinkedMachineCount} machine(s) and {providerState.unlinkedVolumeCount} volume(s) not linked to this Kestrel estate.
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/organization/environments/${selectedEnvironment.id}/runtime`}>Runtime</Link>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/organization/environments/${selectedEnvironment.id}/workspaces`}>Workspaces</Link>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/organization/environments/${selectedEnvironment.id}/activity`}>Activity</Link>
                      </Button>
                    </div>
                  </div>
                ) : null}
                {selectedPerson ? (
                  <div className="space-y-2 border-t pt-3">
                    <p className="font-medium">Related projects</p>
                    {selectedProjects.length > 0 ? (
                      <ul className="space-y-1 text-muted-foreground text-xs">
                        {selectedProjects.map((project) => (
                          <li key={project.id}>
                            {project.name} · {project.threadCount} threads · {project.activeTurnCount} active
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        No active Project relationship.
                      </p>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">Choose a node to inspect its Kestrel state. Selecting an environment refreshes its provider state.</p>
            )}
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  );
}

function buildEstateGraph(
  snapshot: OrganizationSystemsMapSnapshot,
  providerStates: ProviderEnvironmentState[],
): { nodes: EstateCanvasNode[]; edges: Edge[] } {
  const nodes: EstateCanvasNode[] = [];
  const edges: Edge[] = [];
  const providerByEnvironment = new Map(providerStates.map((state) => [state.environmentId, state]));
  const projectColumn = 0;
  const environmentColumn = 360;
  const gatewayColumn = 700;
  const workspaceColumn = 1020;
  const machineColumn = 1340;
  const volumeColumn = 1660;

  snapshot.people.forEach((person, index) => {
    nodes.push(node(`person:${person.id}`, projectColumn, index * 150, {
      kind: "person",
      label: person.name,
      detail: `${person.role} · ${person.threadCount} threads · ${person.activeTurnCount} active · ${person.failedTurnCount} failed`,
      status: person.failedTurnCount > 0 ? "failed work" : person.activeTurnCount > 0 ? "active work" : null,
      attention: person.failedTurnCount > 0,
    }));
  });

  snapshot.projects.forEach((project, index) => {
    const id = `project:${project.id}`;
    nodes.push(node(id, projectColumn + 180, index * 180, {
      kind: "project",
      label: project.name,
      detail: `${project.threadCount} thread${project.threadCount === 1 ? "" : "s"} · ${project.activeTurnCount} active`,
      status: project.activeTurnCount > 0 ? "active work" : null,
      environmentId: project.environmentId,
    }));
    for (const memberId of project.memberIds) {
      edges.push(edge(`person:${memberId}`, id, "member"));
    }
    for (const memberId of project.activeMemberIds) {
      edges.push(edge(`person:${memberId}`, id, "active work"));
    }
    edges.push(edge(id, `environment:${project.environmentId}`, "uses"));
  });

  let verticalOffset = 0;
  for (const environment of snapshot.environments) {
    const provider = providerByEnvironment.get(environment.id);
    const environmentAttention = needsAttention(environment.status) || provider?.status === "unavailable" || Boolean(
      provider && (provider.missingMachineCount > 0 || provider.missingVolumeCount > 0 || provider.unlinkedMachineCount > 0 || provider.unlinkedVolumeCount > 0),
    );
    nodes.push(node(`environment:${environment.id}`, environmentColumn, verticalOffset, {
      kind: "environment",
      label: environment.name,
      detail: `${environment.region} · ${environment.workspaces.length} workspaces`,
      status: provider?.status === "live" ? "provider confirmed" : environment.status,
      attention: environmentAttention,
      environmentId: environment.id,
    }));
    if (environment.gatewayMachineId) {
      const gatewayState = provider?.gateway?.state ?? (
        provider?.status === "live" ? "missing in provider" : "last known gateway"
      );
      nodes.push(node(`gateway:${environment.id}`, gatewayColumn, verticalOffset, {
        kind: "gateway",
        label: "Gateway",
        detail: environment.gatewayMachineId,
        status: gatewayState,
        attention: needsAttention(gatewayState) || gatewayState === "missing in provider",
        environmentId: environment.id,
      }));
      edges.push(edge(`environment:${environment.id}`, `gateway:${environment.id}`, "routes"));
    }
    environment.workspaces.forEach((workspace, workspaceIndex) => {
      const row = verticalOffset + 140 + workspaceIndex * 135;
      const workspaceId = `workspace:${workspace.id}`;
      nodes.push(node(workspaceId, workspaceColumn, row, {
        kind: "workspace",
        label: workspace.name,
        detail: `${workspace.kind} workspace`,
        status: workspace.status,
        attention: needsAttention(workspace.status),
        environmentId: environment.id,
      }));
      edges.push(edge(`environment:${environment.id}`, workspaceId, "contains"));
      if (workspace.projectId) {
        edges.push(edge(`project:${workspace.projectId}`, workspaceId, "runs in"));
      }
      if (workspace.machineId) {
        const machine = provider?.machines.find((item) => item.id === workspace.machineId);
        const machineId = `machine:${workspace.id}`;
        nodes.push(node(machineId, machineColumn, row, {
          kind: "machine",
          label: "Machine",
          detail: workspace.machineId,
          status: machine?.state ?? (
            provider?.status === "live" ? "missing in provider" : "last known"
          ),
          attention: machine ? needsAttention(machine.state) : provider?.status === "live",
          environmentId: environment.id,
        }));
        edges.push(edge(workspaceId, machineId, "runs on"));
      }
      if (workspace.volumeId) {
        const volume = provider?.volumes.find((item) => item.id === workspace.volumeId);
        const volumeId = `volume:${workspace.id}`;
        nodes.push(node(volumeId, volumeColumn, row, {
          kind: "volume",
          label: volume?.name || "Volume",
          detail: workspace.volumeId,
          status: volume?.sizeGb ? `${volume.sizeGb} GB` : (
            provider?.status === "live" ? "missing in provider" : "last known"
          ),
          attention: provider?.status === "live" && !volume,
          environmentId: environment.id,
        }));
        edges.push(edge(workspaceId, volumeId, "persists"));
      }
    });
    verticalOffset += Math.max(300, environment.workspaces.length * 150 + 180);
  }
  return { nodes, edges };
}

function node(id: string, x: number, y: number, data: EstateCanvasNodeData): EstateCanvasNode {
  return { id, type: "estate", position: { x, y }, data };
}

function edge(source: string, target: string, label: string): Edge {
  return { id: `${source}:${target}:${label}`, source, target, label, type: "smoothstep", animated: false };
}

function needsAttention(status: string) {
  return ["failed", "degraded", "destroyed", "unavailable", "missing in provider"].includes(status);
}

function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
