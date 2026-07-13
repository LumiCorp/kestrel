"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
  ThreadExecutionBinding,
  ToolConnectionResource,
} from "@/drizzle/schema";

type WorkspaceSetup = {
  binding: ThreadExecutionBinding | null;
  environments: Environment[];
  workspace: EnvironmentWorkspace | null;
  repositories: ToolConnectionResource[];
  grants: EnvironmentCapabilityGrant[];
};

export function StandaloneWorkspaceSetup({
  onConfigured,
  threadId,
}: {
  onConfigured: () => void;
  threadId: string;
}) {
  const [setup, setSetup] = useState<WorkspaceSetup | null>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const [sourceType, setSourceType] = useState<"blank" | "github">("blank");
  const [resourceId, setResourceId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/threads/${threadId}/workspace`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Thread Workspace setup is unavailable.");
        }
        const payload = (await response.json()) as WorkspaceSetup;
        if (cancelled) return;
        if (
          payload.workspace &&
          (payload.workspace.status !== "requested" ||
            payload.binding?.source === "thread")
        ) {
          onConfigured();
          return;
        }
        setSetup(payload);
        setEnvironmentId(
          payload.workspace?.environmentId ?? payload.environments[0]?.id ?? ""
        );
        if (payload.workspace?.sourceType === "github") {
          setSourceType("github");
          setResourceId(payload.workspace.sourceResourceId ?? "");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Thread Workspace setup is unavailable."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onConfigured, threadId]);

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
    setSaving(true);
    try {
      const response = await fetch(`/api/threads/${threadId}/workspace`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environmentId,
          source:
            sourceType === "github"
              ? { type: "github", resourceId }
              : { type: "blank" },
        }),
      });
      const payload = (await response.json()) as {
        workspace?: EnvironmentWorkspace;
        error?: string | { message?: string };
      };
      if (!(response.ok && payload.workspace)) {
        const message =
          typeof payload.error === "string"
            ? payload.error
            : payload.error?.message;
        throw new Error(message ?? "Thread Workspace setup failed.");
      }
      toast.success("Thread Workspace provisioning requested.");
      onConfigured();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Thread Workspace setup failed."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-background p-6">
      <div className="mx-auto w-full max-w-3xl">
        <Button asChild className="mb-6" size="sm" variant="ghost">
          <Link href={`/threads/${threadId}`}>
            <ArrowLeft className="size-4" />
            Thread
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Configure this Thread Workspace</CardTitle>
            <p className="text-muted-foreground text-sm">
              Choose the organization Environment and optional GitHub repository
              before Kestrel creates this Thread&apos;s persistent Workspace.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>Environment</Label>
              <Select onValueChange={setEnvironmentId} value={environmentId}>
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
                onValueChange={(value) => {
                  setSourceType(value as "blank" | "github");
                  if (value === "blank") setResourceId("");
                }}
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
                <Label>Repository available to you and this Environment</Label>
                <Select onValueChange={setResourceId} value={resourceId}>
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
              <p className="text-muted-foreground text-sm">
                The Workspace filesystem persists when its compute sleeps.
              </p>
              <Button
                disabled={
                  saving ||
                  !environmentId ||
                  (sourceType === "github" && !resourceId)
                }
                onClick={() => void save()}
              >
                {saving ? "Configuring…" : "Configure Workspace"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
