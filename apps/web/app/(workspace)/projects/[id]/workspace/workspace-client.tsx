"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppPage } from "@/components/app-page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  Environment,
  EnvironmentCapabilityGrant,
  EnvironmentWorkspace,
  ToolConnectionResource,
} from "@/drizzle/schema";

type ProjectMcpCapability = {
  id: string;
  capabilityKey: string;
  displayName: string | null;
  description: string | null;
  kind: string;
  approvalMode: "auto" | "ask" | "deny";
  serverName: string;
};

type ProjectMcpRestriction = {
  capabilityId: string;
  enabled: boolean;
  approvalMode: "auto" | "ask" | "deny";
};

type WorkspaceSetup = {
  environments: Environment[];
  binding: { environmentId: string };
  workspace: EnvironmentWorkspace | null;
  repositories: ToolConnectionResource[];
  grants: EnvironmentCapabilityGrant[];
};

export function ProjectWorkspaceClient({
  canEdit,
  projectId,
  projectName,
}: {
  canEdit: boolean;
  projectId: string;
  projectName: string;
}) {
  const [setup, setSetup] = useState<WorkspaceSetup | null>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [sourceType, setSourceType] = useState<"blank" | "github">("blank");
  const [resourceId, setResourceId] = useState("");
  const [mcpCapabilities, setMcpCapabilities] = useState<
    ProjectMcpCapability[]
  >([]);
  const [mcpRestrictions, setMcpRestrictions] = useState<
    ProjectMcpRestriction[]
  >([]);

  useEffect(() => {
    void fetch(`/api/projects/${projectId}/workspace`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Project Workspace is unavailable.");
        const payload = (await response.json()) as WorkspaceSetup;
        setSetup(payload);
        setEnvironmentId(
          payload.binding.environmentId ??
            payload.workspace?.environmentId ??
            payload.environments[0]?.id ??
            ""
        );
        if (payload.workspace?.sourceType === "github") {
          setSourceType("github");
          setResourceId(payload.workspace.sourceResourceId ?? "");
        }
      })
      .catch((error: unknown) =>
        toast.error(
          error instanceof Error ? error.message : "Workspace unavailable."
        )
      );
  }, [projectId]);

  useEffect(() => {
    void fetch(`/api/projects/${projectId}/capabilities`)
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Project capabilities are unavailable.");
        return (await response.json()) as {
          mcpCapabilities?: ProjectMcpCapability[];
          mcpRestrictions?: ProjectMcpRestriction[];
        };
      })
      .then((payload) => {
        setMcpCapabilities(payload.mcpCapabilities ?? []);
        setMcpRestrictions(payload.mcpRestrictions ?? []);
      })
      .catch((error: unknown) =>
        toast.error(
          error instanceof Error
            ? error.message
            : "Project capabilities are unavailable."
        )
      );
  }, [projectId]);

  const repositories = useMemo(() => {
    if (!setup) return [];
    const grantsAllRepositories = setup.grants.some(
      (grant) =>
        grant.environmentId === environmentId && grant.resourceId === null
    );
    const granted = new Set(
      setup.grants
        .filter((grant) => grant.environmentId === environmentId)
        .map((grant) => grant.resourceId)
    );
    return setup.repositories.filter(
      (repository) => grantsAllRepositories || granted.has(repository.id)
    );
  }, [environmentId, setup]);

  async function save() {
    if (!setup) return;
    if (setup.binding.environmentId !== environmentId) {
      const moveResponse = await fetch(
        `/api/projects/${projectId}/environment`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environmentId }),
        }
      );
      const movePayload = (await moveResponse.json()) as {
        binding?: { environmentId: string };
        error?: string;
      };
      if (!(moveResponse.ok && movePayload.binding)) {
        toast.error(movePayload.error ?? "Project Environment move failed.");
        return;
      }
      setSetup((current) =>
        current ? { ...current, binding: movePayload.binding! } : current
      );
    }
    const response = await fetch(`/api/projects/${projectId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environmentId,
        source:
          sourceType === "github"
            ? {
                type: "github",
                resourceId,
              }
            : { type: "blank" },
      }),
    });
    const payload = (await response.json()) as {
      workspace?: EnvironmentWorkspace;
      error?: string;
    };
    if (!(response.ok && payload.workspace)) {
      toast.error(payload.error ?? "Workspace setup failed.");
      return;
    }
    setSetup((current) =>
      current
        ? {
            ...current,
            binding: { environmentId },
            workspace: payload.workspace!,
          }
        : current
    );
    toast.success(
      setup.binding.environmentId === environmentId
        ? "Project Workspace provisioning requested."
        : "Project Environment moved and its new Workspace was requested."
    );
  }

  async function setMcpRestriction(
    capability: ProjectMcpCapability,
    approvalMode: "auto" | "ask" | "deny"
  ) {
    const response = await fetch(`/api/projects/${projectId}/capabilities`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mcpCapabilityId: capability.id,
        enabled: approvalMode !== "deny",
        approvalMode,
      }),
    });
    const payload = (await response.json()) as {
      mcpRestriction?: ProjectMcpRestriction;
      error?: string;
    };
    if (!(response.ok && payload.mcpRestriction)) {
      toast.error(payload.error ?? "Project MCP restriction failed.");
      return;
    }
    setMcpRestrictions((current) => [
      ...current.filter(
        (restriction) => restriction.capabilityId !== capability.id
      ),
      payload.mcpRestriction!,
    ]);
    toast.success("Project MCP access updated.");
  }

  return (
    <AppPage className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-6">
        <Button asChild size="sm" variant="ghost">
          <Link href={`/projects/${projectId}`}>← {projectName}</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Project Workspace</CardTitle>
          <p className="text-muted-foreground text-sm">
            Choose the organization Environment and the persistent filesystem
            source used by every Thread in this Project.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Environment</Label>
            <Select
              disabled={!canEdit}
              onValueChange={setEnvironmentId}
              value={environmentId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select Environment" />
              </SelectTrigger>
              <SelectContent>
                {setup?.environments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name} · {environment.region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Source</Label>
            <Select
              disabled={
                !canEdit ||
                Boolean(
                  setup?.workspace &&
                    setup.workspace.environmentId === environmentId &&
                    setup.workspace.status !== "requested"
                )
              }
              onValueChange={(value) =>
                setSourceType(value as "blank" | "github")
              }
              value={sourceType}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blank">Blank Workspace</SelectItem>
                <SelectItem value="github">GitHub repository</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {sourceType === "github" ? (
            <div className="space-y-2">
              <Label>Repository granted to this Environment</Label>
              <Select
                disabled={!canEdit}
                onValueChange={setResourceId}
                value={resourceId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((repository) => (
                    <SelectItem key={repository.id} value={repository.id}>
                      {repository.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex items-center justify-between border-t pt-4">
            <div className="text-muted-foreground text-sm">
              {setup?.workspace
                ? setup.binding.environmentId === environmentId
                  ? `Status: ${setup.workspace.status}`
                  : "Moving creates an isolated Workspace in the selected Environment. Active runs block the move."
                : "The Workspace will be created lazily and retained across Threads."}
            </div>
            <Button
              disabled={
                !(canEdit && environmentId) ||
                (sourceType === "github" && !resourceId)
              }
              onClick={() => void save()}
            >
              {setup?.binding.environmentId === environmentId
                ? "Configure Workspace"
                : "Move and Configure"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Project MCP capabilities</CardTitle>
          <p className="text-muted-foreground text-sm">
            Select a subset of capabilities approved by this Environment. A
            Project can require more approval or deny access, but cannot widen
            the Environment ceiling.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {mcpCapabilities.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This Environment has no approved MCP capabilities.
            </p>
          ) : (
            mcpCapabilities.map((capability) => {
              const restriction = mcpRestrictions.find(
                (candidate) => candidate.capabilityId === capability.id
              );
              const selected = restriction?.enabled
                ? restriction.approvalMode
                : "deny";
              return (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md border p-3"
                  key={capability.id}
                >
                  <div className="mr-auto min-w-0">
                    <p className="truncate font-medium text-sm">
                      {capability.displayName ?? capability.capabilityKey}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {capability.serverName} · {capability.kind}
                    </p>
                  </div>
                  {(["auto", "ask", "deny"] as const).map((mode) => (
                    <Button
                      disabled={
                        !canEdit ||
                        (mode === "auto" && capability.approvalMode !== "auto")
                      }
                      key={mode}
                      onClick={() => void setMcpRestriction(capability, mode)}
                      size="sm"
                      variant={selected === mode ? "default" : "outline"}
                    >
                      {mode}
                    </Button>
                  ))}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </AppPage>
  );
}
