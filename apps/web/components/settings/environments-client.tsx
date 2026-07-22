"use client";

import { ArrowUpRight, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { FlyWorkspaceProviderClient } from "@/components/settings/fly-workspace-provider-client";
import {
  RuntimePolicySettingsClient,
  type RuntimePolicySettings,
} from "@/components/settings/runtime-policy-client";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Environment } from "@/drizzle/schema";
import type { HostedEnvironmentsRollout } from "@/lib/environments/config";
import { DEFAULT_FLY_REGION, FLY_REGIONS } from "@/lib/environments/regions";

type CreateEnvironmentResponse = {
  environment?: Environment;
  error?: string;
};

const LIVE_STATE_REFRESH_MS = 5000;

function preserveEqualRows<T>(current: T[], next: T[]) {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

function formatUpdatedAt(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function EnvironmentsAdminClient({
  initialEnvironments,
  initialRollout,
  initialRuntimePolicy,
}: {
  initialEnvironments: Environment[];
  initialRollout: HostedEnvironmentsRollout;
  initialRuntimePolicy: RuntimePolicySettings;
}) {
  const [environments, setEnvironments] = useState(initialEnvironments);
  const [name, setName] = useState("");
  const [region, setRegion] = useState<string>(DEFAULT_FLY_REGION);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rollout, setRollout] = useState(initialRollout);
  const [rolloutBusy, setRolloutBusy] = useState(false);

  const refreshLiveState = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/organization/environments", {
      cache: "no-store",
      signal,
    });
    if (!response.ok) return;
    const payload = (await response.json()) as {
      environments?: Environment[];
      rollout?: HostedEnvironmentsRollout;
    };
    if (signal.aborted) return;
    setEnvironments((current) =>
      preserveEqualRows(current, payload.environments ?? [])
    );
    if (payload.rollout) setRollout(payload.rollout);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const interval = window.setInterval(
      () => void refreshLiveState(controller.signal),
      LIVE_STATE_REFRESH_MS
    );
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshLiveState]);

  async function createEnvironment() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/environments", {
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
      setCreateOpen(false);
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
      const response = await fetch("/api/organization/environments", {
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

  return (
    <SettingsPage>
      <SettingsPageHeader
        actions={
          <Dialog onOpenChange={setCreateOpen} open={createOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" /> New Environment
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Environment</DialogTitle>
                <DialogDescription>
                  Provision a durable execution plane for this organization.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-2">
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
              </div>
              <DialogFooter>
                <Button
                  disabled={busy || !name.trim() || !region.trim()}
                  onClick={() => void createEnvironment()}
                >
                  {busy ? "Requesting…" : "Create Environment"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
        description="Manage the execution planes where agents run and persistent Workspaces live."
        eyebrow="Execution"
        title="Environments"
      />

      <FlyWorkspaceProviderClient />

      <RuntimePolicySettingsClient initialSettings={initialRuntimePolicy} />

      <SettingsSection
        description="Control whether this organization may provision and use durable workspace execution planes."
        title="Environment execution"
      >
        <SettingsRows>
          <SettingsRow label="Organization rollout">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Badge variant={rollout.effectiveEnabled ? "default" : "outline"}>
                  {rollout.effectiveEnabled ? "Active" : "Inactive"}
                </Badge>
                <p className="text-muted-foreground text-xs">
                  Organization {rollout.organizationEnabled ? "enabled" : "disabled"}
                  {rollout.deploymentEnabled ? "" : " · deployment disabled"}
                </p>
              </div>
              <Button
                disabled={rolloutBusy}
                onClick={() => void updateRollout(!rollout.organizationEnabled)}
                size="sm"
                variant="outline"
              >
                {rolloutBusy
                  ? "Updating…"
                  : rollout.organizationEnabled
                    ? "Disable"
                    : "Enable"}
              </Button>
            </div>
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        description="Execution planes where agents run and persistent workspaces live."
        title="Environments"
      >
        {environments.length === 0 ? (
          <AdminEmptyState
            description="Create the first Environment before an agent can receive a persistent Workspace."
            title="No Environments yet"
          />
        ) : (
          <div className="overflow-x-auto border-y">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Environment</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {environments.map((environment) => {
                const href = `/settings/organization/environments/${environment.id}`;
                return (
                  <TableRow key={environment.id}>
                    <TableCell>
                      <Link className="font-medium hover:underline" href={href}>
                        {environment.name}
                      </Link>
                      {environment.isDefault ? (
                        <Badge className="ml-2" variant="secondary">
                          Default
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {environment.region}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {environment.runtimeTemplate}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{environment.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs">
                      {formatUpdatedAt(environment.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <Button asChild size="icon" variant="ghost">
                        <Link aria-label={`Open ${environment.name}`} href={href}>
                          <ArrowUpRight className="size-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
