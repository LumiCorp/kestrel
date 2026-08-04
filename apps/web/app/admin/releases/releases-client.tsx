"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
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

type Release = {
  id: string;
  bundleRevision: string;
  trigger: string;
  status: string;
  migrationChanged: boolean;
  migrationApprovedAt: string | null;
  failureMessage: string | null;
  createdAt: string;
  components: Array<{ role: string; image: string; changed: boolean }>;
  targets: Array<{ targetKey: string; status: string; stage: string }>;
};

export function ReleasesClient({
  initialReleases,
  initialSettings,
  canaries,
}: {
  initialReleases: Release[];
  initialSettings: {
    stableReleaseId: string | null;
    activeReleaseId: string | null;
    canaryEnvironmentId: string | null;
  } | null;
  canaries: Array<{
    id: string;
    name: string;
    organizationName: string;
    status: string;
  }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [canaryId, setCanaryId] = useState(
    initialSettings?.canaryEnvironmentId ?? "",
  );
  const active = initialReleases.find(
    (release) => release.id === initialSettings?.activeReleaseId,
  );
  const stable = initialReleases.find(
    (release) => release.id === initialSettings?.stableReleaseId,
  );

  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [active, router]);

  const act = (body: Record<string, string>) => {
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/admin/releases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(payload.error ?? "Release action failed.");
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
          title="Release action failed"
          variant="error"
        />
      ) : active?.status === "paused" ? (
        <AdminStatusBanner
          description={
            active.failureMessage ??
            "The rollout stopped at its first failed target."
          }
          title="Release paused"
          variant="error"
        />
      ) : active ? (
        <AdminStatusBanner
          description="New executions are drained per Environment; rollout stops on the first failure."
          title={`Release ${active.bundleRevision.slice(0, 12)} is ${active.status}`}
          variant="warning"
        />
      ) : stable ? (
        <AdminStatusBanner
          description={`Bundle ${stable.bundleRevision.slice(0, 12)} is authoritative for new and existing Fly Environments.`}
          title="Stable Fly image release"
          variant="success"
        />
      ) : (
        <AdminStatusBanner
          description="The first candidate publication will rebuild all five images to establish the stable bundle."
          title="No stable image release yet"
          variant="warning"
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Canary Environment</CardTitle>
          <CardDescription>
            The canary is updated before every other managed Fly Environment.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <select
            className="h-9 min-w-72 rounded-md border bg-background px-3 text-sm"
            disabled={pending || Boolean(active)}
            onChange={(event) => setCanaryId(event.target.value)}
            value={canaryId}
          >
            <option value="">Choose a Fly Environment</option>
            {canaries.map((canary) => (
              <option key={canary.id} value={canary.id}>
                {canary.organizationName} / {canary.name} ({canary.status})
              </option>
            ))}
          </select>
          <Button
            disabled={pending || Boolean(active) || !canaryId}
            onClick={() =>
              act({ action: "set_canary", environmentId: canaryId })
            }
          >
            Save canary
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {initialReleases.length === 0 ? (
          <AdminEmptyState
            description="GitHub Actions publishes candidates only after image build, smoke, and validation pass."
            title="No Fly image releases"
          />
        ) : (
          initialReleases.map((release) => (
            <Card key={release.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="font-mono">
                    {release.bundleRevision.slice(0, 12)}
                  </CardTitle>
                  <Badge
                    variant={
                      release.status === "paused" ? "destructive" : "outline"
                    }
                  >
                    {release.status}
                  </Badge>
                  <Badge variant="secondary">{release.trigger}</Badge>
                  {release.migrationChanged && !release.migrationApprovedAt ? (
                    <Badge variant="destructive">
                      migration runbook required
                    </Badge>
                  ) : release.migrationChanged ? (
                    <Badge variant="secondary">migration runbook complete</Badge>
                  ) : null}
                </div>
                <CardDescription>
                  Published {new Date(release.createdAt).toLocaleString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2 md:grid-cols-2">
                  {release.components.map((component) => (
                    <div className="rounded-md border p-3" key={component.role}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm">
                          {component.role}
                        </span>
                        <Badge
                          variant={component.changed ? "default" : "outline"}
                        >
                          {component.changed ? "rebuilt" : "carried forward"}
                        </Badge>
                      </div>
                      <div
                        className="mt-2 truncate font-mono text-muted-foreground text-xs"
                        title={component.image}
                      >
                        {component.image}
                      </div>
                    </div>
                  ))}
                </div>
                {release.targets.length ? (
                  <div className="text-muted-foreground text-sm">
                    {
                      release.targets.filter(
                        (target) => target.status === "completed",
                      ).length
                    }{" "}
                    / {release.targets.length} targets complete
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {release.status === "candidate" ? (
                    <>
                      {release.migrationChanged &&
                      !release.migrationApprovedAt ? (
                        <Button
                          disabled={pending || Boolean(active)}
                          onClick={() =>
                            act({
                              action: "migration_ready",
                              releaseId: release.id,
                            })
                          }
                          variant="outline"
                        >
                          Mark migration runbook complete
                        </Button>
                      ) : null}
                      <Button
                        disabled={
                          pending ||
                          Boolean(active) ||
                          !canaryId ||
                          (release.migrationChanged &&
                            !release.migrationApprovedAt)
                        }
                        onClick={() =>
                          act({ action: "approve", releaseId: release.id })
                        }
                      >
                        Approve release
                      </Button>
                    </>
                  ) : null}
                  {release.status === "paused" && release.id === active?.id ? (
                    <>
                      <Button
                        disabled={pending}
                        onClick={() =>
                          act({ action: "retry", releaseId: release.id })
                        }
                      >
                        Retry failed target
                      </Button>
                      <Button
                        disabled={pending}
                        onClick={() =>
                          act({ action: "rollback", releaseId: release.id })
                        }
                        variant="destructive"
                      >
                        Roll back to stable
                      </Button>
                    </>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
