"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import { AppPage } from "@/components/app-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  EnvironmentOperation,
  EnvironmentWorkspace,
  WorkspaceBackup,
} from "@/drizzle/schema";
import type { HostedEnvironmentsRollout } from "@/lib/environments/config";
import { describeEnvironmentOperation } from "@/lib/environments/operation-presentation";
import { DEFAULT_FLY_REGION, FLY_REGIONS } from "@/lib/environments/regions";

type CreateEnvironmentResponse = {
  environment?: Environment;
  error?: string;
};

const LIVE_STATE_REFRESH_MS = 1000;

function preserveEqualRows<T>(current: T[], next: T[]) {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

export function EnvironmentsAdminClient({
  initialEnvironments,
  initialRollout,
}: {
  initialEnvironments: Environment[];
  initialRollout: HostedEnvironmentsRollout;
}) {
  const [environments, setEnvironments] = useState(initialEnvironments);
  const [name, setName] = useState("");
  const [region, setRegion] = useState<string>(DEFAULT_FLY_REGION);
  const [busy, setBusy] = useState(false);
  const [rollout, setRollout] = useState(initialRollout);
  const [rolloutBusy, setRolloutBusy] = useState(false);
  const [grants, setGrants] = useState<EnvironmentCapabilityGrant[]>([]);
  const [workspaces, setWorkspaces] = useState<EnvironmentWorkspace[]>([]);
  const [operations, setOperations] = useState<EnvironmentOperation[]>([]);
  const [backups, setBackups] = useState<WorkspaceBackup[]>([]);
  const [runtimeImages, setRuntimeImages] = useState<Record<string, string>>(
    Object.fromEntries(
      initialEnvironments.map((environment) => [
        environment.id,
        environment.runtimeImage ?? "",
      ])
    )
  );
  const [restoreConfirmation, setRestoreConfirmation] = useState<string | null>(
    null
  );
  const [liveState, setLiveState] = useState<
    "connecting" | "live" | "retrying"
  >("connecting");

  useEffect(() => {
    void Promise.all(
      environments.map(async (environment) => {
        const response = await fetch(
          `/api/admin/environments/${environment.id}/capabilities`
        );
        if (!response.ok) return [];
        const payload = (await response.json()) as {
          grants?: EnvironmentCapabilityGrant[];
        };
        return payload.grants ?? [];
      })
    ).then((rows) => setGrants(rows.flat()));
  }, [environments]);

  useEffect(() => {
    void Promise.all(
      workspaces.map(async (workspace) => {
        const response = await fetch(
          `/api/admin/environments/${workspace.environmentId}/workspaces/${workspace.id}/backups`
        );
        if (!response.ok) return [];
        const payload = (await response.json()) as {
          backups?: WorkspaceBackup[];
        };
        return payload.backups ?? [];
      })
    ).then((rows) => setBackups(rows.flat()));
  }, [workspaces]);

  const refreshLiveState = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/admin/environments", {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error("Environment live state is unavailable.");
    }
    const payload = (await response.json()) as {
      environments?: Environment[];
      rollout?: HostedEnvironmentsRollout;
    };
    const liveEnvironments = payload.environments ?? [];
    const [workspaceRows, operationRows] = await Promise.all([
      Promise.all(
        liveEnvironments.map(async (environment) => {
          const workspaceResponse = await fetch(
            `/api/admin/environments/${environment.id}/workspaces`,
            { cache: "no-store", signal }
          );
          if (!workspaceResponse.ok) {
            throw new Error("Workspace live state is unavailable.");
          }
          const workspacePayload = (await workspaceResponse.json()) as {
            workspaces?: EnvironmentWorkspace[];
          };
          return workspacePayload.workspaces ?? [];
        })
      ),
      Promise.all(
        liveEnvironments.map(async (environment) => {
          const operationResponse = await fetch(
            `/api/admin/environments/${environment.id}/operations`,
            { cache: "no-store", signal }
          );
          if (!operationResponse.ok) {
            throw new Error("Environment operation state is unavailable.");
          }
          const operationPayload = (await operationResponse.json()) as {
            operations?: EnvironmentOperation[];
          };
          return operationPayload.operations ?? [];
        })
      ),
    ]);
    if (signal.aborted) return;
    setEnvironments((current) => preserveEqualRows(current, liveEnvironments));
    setWorkspaces((current) =>
      preserveEqualRows(current, workspaceRows.flat())
    );
    setOperations((current) =>
      preserveEqualRows(current, operationRows.flat())
    );
    if (payload.rollout) setRollout(payload.rollout);
    setLiveState("live");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timeout: number | undefined;
    const refresh = async () => {
      try {
        await refreshLiveState(controller.signal);
      } catch {
        if (!controller.signal.aborted) setLiveState("retrying");
      } finally {
        if (!controller.signal.aborted) {
          timeout = window.setTimeout(refresh, LIVE_STATE_REFRESH_MS);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [refreshLiveState]);

  async function createEnvironment() {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/environments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, region }),
      });
      const payload = (await response.json()) as CreateEnvironmentResponse;
      if (!(response.ok && payload.environment)) {
        throw new Error(payload.error || "Environment creation failed.");
      }
      setEnvironments((current) => [...current, payload.environment!]);
      setName("");
      setRegion(DEFAULT_FLY_REGION);
      toast.success("Environment provisioning requested.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Environment creation failed."
      );
    } finally {
      setBusy(false);
    }
  }

  async function updateRollout(enabled: boolean) {
    setRolloutBusy(true);
    try {
      const response = await fetch("/api/admin/environments", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const payload = (await response.json()) as {
        rollout?: HostedEnvironmentsRollout;
        error?: string;
      };
      if (!(response.ok && payload.rollout)) {
        throw new Error(payload.error ?? "Environment rollout update failed.");
      }
      setRollout(payload.rollout);
      toast.success(
        enabled
          ? "Environment execution enabled for this organization."
          : "Environment execution disabled for this organization."
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Environment rollout update failed."
      );
    } finally {
      setRolloutBusy(false);
    }
  }

  async function makeDefault(environmentId: string) {
    const response = await fetch(`/api/admin/environments/${environmentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isDefault: true }),
    });
    const payload = (await response.json()) as CreateEnvironmentResponse;
    if (!(response.ok && payload.environment)) {
      toast.error(payload.error || "Default Environment update failed.");
      return;
    }
    setEnvironments((current) =>
      current.map((environment) => ({
        ...environment,
        isDefault: environment.id === environmentId,
      }))
    );
    toast.success("Default Environment updated.");
  }

  async function setGitHubGrant(input: {
    environmentId: string;
    resourceId: string | null;
    capabilityKey:
      | "repository.read"
      | "repository.push_agent_branch"
      | "issue.write"
      | "pull_request.write"
      | "merge.write"
      | "release.write"
      | "workflow.dispatch";
    approvalMode: "auto" | "ask" | "deny";
  }) {
    const response = await fetch(
      `/api/admin/environments/${input.environmentId}/capabilities`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerKey: "github",
          capabilityKey: input.capabilityKey,
          resourceId: input.resourceId,
          approvalMode: input.approvalMode,
          loggingMode:
            input.capabilityKey === "repository.read"
              ? "metadata_only"
              : "full",
          rateLimitMode: "default",
        }),
      }
    );
    const payload = (await response.json()) as {
      grant?: EnvironmentCapabilityGrant;
      error?: string;
    };
    if (!(response.ok && payload.grant)) {
      toast.error(payload.error ?? "Environment access update failed.");
      return;
    }
    setGrants((current) => [
      ...current.filter((grant) => grant.id !== payload.grant!.id),
      payload.grant!,
    ]);
    toast.success("Environment access updated.");
  }

  async function createBackup(environmentId: string, workspaceId: string) {
    toast.info("Creating encrypted Workspace backup…");
    const response = await fetch(
      `/api/admin/environments/${environmentId}/workspaces/${workspaceId}/backups`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "checkpoint" }),
      }
    );
    const payload = (await response.json()) as {
      backupId?: string;
      error?: string;
    };
    if (!(response.ok && payload.backupId)) {
      toast.error(payload.error ?? "Workspace backup failed.");
      return;
    }
    const backupsResponse = await fetch(
      `/api/admin/environments/${environmentId}/workspaces/${workspaceId}/backups`
    );
    const backupsPayload = (await backupsResponse.json()) as {
      backups?: WorkspaceBackup[];
    };
    setBackups((current) => [
      ...current.filter((backup) => backup.workspaceId !== workspaceId),
      ...(backupsPayload.backups ?? []),
    ]);
    toast.success("Workspace backup available.");
  }

  async function restoreBackup(input: {
    environmentId: string;
    workspaceId: string;
    backupId: string;
  }) {
    if (restoreConfirmation !== input.backupId) {
      setRestoreConfirmation(input.backupId);
      toast.warning(
        "Click Restore latest again to confirm. Kestrel creates a pre-restore backup first."
      );
      return;
    }
    setRestoreConfirmation(null);
    const response = await fetch(
      `/api/admin/environments/${input.environmentId}/workspaces/${input.workspaceId}/backups/${input.backupId}/restore`,
      { method: "POST" }
    );
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      toast.error(payload.error ?? "Workspace restore failed.");
      return;
    }
    toast.success("Workspace restored from backup.");
  }

  async function updateRuntimeImage(environmentId: string) {
    const runtimeImage = runtimeImages[environmentId]?.trim();
    if (!runtimeImage) return;
    const response = await fetch(`/api/admin/environments/${environmentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeImage }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      toast.error(payload.error ?? "Runtime update failed.");
      return;
    }
    setEnvironments((current) =>
      current.map((environment) =>
        environment.id === environmentId
          ? { ...environment, runtimeImage }
          : environment
      )
    );
    toast.success("Runtime update and Workspace rebuilds queued.");
  }

  return (
    <AppPage>
      <AdminPageHeader
        description="Provision the organization-owned execution planes where Kestrel agents run and Workspaces persist."
        eyebrow="Execution"
        title="Environments"
      />

      <AdminStatusBanner
        description="Creating an Environment records a durable provisioning operation. Fly resources are created asynchronously and never in the browser."
        title="Kestrel-managed infrastructure"
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Organization rollout</CardTitle>
            <p className="mt-1 text-muted-foreground text-sm">
              Agent runs resolve through Environments only when both the
              deployment ceiling and this organization flag are enabled.
            </p>
          </div>
          <Badge variant={rollout.effectiveEnabled ? "default" : "outline"}>
            {rollout.effectiveEnabled ? "Active" : "Inactive"}
          </Badge>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4 border-t pt-4">
          <div className="text-muted-foreground text-sm">
            Deployment ceiling:{" "}
            {rollout.deploymentEnabled ? "enabled" : "disabled"}
            {rollout.organizationEnabled
              ? " · Organization enabled"
              : " · Organization disabled"}
          </div>
          <Button
            disabled={rolloutBusy}
            onClick={() => void updateRollout(!rollout.organizationEnabled)}
            variant={rollout.organizationEnabled ? "outline" : "default"}
          >
            {rolloutBusy
              ? "Updating…"
              : rollout.organizationEnabled
                ? "Disable for organization"
                : "Enable for organization"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Organization tooling</CardTitle>
            <p className="mt-1 text-muted-foreground text-sm">
              Members link their own GitHub identities. Environment policy sets
              the maximum GitHub capabilities any run may receive.
            </p>
          </div>
          <Button asChild variant="outline">
            <a href="/dashboard/user">Manage my GitHub connection</a>
          </Button>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create an Environment</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[1fr_180px_auto] md:items-end">
          <div className="space-y-2">
            <Label htmlFor="environment-name">Name</Label>
            <Input
              id="environment-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Development"
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="environment-region">Fly region</Label>
            <Select onValueChange={setRegion} value={region}>
              <SelectTrigger className="w-full" id="environment-region">
                <SelectValue placeholder="Select a Fly region" />
              </SelectTrigger>
              <SelectContent align="start">
                {FLY_REGIONS.map((flyRegion) => (
                  <SelectItem key={flyRegion.code} value={flyRegion.code}>
                    {flyRegion.name} · {flyRegion.code}
                    {"requiresPaidPlan" in flyRegion &&
                    flyRegion.requiresPaidPlan
                      ? " · paid plan"
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={busy || !name.trim() || !region.trim()}
            onClick={() => void createEnvironment()}
          >
            {busy ? "Requesting…" : "Create Environment"}
          </Button>
        </CardContent>
      </Card>

      {environments.length === 0 ? (
        <AdminEmptyState
          description="Create the first Environment before an agent can receive a persistent Workspace."
          title="No Environments yet"
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {environments.map((environment) => {
            const latestOperation = operations.find(
              (operation) => operation.environmentId === environment.id
            );
            const operationPresentation = latestOperation
              ? describeEnvironmentOperation(latestOperation)
              : null;
            return (
              <Card key={environment.id}>
                <CardHeader className="flex-row items-start justify-between space-y-0">
                  <div className="space-y-1">
                    <CardTitle>{environment.name}</CardTitle>
                    <p className="text-muted-foreground text-sm">
                      {environment.region} · {environment.runtimeTemplate}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {environment.isDefault ? <Badge>Default</Badge> : null}
                    <Badge variant="outline">{environment.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {latestOperation && operationPresentation ? (
                    <div
                      aria-live="polite"
                      className="space-y-1 rounded-md border bg-muted/30 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-sm">
                          {operationPresentation.label}
                        </div>
                        <div className="flex items-center gap-2">
                          {latestOperation.status === "queued" ||
                          latestOperation.status === "running" ? (
                            <span className="text-muted-foreground text-xs">
                              {liveState === "live"
                                ? "Live updates"
                                : liveState === "retrying"
                                  ? "Reconnecting…"
                                  : "Connecting…"}
                            </span>
                          ) : null}
                          <Badge
                            variant={
                              operationPresentation.tone === "error"
                                ? "destructive"
                                : latestOperation.status === "completed"
                                  ? "default"
                                  : "outline"
                            }
                          >
                            {latestOperation.status}
                          </Badge>
                        </div>
                      </div>
                      <div
                        className={
                          operationPresentation.tone === "error"
                            ? "text-destructive text-sm"
                            : "text-muted-foreground text-sm"
                        }
                      >
                        {operationPresentation.detail}
                      </div>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-muted-foreground text-sm">
                      Idle compute stops after {environment.idleTimeoutMinutes}{" "}
                      minutes.
                    </div>
                    {environment.isDefault ? null : (
                      <Button
                        onClick={() => void makeDefault(environment.id)}
                        size="sm"
                        variant="outline"
                      >
                        Make default
                      </Button>
                    )}
                  </div>
                  <div className="flex gap-2 border-t pt-4">
                    <Input
                      aria-label={`${environment.name} runtime image`}
                      onChange={(event) =>
                        setRuntimeImages((current) => ({
                          ...current,
                          [environment.id]: event.target.value,
                        }))
                      }
                      placeholder="registry.fly.io/kestrel-workspace@sha256:…"
                      value={runtimeImages[environment.id] ?? ""}
                    />
                    <Button
                      disabled={
                        !runtimeImages[environment.id]?.trim() ||
                        runtimeImages[environment.id] ===
                          environment.runtimeImage
                      }
                      onClick={() => void updateRuntimeImage(environment.id)}
                      variant="outline"
                    >
                      Update runtime
                    </Button>
                  </div>
                  <div className="space-y-2 border-t pt-4">
                    <div className="font-medium text-sm">
                      GitHub capability ceiling
                    </div>
                    <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                      {(
                        [
                          ["repository.read", "Read", "auto"],
                          [
                            "repository.push_agent_branch",
                            "Push agent branches",
                            "auto",
                          ],
                          ["issue.write", "Issues", "ask"],
                          ["pull_request.write", "Pull requests", "ask"],
                          ["merge.write", "Merges", "ask"],
                          ["release.write", "Releases", "ask"],
                          ["workflow.dispatch", "Workflows", "ask"],
                        ] as const
                      ).map(([capabilityKey, label, enabledMode]) => {
                        const grant = grants.find(
                          (candidate) =>
                            candidate.environmentId === environment.id &&
                            candidate.resourceId === null &&
                            candidate.capabilityKey === capabilityKey
                        );
                        const enabled = grant?.approvalMode === enabledMode;
                        return (
                          <Button
                            key={capabilityKey}
                            onClick={() =>
                              void setGitHubGrant({
                                environmentId: environment.id,
                                resourceId: null,
                                capabilityKey,
                                approvalMode: enabled ? "deny" : enabledMode,
                              })
                            }
                            size="sm"
                            variant={enabled ? "default" : "outline"}
                          >
                            {label}
                            {enabledMode === "ask" ? " · approval" : ""}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                  {workspaces.some(
                    (workspace) => workspace.environmentId === environment.id
                  ) ? (
                    <div className="space-y-2 border-t pt-4">
                      <div className="font-medium text-sm">
                        Persistent Workspaces
                      </div>
                      {workspaces
                        .filter(
                          (workspace) =>
                            workspace.environmentId === environment.id
                        )
                        .map((workspace) => {
                          const workspaceOperation = operations.find(
                            (operation) =>
                              operation.workspaceId === workspace.id
                          );
                          const workspaceOperationPresentation =
                            workspaceOperation
                              ? describeEnvironmentOperation(workspaceOperation)
                              : null;
                          return (
                            <div
                              className="flex items-center gap-2 rounded-md border p-2"
                              key={workspace.id}
                            >
                              <div className="mr-auto min-w-0">
                                <div className="truncate text-sm">
                                  {workspace.name}
                                </div>
                                <div className="text-muted-foreground text-xs">
                                  {workspace.status} ·{" "}
                                  {
                                    backups.filter(
                                      (backup) =>
                                        backup.workspaceId === workspace.id &&
                                        backup.status === "available"
                                    ).length
                                  }{" "}
                                  backups
                                </div>
                                {workspaceOperationPresentation ? (
                                  <div className="mt-1 text-muted-foreground text-xs">
                                    {workspaceOperationPresentation.detail}
                                  </div>
                                ) : null}
                              </div>
                              <Button
                                disabled={workspace.status !== "ready"}
                                onClick={() =>
                                  void createBackup(
                                    environment.id,
                                    workspace.id
                                  )
                                }
                                size="sm"
                                variant="outline"
                              >
                                Back up
                              </Button>
                              {backups.find(
                                (backup) =>
                                  backup.workspaceId === workspace.id &&
                                  backup.status === "available"
                              ) ? (
                                <Button
                                  onClick={() => {
                                    const backup = backups.find(
                                      (candidate) =>
                                        candidate.workspaceId ===
                                          workspace.id &&
                                        candidate.status === "available"
                                    );
                                    if (backup) {
                                      void restoreBackup({
                                        environmentId: environment.id,
                                        workspaceId: workspace.id,
                                        backupId: backup.id,
                                      });
                                    }
                                  }}
                                  size="sm"
                                  variant="outline"
                                >
                                  {restoreConfirmation ===
                                  backups.find(
                                    (candidate) =>
                                      candidate.workspaceId === workspace.id &&
                                      candidate.status === "available"
                                  )?.id
                                    ? "Confirm restore"
                                    : "Restore latest"}
                                </Button>
                              ) : null}
                            </div>
                          );
                        })}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </AppPage>
  );
}
