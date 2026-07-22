"use client";

import { Loader2, Play, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export function ManagedRunPodAdminClient() {
  const [connection, setConnection] = useState<Connection>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [form, setForm] = useState(initialProfileForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [quota, setQuota] = useState("1");

  const refresh = useCallback(async () => {
    const [connectionResponse, profilesResponse, fleetResponse, policyResponse] =
      await Promise.all([
        fetch("/api/organization/infrastructure/connections/runpod", { cache: "no-store" }),
        fetch("/api/organization/infrastructure/deployment-profiles", { cache: "no-store" }),
        fetch("/api/organization/infrastructure/deployments", { cache: "no-store" }),
        fetch("/api/organization/infrastructure/runpod-policy", { cache: "no-store" }),
      ]);
    if (!(connectionResponse.ok && profilesResponse.ok && fleetResponse.ok && policyResponse.ok)) {
      throw new Error("Managed RunPod administration is unavailable.");
    }
    const [connectionJson, profilesJson, fleetJson, policyJson] = await Promise.all([
      connectionResponse.json(),
      profilesResponse.json(),
      fleetResponse.json(),
      policyResponse.json(),
    ]);
    setConnection(connectionJson.connection ?? null);
    setProfiles(profilesJson.profiles ?? []);
    setFleet(fleetJson.fleet ?? []);
    setQuota(String(policyJson.policy?.maxActiveDeployments ?? 1));
  }, []);

  useEffect(() => {
    refresh().catch((error) => toast.error(String(error)));
  }, [refresh]);

  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || "Managed RunPod operation failed.");
    }
    return json;
  }

  async function run(label: string, action: () => Promise<unknown>) {
    try {
      setBusy(label);
      await action();
      await refresh();
      toast.success("Managed RunPod operation completed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <AdminPageHeader
        description="Qualify immutable deployment profiles and operate organization-owned RunPod Serverless endpoints."
        title="Managed RunPod"
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>RunPod connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  connection?.status === "ready" ? "default" : "secondary"
                }
              >
                {connection?.status ?? "not configured"}
              </Badge>
              <span className="text-muted-foreground text-sm">
                {connection?.hasApiKey ? "encrypted key" : "no credential"}
              </span>
            </div>
            <Label htmlFor="runpod-key">RunPod API key</Label>
            <Input
              id="runpod-key"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Leave empty to keep the stored key"
              type="password"
              value={apiKey}
            />
            <div className="flex gap-2">
              <Button
                disabled={Boolean(busy)}
                onClick={() =>
                  run("connection", () =>
                    post("/api/organization/infrastructure/connections/runpod", {
                      action: "configure",
                      apiKey: apiKey || null,
                      enabled: true,
                    })
                  )
                }
              >
                Save connection
              </Button>
              <Button
                disabled={Boolean(busy)}
                onClick={() =>
                  run("test", () =>
                    post("/api/organization/infrastructure/connections/runpod", { action: "test" })
                  )
                }
                variant="outline"
              >
                <ShieldCheck className="size-4" /> Test
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Deployment policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Label htmlFor="deployment-quota">Maximum active deployments</Label>
            <Input
              id="deployment-quota"
              min="1"
              onChange={(event) => setQuota(event.target.value)}
              type="number"
              value={quota}
            />
            <Button
              disabled={Boolean(busy)}
              onClick={() =>
                run("policy", async () => {
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
                  if (!response.ok)
                    throw new Error("Failed to enable organization policy.");
                })
              }
            >
              Enable organization
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New immutable profile version</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Object.entries(form).map(([key, value]) => (
            <div className="space-y-2" key={key}>
              <Label htmlFor={key}>{key}</Label>
              <Input
                id={key}
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
          <div className="flex items-end">
            <Button
              disabled={Boolean(busy)}
              onClick={() =>
                run("profile", async () => {
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
                          env: JSON.parse(form.environmentJson),
                          secretEnv: JSON.parse(form.secretEnvJson),
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
                  if (!response.ok)
                    throw new Error(json.error || "Failed to create profile.");
                  setForm(initialProfileForm);
                })
              }
            >
              Create draft
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profiles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {profiles.map((profile) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 border p-3"
              key={profile.id}
            >
              <div>
                <div className="font-medium">
                  {profile.displayName} v{profile.version}
                </div>
                <div className="text-muted-foreground text-xs">
                  {profile.imageRef} · {profile.expectedModelId}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge>{profile.status}</Badge>
                {profile.status === "draft" && !profile.qualifiedAt ? (
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      run(profile.id, () =>
                        post(`/api/organization/infrastructure/deployment-profiles/${profile.id}`, {
                          action: "qualify",
                        })
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
                      run(profile.id, () =>
                        post(`/api/organization/infrastructure/deployment-profiles/${profile.id}`, {
                          action: "activate",
                        })
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
                      run(profile.id, () =>
                        post(`/api/organization/infrastructure/deployment-profiles/${profile.id}`, {
                          action: "deprecate",
                        })
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    Deprecate
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Fleet and attributed usage</CardTitle>
            <div className="flex gap-2">
              <Button
                onClick={() =>
                  run("reconcile", () =>
                    post("/api/organization/infrastructure/deployments", {
                      action: "reconcile",
                    })
                  )
                }
                size="sm"
                variant="outline"
              >
                <RefreshCw className="size-4" /> Reconcile
              </Button>
              <Button
                onClick={() =>
                  run("usage", () =>
                    post("/api/organization/infrastructure/deployments", {
                      action: "ingest-usage",
                    })
                  )
                }
                size="sm"
                variant="outline"
              >
                <Server className="size-4" /> Usage
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {fleet.map((row) => (
            <div
              className="flex justify-between border p-3 text-sm"
              key={row.deployment.id}
            >
              <span>
                {row.organization.name} · {row.profile.displayName} ·{" "}
                {row.deployment.displayName}
              </span>
              <span>
                {row.deployment.status} · ${row.attributedSpendUsd.toFixed(2)}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
