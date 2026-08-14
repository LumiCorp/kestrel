"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  SettingsDisclosure,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Release = {
  id: string;
  bundleRevision: string;
  trigger: string;
  status: string;
  manifestVersion: number;
  migrationChanged: boolean;
  migrationApprovedAt: string | null;
  migrationVerifiedAt: string | null;
  controllerPreparedAt: string | null;
  failureMessage: string | null;
  environmentGatewayConfigVersion: number | null;
  admission: { ok: boolean; code?: string; message?: string };
  recoveryEligibility: { ok: boolean; code?: string; message?: string };
  migrationAcknowledgementEligibility: {
    ok: boolean;
    code?: string;
    message?: string;
  };
  resolvedTargetCount: number;
  totalTargetCount: number;
  createdAt: string;
  components: Array<{
    role: string;
    image: string;
    changed: boolean;
    environmentGatewayAcceptedVersions: number[] | null;
  }>;
  targets: Array<{
    targetKey: string;
    status: string;
    stage: string;
    startedAt: string | null;
    result: Record<string, unknown> | null;
  }>;
};

export function ReleasesClient({
  initialReleases,
  initialSettings,
  canaries,
  currentBuildRevision,
  compatibilityMode,
  rollbackEligibility,
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
  currentBuildRevision: string | null;
  compatibilityMode: "enforced" | "legacy_bridge";
  rollbackEligibility: { ok: boolean; code?: string; message?: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const savedCanaryId = initialSettings?.canaryEnvironmentId ?? "";
  const [draftCanaryId, setDraftCanaryId] = useState(
    initialSettings?.canaryEnvironmentId ?? "",
  );
  const active = initialReleases.find(
    (release) => release.id === initialSettings?.activeReleaseId,
  );
  const stable = initialReleases.find(
    (release) => release.id === initialSettings?.stableReleaseId,
  );
  const candidate = initialReleases.find(
    (release) => release.status === "candidate",
  );
  const decisionRelease = active ?? candidate ?? null;
  const history = initialReleases.filter(
    (release) => release.id !== decisionRelease?.id,
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

  function releaseDetails(release: Release) {
    const canInvalidateLegacy =
      release.manifestVersion < 3 &&
      ["candidate", "paused"].includes(release.status) &&
      release.targets.every(
        (target) => target.status === "pending" && !target.startedAt,
      );
    return (
      <div className="space-y-5">
        {release.targets.length ? (
          <div className="space-y-2 text-sm">
            <div className="text-muted-foreground">
              {release.resolvedTargetCount} of {release.totalTargetCount}{" "}
              targets resolved
            </div>
            {release.targets
              .filter((target) => target.stage.endsWith("retrying"))
              .map((target) => {
                const attempt = readNumber(target.result, "retryAttempt");
                const nextAttemptAt = readString(
                  target.result,
                  "nextAttemptAt",
                );
                const response = readRecord(
                  target.result,
                  "lastProviderResponse",
                );
                return (
                  <SettingsStatusNotice
                    description={`Attempt ${attempt ?? "—"}${nextAttemptAt ? ` · next ${new Date(nextAttemptAt).toLocaleTimeString()}` : ""}${typeof response?.message === "string" ? ` · ${response.message}` : ""}`}
                    key={target.targetKey}
                    title={`${target.targetKey} is retrying`}
                    tone="warning"
                  />
                );
              })}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {canInvalidateLegacy ? (
            <Button
              disabled={pending}
              onClick={() =>
                act({ action: "invalidate_legacy", releaseId: release.id })
              }
              variant="destructive"
            >
              Invalidate legacy release
            </Button>
          ) : null}
          {release.status === "candidate" ? (
            <>
              {release.manifestVersion === 3 &&
              release.migrationChanged &&
              !release.migrationApprovedAt ? (
                <Button
                  disabled={
                    pending || !release.migrationAcknowledgementEligibility.ok
                  }
                  onClick={() =>
                    act({ action: "migration_ready", releaseId: release.id })
                  }
                  variant="outline"
                >
                  Mark migration runbook complete
                </Button>
              ) : null}
              <Button
                disabled={
                  pending ||
                  release.manifestVersion !== 3 ||
                  !release.controllerPreparedAt ||
                  !release.migrationVerifiedAt ||
                  Boolean(active) ||
                  !savedCanaryId ||
                  (release.migrationChanged && !release.migrationApprovedAt) ||
                  !release.admission.ok
                }
                onClick={() =>
                  act({ action: "approve", releaseId: release.id })
                }
              >
                Approve release
              </Button>
              {release.manifestVersion === 3 &&
              (!release.controllerPreparedAt ||
                !release.migrationVerifiedAt) ? (
                <SettingsStatusNotice
                  description="Dispatch Prepare release candidate for this exact revision. Approval unlocks only after the controller heartbeat and production migration ledger are verified."
                  title="Candidate preparation required"
                  tone="warning"
                />
              ) : null}
              {release.recoveryEligibility.ok ? (
                <Button
                  disabled={pending}
                  onClick={() =>
                    act({ action: "recover_forward", releaseId: release.id })
                  }
                  variant="destructive"
                >
                  Recover forward
                </Button>
              ) : null}
              {active?.status === "paused" &&
              !release.recoveryEligibility.ok ? (
                <SettingsStatusNotice
                  description={release.recoveryEligibility.message}
                  title={release.recoveryEligibility.code ?? "Recovery blocked"}
                  tone="error"
                />
              ) : null}
              {release.admission.ok ? null : (
                <SettingsStatusNotice
                  description={release.admission.message}
                  title={release.admission.code ?? "Release blocked"}
                  tone="error"
                />
              )}
            </>
          ) : null}
          {release.status === "paused" && release.id === active?.id ? (
            <>
              <Button
                disabled={pending || !release.admission.ok}
                onClick={() => act({ action: "retry", releaseId: release.id })}
              >
                Retry failed target
              </Button>
              <Button
                disabled={pending || !rollbackEligibility.ok}
                onClick={() =>
                  act({ action: "rollback", releaseId: release.id })
                }
                variant="destructive"
              >
                Roll back to stable
              </Button>
              {rollbackEligibility.ok ? null : (
                <SettingsStatusNotice
                  description={rollbackEligibility.message}
                  title={rollbackEligibility.code ?? "Rollback blocked"}
                  tone="error"
                />
              )}
            </>
          ) : null}
        </div>
        <SettingsDisclosure
          description="Component images, accepted gateway versions, and target stages."
          title="Technical details"
        >
          <div className="divide-y border-y">
            {release.components.map((component) => (
              <div className="py-3 text-sm" key={component.role}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{component.role}</span>
                  <span className="text-muted-foreground text-xs">
                    {component.changed ? "Rebuilt" : "Carried forward"}
                  </span>
                </div>
                <div className="mt-1 break-all font-mono text-muted-foreground text-xs">
                  {component.image}
                </div>
                {component.environmentGatewayAcceptedVersions ? (
                  <div className="mt-1 text-muted-foreground text-xs">
                    Accepts gateway config v
                    {component.environmentGatewayAcceptedVersions.join(", v")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </SettingsDisclosure>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <SettingsStatusNotice
          description={error}
          title="Release action failed"
          tone="error"
        />
      ) : active?.status === "paused" ? (
        <SettingsStatusNotice
          description={
            active.failureMessage ??
            "The rollout stopped at its first failed target."
          }
          title="Release paused"
          tone="error"
        />
      ) : active ? (
        <SettingsStatusNotice
          description="New executions drain per Environment. The rollout stops on the first failure."
          title={`Release ${active.bundleRevision.slice(0, 12)} is ${active.status}`}
          tone="warning"
        />
      ) : candidate ? (
        <SettingsStatusNotice
          description="Review the candidate and approve it when the migration and canary requirements are satisfied."
          title="Candidate ready for a decision"
          tone="warning"
        />
      ) : stable ? (
        <SettingsStatusNotice
          description={`Bundle ${stable.bundleRevision.slice(0, 12)} is authoritative.`}
          title="Release fleet is stable"
          tone="success"
        />
      ) : (
        <SettingsStatusNotice
          description="The first candidate will establish the stable bundle."
          title="No stable release"
          tone="warning"
        />
      )}

      <section className="space-y-4 border-y py-5">
        <div>
          <h2 className="font-medium text-sm">Active decision</h2>
          <p className="mt-1 text-muted-foreground text-xs/5">
            Only the release that needs attention is expanded.
          </p>
        </div>
        {decisionRelease ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium font-mono">
                {decisionRelease.bundleRevision.slice(0, 12)}
              </span>
              <Badge
                variant={
                  decisionRelease.status === "paused"
                    ? "destructive"
                    : "outline"
                }
              >
                {decisionRelease.status}
              </Badge>
              {decisionRelease.migrationChanged &&
              !decisionRelease.migrationApprovedAt ? (
                <Badge variant="destructive">Migration runbook required</Badge>
              ) : null}
              {decisionRelease.manifestVersion === 3 &&
              (!decisionRelease.controllerPreparedAt ||
                !decisionRelease.migrationVerifiedAt) ? (
                <Badge variant="destructive">Preparation required</Badge>
              ) : null}
              {decisionRelease.manifestVersion < 3 ? (
                <Badge variant="destructive">Legacy manifest blocked</Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground text-xs">
              Published {new Date(decisionRelease.createdAt).toLocaleString()}
            </p>
            {releaseDetails(decisionRelease)}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No release decision is waiting.
          </p>
        )}
      </section>

      <SettingsDisclosure
        description="Choose the Environment that receives each rollout first."
        title="Release settings"
      >
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="h-9 min-w-72 rounded-md border bg-background px-3 text-sm"
            disabled={pending || Boolean(active)}
            onChange={(event) => setDraftCanaryId(event.target.value)}
            value={draftCanaryId}
          >
            <option value="">Choose a Fly Environment</option>
            {canaries.map((canary) => (
              <option key={canary.id} value={canary.id}>
                {canary.organizationName} / {canary.name} ({canary.status})
              </option>
            ))}
          </select>
          <Button
            disabled={
              pending ||
              Boolean(active) ||
              !draftCanaryId ||
              draftCanaryId === savedCanaryId
            }
            onClick={() =>
              act({ action: "set_canary", environmentId: draftCanaryId })
            }
          >
            Save canary
          </Button>
          <div className="basis-full text-muted-foreground text-sm">
            {savedCanaryId ? (
              <>
                Saved canary:{" "}
                {
                  canaries.find((item) => item.id === savedCanaryId)
                    ?.organizationName
                }{" "}
                / {canaries.find((item) => item.id === savedCanaryId)?.name}
                {active ? " — locked while this release is active." : ""}
              </>
            ) : (
              "No canary has been saved. Approval uses only the server-persisted canary."
            )}
          </div>
        </div>
        <p className="mt-4 text-muted-foreground text-xs">
          Serving {currentBuildRevision?.slice(0, 12) ?? "unknown"} ·
          compatibility {compatibilityMode.replace("_", " ")}.
        </p>
      </SettingsDisclosure>

      {history.length ? (
        <SettingsDisclosure
          description="Completed and superseded bundles remain available for audit."
          title={`Release history (${history.length})`}
        >
          <div className="divide-y border-y">
            {history.map((release) => (
              <details className="group py-3" key={release.id}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 marker:hidden [&::-webkit-details-marker]:hidden">
                  <span>
                    <span className="font-mono text-sm">
                      {release.bundleRevision.slice(0, 12)}
                    </span>
                    <span className="ml-2 text-muted-foreground text-xs">
                      {release.status} ·{" "}
                      {new Date(release.createdAt).toLocaleString()}
                    </span>
                  </span>
                  <span className="text-muted-foreground text-xs">Details</span>
                </summary>
                <div className="pt-4">{releaseDetails(release)}</div>
              </details>
            ))}
          </div>
        </SettingsDisclosure>
      ) : null}
    </div>
  );
}

function readRecord(value: unknown, key: string) {
  if (!(value && typeof value === "object")) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate && typeof candidate === "object"
    ? (candidate as Record<string, unknown>)
    : null;
}

function readString(value: unknown, key: string) {
  const candidate = readRecord({ value }, "value")?.[key];
  return typeof candidate === "string" ? candidate : null;
}

function readNumber(value: unknown, key: string) {
  const candidate = readRecord({ value }, "value")?.[key];
  return typeof candidate === "number" ? candidate : null;
}
