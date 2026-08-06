"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Operation = {
  id: string;
  status: string;
  stage: string;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
};

type Workspace = {
  id: string;
  name: string;
  status: string;
  runtimeImage: string | null;
  operation: Operation | null;
};

type Environment = {
  id: string;
  name: string;
  status: string;
  routerImage: string | null;
  runtimeImage: string | null;
  targetRouterImage: string | null;
  targetRuntimeImage: string | null;
  targetGeneration: number | null;
  operation: Operation | null;
  workspaces: Workspace[];
};

type Deployment = {
  platform: {
    generation: number;
    status: string;
    mode: string;
    canaryEnvironmentId: string | null;
    desiredSourceRevision: string | null;
    activeSourceRevision: string | null;
    desiredRouterImage: string | null;
    activeRouterImage: string | null;
    desiredRuntimeImage: string | null;
    activeRuntimeImage: string | null;
    lastFailureCode: string | null;
    lastFailureMessage: string | null;
  };
  globalApplications: Record<string, string | null>;
  environments: Environment[];
};

type LegacyRelease = {
  id: string;
  bundleRevision: string;
  trigger: string;
  status: string;
  createdAt: string;
  failureMessage: string | null;
};

export function ReleasesClient({
  initialDeployment,
  legacyReleases,
}: {
  initialDeployment: Deployment;
  legacyReleases: LegacyRelease[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { platform } = initialDeployment;
  const canary = initialDeployment.environments.find(
    (environment) => environment.id === platform.canaryEnvironmentId,
  );

  useEffect(() => {
    if (["ready", "rejected", "blocked"].includes(platform.status)) return;
    const interval = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [platform.status, router]);

  const act = (body: Record<string, string>) => {
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/admin/runtime-deployment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string | { code?: string };
        };
        setError(
          typeof payload.error === "string"
            ? payload.error
            : payload.error?.code ?? "Runtime recovery action failed.",
        );
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      {error ? (
        <AdminStatusBanner
          description={error}
          title="Runtime recovery action failed"
          variant="error"
        />
      ) : (
        <AdminStatusBanner
          description={deploymentDescription(platform, canary?.name)}
          title={`Generation ${platform.generation} is ${platform.status}`}
          variant={
            ["blocked", "rejected"].includes(platform.status)
              ? "error"
              : platform.status === "ready"
                ? "success"
                : "warning"
          }
        />
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Platform desired state</CardTitle>
            <Badge variant="outline">{platform.mode}</Badge>
            {canary ? <Badge variant="secondary">canary: {canary.name}</Badge> : null}
          </div>
          <CardDescription>
            The saved canary is persistent and automatic. New generations supersede unfinished generations.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <ImageState
            active={platform.activeRouterImage}
            desired={platform.desiredRouterImage}
            label="Environment router"
          />
          <ImageState
            active={platform.activeRuntimeImage}
            desired={platform.desiredRuntimeImage}
            label="Workspace Runtime"
          />
          <div className="text-muted-foreground text-sm md:col-span-2">
            Desired revision {shortRevision(platform.desiredSourceRevision)} · active revision {shortRevision(platform.activeSourceRevision)}
          </div>
          {platform.lastFailureMessage ? (
            <div className="rounded-md border border-destructive/40 p-3 text-sm md:col-span-2">
              <div className="font-medium">{platform.lastFailureCode}</div>
              <div className="text-muted-foreground">{platform.lastFailureMessage}</div>
            </div>
          ) : null}
          {["blocked", "rejected"].includes(platform.status) && canary ? (
            <Button
              disabled={pending}
              onClick={() => act({ action: "retry_canary" })}
              className="w-fit"
            >
              Retry canary
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {initialDeployment.environments.map((environment) => (
          <Card key={environment.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{environment.name}</CardTitle>
                <Badge variant={environment.status === "ready" ? "outline" : "destructive"}>
                  {environment.status}
                </Badge>
                {environment.id === platform.canaryEnvironmentId ? (
                  <Badge>persistent canary</Badge>
                ) : null}
                {environment.targetGeneration === platform.generation ? (
                  <Badge variant="secondary">generation {environment.targetGeneration}</Badge>
                ) : null}
              </div>
              <CardDescription>
                Router {imageState(environment.routerImage, environment.targetRouterImage)} · {environment.workspaces.length} Workspaces
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {environment.operation ? (
                <ResourceOperation
                  disabled={pending}
                  environmentId={environment.id}
                  operation={environment.operation}
                  onAction={act}
                />
              ) : null}
              {environment.workspaces.map((workspace) => (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3" key={workspace.id}>
                  <div>
                    <div className="font-medium text-sm">{workspace.name}</div>
                    <div className="text-muted-foreground text-xs">
                      {workspace.status} · {shortImage(workspace.runtimeImage)}
                    </div>
                  </div>
                  {workspace.operation ? (
                    <ResourceOperation
                      disabled={pending}
                      environmentId={environment.id}
                      operation={workspace.operation}
                      onAction={act}
                      workspaceId={workspace.id}
                    />
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Legacy release history</CardTitle>
          <CardDescription>
            Read-only during the proof window. No new candidates are created and these records no longer lock execution when desired-state automation is active.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {legacyReleases.slice(0, 10).map((release) => (
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm" key={release.id}>
              <span className="font-mono">{release.bundleRevision.slice(0, 12)}</span>
              <Badge variant="outline">{release.status}</Badge>
              <Badge variant="secondary">{release.trigger}</Badge>
              <span className="text-muted-foreground">{new Date(release.createdAt).toLocaleString()}</span>
              {release.failureMessage ? <span className="basis-full text-muted-foreground">{release.failureMessage}</span> : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ResourceOperation({
  operation,
  environmentId,
  workspaceId,
  disabled,
  onAction,
}: {
  operation: Operation;
  environmentId: string;
  workspaceId?: string;
  disabled: boolean;
  onAction(body: Record<string, string>): void;
}) {
  const retryState = readRecord(operation.result, "retryState");
  const nextAttemptAt = readString(retryState, "nextAttemptAt");
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant={operation.status === "failed" ? "destructive" : "outline"}>
        {operation.stage}
      </Badge>
      {retryState ? (
        <span className="text-muted-foreground">
          attempt {readNumber(retryState, "attempt") ?? operation.attempt}
          {nextAttemptAt ? ` · next ${new Date(nextAttemptAt).toLocaleTimeString()}` : ""}
        </span>
      ) : null}
      {operation.status === "failed" ? (
        <>
          <Button
            disabled={disabled}
            onClick={() => onAction({ action: "retry_resource", environmentId, ...(workspaceId ? { workspaceId } : {}) })}
            size="sm"
            variant="outline"
          >
            Retry resource
          </Button>
          <Button
            disabled={disabled}
            onClick={() => onAction({ action: "rollback_resource", environmentId, ...(workspaceId ? { workspaceId } : {}) })}
            size="sm"
            variant="destructive"
          >
            Roll back resource
          </Button>
        </>
      ) : null}
    </div>
  );
}

function ImageState({ label, active, desired }: { label: string; active: string | null; desired: string | null }) {
  return (
    <div className="rounded-md border p-3">
      <div className="font-medium text-sm">{label}</div>
      <div className="mt-2 font-mono text-muted-foreground text-xs">desired {shortImage(desired)}</div>
      <div className="font-mono text-muted-foreground text-xs">active {shortImage(active)}</div>
    </div>
  );
}

function deploymentDescription(platform: Deployment["platform"], canaryName?: string) {
  if (platform.status === "ready") return "All eligible resources have converged to verified platform state.";
  if (platform.status === "canary") return `The automatic canary${canaryName ? ` ${canaryName}` : ""} is reconciling before fanout.`;
  if (platform.status === "fanout") return "Canary verification passed; eligible Environments are converging independently.";
  if (platform.status === "degraded") return "One or more resources are blocked; unrelated resources continue to converge and serve traffic.";
  return platform.lastFailureMessage ?? "The deployment requires resource-local recovery.";
}

function imageState(verified: string | null, target: string | null) {
  return verified === target ? `verified ${shortImage(verified)}` : `${shortImage(verified)} → ${shortImage(target)}`;
}

function shortImage(image: string | null) {
  return image?.split("@sha256:")[1]?.slice(0, 12) ?? "unavailable";
}

function shortRevision(revision: string | null) {
  return revision?.slice(0, 12) ?? "unavailable";
}

function readRecord(value: unknown, key: string) {
  if (!(value && typeof value === "object")) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

function readString(value: unknown, key: string) {
  if (!(value && typeof value === "object")) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function readNumber(value: unknown, key: string) {
  if (!(value && typeof value === "object")) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? candidate : null;
}
