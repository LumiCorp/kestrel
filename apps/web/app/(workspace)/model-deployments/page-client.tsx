"use client";

import { Loader2, RefreshCw, Rocket, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Profile = {
  id: string;
  displayName: string;
  version: number;
  description: string | null;
  expectedModelId: string;
  endpointSpec: { gpuTypeIds?: string[]; workersMax?: number };
  costLimitUsdPerHour: number;
};

type DeploymentRow = {
  deployment: {
    id: string;
    displayName: string;
    status: string;
    createdByUserId: string;
    failureMessage: string | null;
  };
  profile: Profile;
};

type Member = {
  userId: string;
  name: string;
  email: string;
  role: string;
  entitled: boolean;
};

export function ManagedRunPodDeploymentsClient() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [permissions, setPermissions] = useState({
    canLaunch: false,
    isOrganizationAdmin: false,
    isPlatformAdmin: false,
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/model-deployments", {
      cache: "no-store",
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(json.error || "Managed deployments are unavailable.");
    setProfiles(json.profiles ?? []);
    setDeployments(json.deployments ?? []);
    setPermissions(json.permissions ?? permissions);
    setSelectedProfileId((current) => current || json.profiles?.[0]?.id || "");
    if (
      json.permissions?.isOrganizationAdmin ||
      json.permissions?.isPlatformAdmin
    ) {
      const accessResponse = await fetch("/api/model-deployments/access", {
        cache: "no-store",
      });
      if (accessResponse.ok) {
        setMembers((await accessResponse.json()).members ?? []);
      }
    }
  }, []);

  useEffect(() => {
    refresh().catch((error) => toast.error(String(error)));
  }, [refresh]);

  async function request(url: string, init: RequestInit) {
    const response = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(json.error || "Managed deployment operation failed.");
    return json;
  }

  async function run(key: string, operation: () => Promise<unknown>) {
    try {
      setBusy(key);
      await operation();
      await refresh();
      toast.success("Managed deployment operation queued.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-3xl">Model deployments</h1>
        <p className="mt-1 text-muted-foreground">
          Launch organization-owned RunPod Serverless models from qualified
          platform profiles.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Launch a deployment</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-2">
            <Label htmlFor="profile">Qualified profile</Label>
            <select
              className="h-10 w-full border bg-background px-3"
              id="profile"
              onChange={(event) => setSelectedProfileId(event.target.value)}
              value={selectedProfileId}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.displayName} v{profile.version} · up to $
                  {profile.costLimitUsdPerHour}/hr
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="deployment-name">Deployment name</Label>
            <Input
              id="deployment-name"
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Team inference"
              value={displayName}
            />
          </div>
          <div className="flex items-end">
            <Button
              disabled={
                !(
                  permissions.canLaunch &&
                  selectedProfileId &&
                  displayName.trim()
                ) || Boolean(busy)
              }
              onClick={() =>
                run("launch", () =>
                  request("/api/model-deployments", {
                    method: "POST",
                    body: JSON.stringify({
                      profileId: selectedProfileId,
                      displayName,
                    }),
                  })
                )
              }
            >
              <Rocket className="size-4" /> Launch
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {deployments.map(({ deployment, profile }) => (
          <Card key={deployment.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{deployment.displayName}</span>
                  <Badge>{deployment.status}</Badge>
                </div>
                <div className="mt-1 text-muted-foreground text-sm">
                  {profile.displayName} · {profile.expectedModelId} ·{" "}
                  {(profile.endpointSpec.gpuTypeIds ?? []).join(", ")}
                </div>
                {deployment.failureMessage ? (
                  <div className="mt-1 text-destructive text-sm">
                    {deployment.failureMessage}
                  </div>
                ) : null}
              </div>
              <div className="flex gap-2">
                {deployment.status === "failed" ||
                deployment.status === "delete_failed" ? (
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      run(deployment.id, () =>
                        request(`/api/model-deployments/${deployment.id}`, {
                          method: "POST",
                          body: JSON.stringify({ action: "retry" }),
                        })
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    <RefreshCw className="size-4" /> Retry
                  </Button>
                ) : null}
                {deployment.status !== "deleting" ? (
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      run(deployment.id, () =>
                        request(`/api/model-deployments/${deployment.id}`, {
                          method: "DELETE",
                        })
                      )
                    }
                    size="sm"
                    variant="destructive"
                  >
                    <Trash2 className="size-4" /> Delete
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ))}
        {deployments.length === 0 ? (
          <div className="border border-dashed p-10 text-center text-muted-foreground">
            No managed deployments in this organization.
          </div>
        ) : null}
      </div>

      {permissions.isOrganizationAdmin || permissions.isPlatformAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-5" /> Launch entitlements
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {members.map((member) => (
              <div
                className="flex items-center justify-between border p-3"
                key={member.userId}
              >
                <div>
                  <div>{member.name}</div>
                  <div className="text-muted-foreground text-xs">
                    {member.email} · {member.role}
                  </div>
                </div>
                <Button
                  disabled={
                    Boolean(busy) ||
                    member.role === "owner" ||
                    member.role === "admin"
                  }
                  onClick={() =>
                    run(member.userId, () =>
                      request("/api/model-deployments/access", {
                        method: "PUT",
                        body: JSON.stringify({
                          userId: member.userId,
                          entitled: !member.entitled,
                        }),
                      })
                    )
                  }
                  size="sm"
                  variant={member.entitled ? "secondary" : "outline"}
                >
                  {member.entitled ? "Entitled" : "Grant"}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      {busy ? <Loader2 className="size-5 animate-spin" /> : null}
    </div>
  );
}
