"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AppConnectionResource,
  Environment,
  EnvironmentAppCapabilityGrant,
  EnvironmentWorkspace,
} from "@/drizzle/schema";

type WorkspaceSetup = {
  environments: Environment[];
  binding: { environmentId: string };
  workspace: EnvironmentWorkspace | null;
  repositories: AppConnectionResource[];
  grants: EnvironmentAppCapabilityGrant[];
  desktopCatalog: Array<{
    id: string;
    environmentId: string;
    label: string;
    availability: "available" | "missing";
  }>;
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
  const [sourceType, setSourceType] = useState<
    "blank" | "desktop" | "github"
  >("blank");
  const [resourceId, setResourceId] = useState("");

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
        if (payload.workspace?.sourceType === "desktop") {
          setSourceType("desktop");
          setResourceId(payload.workspace.desktopCatalogId ?? "");
        } else if (payload.workspace?.sourceType === "github") {
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

  const repositories = useMemo(() => {
    if (!setup) return [];
    const repositoryReadEnabled = setup.grants.some(
      (grant) =>
        grant.environmentId === environmentId &&
        grant.appKey === "github" &&
        grant.capabilityKey === "repository.read" &&
        grant.enabled &&
        grant.approvalMode !== "deny"
    );
    return repositoryReadEnabled ? setup.repositories : [];
  }, [environmentId, setup]);

  const selectedEnvironment = setup?.environments.find(
    (environment) => environment.id === environmentId,
  );
  const desktopCatalog = useMemo(
    () =>
      setup?.desktopCatalog.filter(
        (workspace) => workspace.environmentId === environmentId,
      ) ?? [],
    [environmentId, setup],
  );

  function selectEnvironment(nextEnvironmentId: string) {
    setEnvironmentId(nextEnvironmentId);
    const nextEnvironment = setup?.environments.find(
      (environment) => environment.id === nextEnvironmentId,
    );
    if (nextEnvironment?.provider === "desktop") {
      const candidates =
        setup?.desktopCatalog.filter(
          (workspace) =>
            workspace.environmentId === nextEnvironmentId &&
            workspace.availability === "available",
        ) ?? [];
      setSourceType("desktop");
      setResourceId(candidates.length === 1 ? candidates[0]!.id : "");
      return;
    }
    if (sourceType === "desktop") setSourceType("blank");
    setResourceId("");
  }

  async function moveProjectEnvironment(nextEnvironmentId: string) {
    const response = await fetch(`/api/projects/${projectId}/environment`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentId: nextEnvironmentId }),
    });
    const payload = (await response.json()) as {
      binding?: { environmentId: string };
      error?: string;
    };
    if (!(response.ok && payload.binding)) {
      throw new Error(payload.error ?? "Project Environment move failed.");
    }
    return payload.binding;
  }

  async function rollbackProjectEnvironment(committedEnvironmentId: string) {
    try {
      const binding = await moveProjectEnvironment(committedEnvironmentId);
      setSetup((current) => (current ? { ...current, binding } : current));
      setEnvironmentId(binding.environmentId);
      return true;
    } catch {
      return false;
    }
  }

  async function save() {
    if (!setup) return;
    const committedEnvironmentId = setup.binding.environmentId;
    const moving = committedEnvironmentId !== environmentId;
    let environmentMoved = false;
    try {
      if (moving && selectedEnvironment?.provider !== "desktop") {
        const binding = await moveProjectEnvironment(environmentId);
        environmentMoved = true;
        setSetup((current) => (current ? { ...current, binding } : current));
      }
      const response = await fetch(`/api/projects/${projectId}/workspace`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environmentId,
          source:
            sourceType === "desktop"
              ? { type: "desktop", catalogId: resourceId }
              : sourceType === "github"
                ? { type: "github", resourceId }
                : { type: "blank" },
        }),
      });
      const payload = (await response.json()) as {
        workspace?: EnvironmentWorkspace;
        error?: string;
      };
      if (!(response.ok && payload.workspace)) {
        throw new Error(payload.error ?? "Workspace setup failed.");
      }
      setSetup((current) =>
        current
          ? {
              ...current,
              binding: { environmentId },
              workspace: payload.workspace!,
            }
          : current,
      );
      toast.success(
        moving
          ? "Project Environment and Workspace updated."
          : "Project Workspace provisioning requested.",
      );
    } catch (error) {
      const rolledBack = environmentMoved
        ? await rollbackProjectEnvironment(committedEnvironmentId)
        : true;
      toast.error(
        `${error instanceof Error ? error.message : "Workspace setup failed."}${rolledBack ? "" : " The Environment changed, but automatic rollback failed."}`,
      );
    }
  }

  return (
    <AppPage className="max-w-3xl">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href={`/projects/${projectId}`}>← {projectName}</Link>
        </Button>
      </div>
      <PageHeader
        description="Choose the Environment and persistent filesystem source used by every Thread in this Project."
        eyebrow="Project"
        title="Project Workspace"
      />
      <Card>
        <CardHeader>
          <p className="text-muted-foreground text-sm">
            Environment and source changes apply to future work after they are
            saved.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Environment</Label>
            <Select
              disabled={!canEdit}
              onValueChange={selectEnvironment}
              value={environmentId}
            >
              <SelectTrigger aria-label="Project Environment">
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
          {selectedEnvironment?.provider === "desktop" ? (
            <div className="space-y-2">
              <Label>Synced desktop project</Label>
              <Select
                disabled={!canEdit}
                onValueChange={setResourceId}
                value={resourceId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select synced project" />
                </SelectTrigger>
                <SelectContent>
                  {desktopCatalog.map((workspace) => (
                    <SelectItem
                      disabled={workspace.availability !== "available"}
                      key={workspace.id}
                      value={workspace.id}
                    >
                      {workspace.label}
                      {workspace.availability === "missing"
                        ? " · unavailable"
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
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
          )}
          {selectedEnvironment?.provider !== "desktop" && sourceType === "github" ? (
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
                ((sourceType === "github" || sourceType === "desktop") &&
                  !resourceId)
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
    </AppPage>
  );
}
