"use client";

import { Loader2, Play, Plus, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  SettingsActionGroup,
  SettingsExpandableRegion,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusSummary,
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

type Connection = {
  status: string;
  hasApiKey: boolean;
} | null;

type Profile = {
  id: string;
  profileKey: string;
  version: number;
  displayName: string;
  imageRef: string;
  expectedModelId: string;
  status: string;
  qualifiedAt: string | null;
};

type FleetRow = {
  deployment: { id: string; displayName: string; status: string };
  organization: { name: string };
  profile: { displayName: string };
  attributedSpendUsd: number;
};

const initialProfileForm = {
  profileKey: "",
  displayName: "",
  imageRef: "",
  expectedModelId: "",
  environmentJson: "{}",
  secretEnvJson: "{}",
  gpuTypeIds: "NVIDIA L40S",
  dataCenterIds: "",
  workersMin: "0",
  workersMax: "1",
  costLimitUsdPerHour: "2",
};

const profileLabels: Record<keyof typeof initialProfileForm, string> = {
  profileKey: "Profile key",
  displayName: "Display name",
  imageRef: "Image reference",
  expectedModelId: "Expected model ID",
  environmentJson: "Environment JSON",
  secretEnvJson: "Secret environment JSON",
  gpuTypeIds: "GPU type IDs",
  dataCenterIds: "Data center IDs",
  workersMin: "Minimum workers",
  workersMax: "Maximum workers",
  costLimitUsdPerHour: "Hourly cost limit (USD)",
};

export function InferenceSettingsClient() {
  const [connection, setConnection] = useState<Connection>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [form, setForm] = useState(initialProfileForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [quota, setQuota] = useState("1");
  const [connectionEditing, setConnectionEditing] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [connectionResponse, profilesResponse, fleetResponse, policyResponse] =
      await Promise.all([
        fetch("/api/organization/infrastructure/connections/runpod", {
          cache: "no-store",
        }),
        fetch("/api/organization/infrastructure/deployment-profiles", {
          cache: "no-store",
        }),
        fetch("/api/organization/infrastructure/deployments", {
          cache: "no-store",
        }),
        fetch("/api/organization/infrastructure/runpod-policy", {
          cache: "no-store",
        }),
      ]);
    if (
      !(
        connectionResponse.ok &&
        profilesResponse.ok &&
        fleetResponse.ok &&
        policyResponse.ok
      )
    ) {
      throw new Error("Inference settings are temporarily unavailable.");
    }
    const [connectionJson, profilesJson, fleetJson, policyJson] =
      await Promise.all([
        connectionResponse.json(),
        profilesResponse.json(),
        fleetResponse.json(),
        policyResponse.json(),
      ]);
    setConnection(connectionJson.connection ?? null);
    setProfiles(profilesJson.profiles ?? []);
    setFleet(fleetJson.fleet ?? []);
    setQuota(String(policyJson.policy?.maxActiveDeployments ?? 1));
    setLoadError(null);
  }, []);

  useEffect(() => {
    refresh().catch((error) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [refresh]);

  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || "Inference operation failed.");
    }
    return json;
  }

  async function run(
    label: string,
    action: () => Promise<unknown>,
    successMessage: string
  ) {
    try {
      setBusy(label);
      await action();
      await refresh();
      toast.success(successMessage);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function createProfile() {
    let environment: unknown;
    let secretEnvironment: unknown;
    try {
      environment = JSON.parse(form.environmentJson);
      secretEnvironment = JSON.parse(form.secretEnvJson);
    } catch {
      toast.error("Environment fields must contain valid JSON objects.");
      return;
    }

    await run(
      "profile",
      async () => {
        const response = await fetch(
          "/api/organization/infrastructure/deployment-profiles",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              profileKey: form.profileKey,
              displayName: form.displayName,
              description: null,
              imageRef: form.imageRef,
              expectedModelId: form.expectedModelId,
              costLimitUsdPerHour: Number(form.costLimitUsdPerHour),
              templateSpec: {
                env: environment,
                secretEnv: secretEnvironment,
              },
              endpointSpec: {
                gpuTypeIds: form.gpuTypeIds
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
                dataCenterIds: form.dataCenterIds
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
                workersMin: Number(form.workersMin),
                workersMax: Number(form.workersMax),
                estimatedMaxCostUsdPerHour: Number(
                  form.costLimitUsdPerHour
                ),
              },
            }),
          }
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(json.error || "Failed to create profile.");
        }
        setForm(initialProfileForm);
        setProfileDialogOpen(false);
      },
      "Deployment profile draft created."
    );
  }

  const profileValid =
    form.profileKey.trim() &&
    form.displayName.trim() &&
    form.imageRef.trim() &&
    form.expectedModelId.trim();

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Connect GPU model serving, qualify immutable deployment profiles, and operate organization-owned endpoints."
        eyebrow="Organization"
        title="Inference"
      />

      {loadError ? (
        <div className="border-destructive/30 border-y bg-destructive/5 py-3 text-destructive text-sm">
          {loadError}
        </div>
      ) : null}

      <SettingsSection
        description="RunPod supplies GPU capacity for organization-owned model serving. Credentials stay hidden until you choose to edit them."
        title="RunPod connection"
      >
        <SettingsRows>
          <SettingsRow label="Connection">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SettingsStatusSummary
                detail={connection?.hasApiKey ? "Encrypted credential stored" : "No credential"}
                status={connection?.status ?? "Not configured"}
                tone={connection?.status === "ready" ? "positive" : "neutral"}
              />
              <SettingsActionGroup>
                <Button
                  disabled={Boolean(busy)}
                  onClick={() => setConnectionEditing((current) => !current)}
                  size="sm"
                  variant="outline"
                >
                  {connectionEditing ? "Cancel" : "Configure"}
                </Button>
                <Button
                  disabled={Boolean(busy) || !connection?.hasApiKey}
                  onClick={() =>
                    void run(
                      "test",
                      () =>
                        post(
                          "/api/organization/infrastructure/connections/runpod",
                          { action: "test" }
                        ),
                      "RunPod connection verified."
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  <ShieldCheck className="size-4" /> Test
                </Button>
              </SettingsActionGroup>
            </div>
          </SettingsRow>
          {connectionEditing ? (
            <SettingsExpandableRegion>
              <div className="max-w-xl space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="runpod-key">RunPod API key</Label>
                  <Input
                    autoComplete="off"
                    id="runpod-key"
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Leave empty to keep the stored key"
                    type="password"
                    value={apiKey}
                  />
                </div>
                <SettingsActionGroup>
                  <Button
                    disabled={
                      Boolean(busy) || !(apiKey || connection?.hasApiKey)
                    }
                    onClick={() =>
                      void run(
                        "connection",
                        () =>
                          post(
                            "/api/organization/infrastructure/connections/runpod",
                            {
                              action: "configure",
                              apiKey: apiKey || null,
                              enabled: true,
                            }
                          ),
                        "RunPod connection saved."
                      ).then((saved) => {
                        if (saved) {
                          setApiKey("");
                          setConnectionEditing(false);
                        }
                      })
                    }
                    size="sm"
                  >
                    Save
                  </Button>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setApiKey("");
                      setConnectionEditing(false);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </SettingsActionGroup>
              </div>
            </SettingsExpandableRegion>
          ) : null}
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        description="Cap the number of active GPU deployments available to this organization."
        title="Deployment policy"
      >
        <SettingsRows>
          <SettingsRow label="Maximum active deployments">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="w-28"
                id="deployment-quota"
                min="1"
                onChange={(event) => setQuota(event.target.value)}
                type="number"
                value={quota}
              />
              <Button
                disabled={Boolean(busy) || Number(quota) < 1}
                onClick={() =>
                  void run(
                    "policy",
                    async () => {
                      const response = await fetch(
                        "/api/organization/infrastructure/runpod-policy",
                        {
                          method: "PUT",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({
                            enabled: true,
                            maxActiveDeployments: Number(quota),
                          }),
                        }
                      );
                      if (!response.ok) {
                        throw new Error("Failed to update deployment policy.");
                      }
                    },
                    "Deployment policy updated."
                  )
                }
                size="sm"
              >
                Save policy
              </Button>
            </div>
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>

      <SettingsSection
        actions={
          <Dialog onOpenChange={setProfileDialogOpen} open={profileDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" /> New profile
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>New immutable profile version</DialogTitle>
                <DialogDescription>
                  Create a draft RunPod deployment profile. It must be qualified
                  before activation.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-2 md:grid-cols-2">
                {Object.entries(form).map(([key, value]) => (
                  <div className="space-y-2" key={key}>
                    <Label htmlFor={`profile-${key}`}>
                      {profileLabels[key as keyof typeof initialProfileForm]}
                    </Label>
                    <Input
                      id={`profile-${key}`}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                      value={value}
                    />
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button
                  onClick={() => setProfileDialogOpen(false)}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={Boolean(busy) || !profileValid}
                  onClick={() => void createProfile()}
                >
                  {busy === "profile" ? "Creating…" : "Create draft"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
        description="Versioned serverless images and model contracts move through qualification before activation."
        title="Deployment profiles"
      >
        {profiles.length === 0 ? (
          <div className="border-y py-8 text-center text-muted-foreground text-sm">
            No deployment profiles yet.
          </div>
        ) : (
          <div className="divide-y border-y">
            {profiles.map((profile) => (
              <div
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                key={profile.id}
              >
                <div className="min-w-0">
                  <div className="font-medium text-sm">
                    {profile.displayName} v{profile.version}
                  </div>
                  <div className="truncate text-muted-foreground text-xs">
                    {profile.imageRef} · {profile.expectedModelId}
                  </div>
                </div>
                <SettingsActionGroup>
                  <Badge variant="outline">{profile.status}</Badge>
                  {profile.status === "draft" && !profile.qualifiedAt ? (
                    <Button
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run(
                          profile.id,
                          () =>
                            post(
                              `/api/organization/infrastructure/deployment-profiles/${profile.id}`,
                              { action: "qualify" }
                            ),
                          "Profile qualified."
                        )
                      }
                      size="sm"
                    >
                      <Play className="size-4" /> Qualify
                    </Button>
                  ) : null}
                  {profile.status === "draft" && profile.qualifiedAt ? (
                    <Button
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run(
                          profile.id,
                          () =>
                            post(
                              `/api/organization/infrastructure/deployment-profiles/${profile.id}`,
                              { action: "activate" }
                            ),
                          "Profile activated."
                        )
                      }
                      size="sm"
                    >
                      Activate
                    </Button>
                  ) : null}
                  {profile.status === "active" ? (
                    <Button
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run(
                          profile.id,
                          () =>
                            post(
                              `/api/organization/infrastructure/deployment-profiles/${profile.id}`,
                              { action: "deprecate" }
                            ),
                          "Profile deprecated."
                        )
                      }
                      size="sm"
                      variant="outline"
                    >
                      Deprecate
                    </Button>
                  ) : null}
                </SettingsActionGroup>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        actions={
          <SettingsActionGroup>
            <Button
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  "reconcile",
                  () =>
                    post("/api/organization/infrastructure/deployments", {
                      action: "reconcile",
                    }),
                  "Fleet reconciled."
                )
              }
              size="sm"
              variant="outline"
            >
              <RefreshCw className="size-4" /> Reconcile
            </Button>
            <Button
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  "usage",
                  () =>
                    post("/api/organization/infrastructure/deployments", {
                      action: "ingest-usage",
                    }),
                  "Usage refreshed."
                )
              }
              size="sm"
              variant="outline"
            >
              <Server className="size-4" /> Refresh usage
            </Button>
          </SettingsActionGroup>
        }
        description="Organization-owned endpoints and their attributed GPU spend."
        title="Fleet and usage"
      >
        {busy === "reconcile" || busy === "usage" ? (
          <Loader2 className="mb-3 size-4 animate-spin" />
        ) : null}
        {fleet.length === 0 ? (
          <div className="border-y py-8 text-center text-muted-foreground text-sm">
            No active deployments.
          </div>
        ) : (
          <div className="divide-y border-y">
            {fleet.map((row) => (
              <div
                className="grid gap-1 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4"
                key={row.deployment.id}
              >
                <span className="min-w-0 truncate">
                  {row.profile.displayName} · {row.deployment.displayName}
                </span>
                <span className="text-muted-foreground">
                  {row.deployment.status} · ${row.attributedSpendUsd.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
