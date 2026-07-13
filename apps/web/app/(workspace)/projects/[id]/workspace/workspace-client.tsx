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

type WorkspaceSetup = {
  environments: Environment[];
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

  useEffect(() => {
    void fetch(`/api/projects/${projectId}/workspace`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Project Workspace is unavailable.");
        const payload = (await response.json()) as WorkspaceSetup;
        setSetup(payload);
        setEnvironmentId(
          payload.workspace?.environmentId ?? payload.environments[0]?.id ?? ""
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
      current ? { ...current, workspace: payload.workspace! } : current
    );
    toast.success("Project Workspace provisioning requested.");
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
              disabled={
                !canEdit ||
                Boolean(
                  setup?.workspace && setup.workspace.status !== "requested"
                )
              }
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
                  setup?.workspace && setup.workspace.status !== "requested"
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
                ? `Status: ${setup.workspace.status}`
                : "The Workspace will be created lazily and retained across Threads."}
            </div>
            <Button
              disabled={
                !(canEdit && environmentId) ||
                (sourceType === "github" && !resourceId)
              }
              onClick={() => void save()}
            >
              Configure Workspace
            </Button>
          </div>
        </CardContent>
      </Card>
    </AppPage>
  );
}
