"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { readJson } from "@/components/admin/admin-client-utils";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function SandboxDebugClient() {
  const [command, setCommand] = useState(
    "find . -maxdepth 2 -type d | head -20"
  );
  const [snapshotRepo, setSnapshotRepo] = useState("");
  const [snapshotBranch, setSnapshotBranch] = useState("main");
  const [snapshotStatus, setSnapshotStatus] = useState<{
    currentSnapshotId: string | null;
    latestCreatedAt: number | null;
    needsSync: boolean;
  } | null>(null);
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadSnapshotSettings() {
    const [configResponse, statusResponse] = await Promise.all([
      fetch("/api/snapshot/config", { cache: "no-store" }),
      fetch("/api/snapshot/status", { cache: "no-store" }),
    ]);
    const config = await readJson<{
      snapshotRepo?: string;
      snapshotBranch?: string;
    }>(configResponse);
    const nextStatus = await readJson<{
      currentSnapshotId: string | null;
      latestCreatedAt: number | null;
      needsSync: boolean;
    }>(statusResponse);

    if (configResponse.ok) {
      setSnapshotRepo(config.snapshotRepo || "");
      setSnapshotBranch(config.snapshotBranch || "main");
    }

    if (statusResponse.ok) {
      setSnapshotStatus(nextStatus);
    }
  }

  useEffect(() => {
    void loadSnapshotSettings();
  }, []);

  async function runShell() {
    setBusy(true);
    const response = await fetch("/api/sandbox/shell", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    });
    const json = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setStatus(json.error || "Command failed");
      toast.error(json.error || "Command failed");
      return;
    }
    setOutput([json.stdout, json.stderr].filter(Boolean).join("\n"));
    setStatus(`Exit code ${json.exitCode}`);
    toast.success("Sandbox command completed.");
  }

  async function createSnapshot() {
    setBusy(true);
    const response = await fetch("/api/sandbox/snapshot", { method: "POST" });
    const json = await response.json().catch(() => ({}));
    setBusy(false);
    setStatus(
      response.ok
        ? `Snapshot ${json.snapshotId} created.`
        : json.error || "Snapshot failed"
    );
    if (response.ok) {
      toast.success("Snapshot created.");
      await loadSnapshotSettings();
    } else {
      toast.error(json.error || "Snapshot failed");
    }
  }

  async function syncAll() {
    setBusy(true);
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await response.json().catch(() => ({}));
    setBusy(false);
    setStatus(
      response.ok
        ? json.message || "Sync started."
        : json.error || "Sync failed"
    );
    if (response.ok) {
      toast.success(json.message || "Sync started.");
      await loadSnapshotSettings();
    } else {
      toast.error(json.error || "Sync failed");
    }
  }

  async function saveSnapshotConfig() {
    setBusy(true);
    const response = await fetch("/api/snapshot/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotRepo, snapshotBranch }),
    });
    const json = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setStatus(json.error || "Failed to save snapshot config");
      toast.error(json.error || "Failed to save snapshot config");
      return;
    }
    setStatus("Snapshot configuration saved.");
    toast.success("Snapshot configuration saved.");
    await loadSnapshotSettings();
  }

  async function syncSnapshot() {
    setBusy(true);
    const response = await fetch("/api/snapshot/sync", { method: "POST" });
    const json = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setStatus(json.error || "Snapshot sync failed");
      toast.error(json.error || "Snapshot sync failed");
      return;
    }
    setStatus(
      json.created
        ? `Created and activated snapshot ${json.snapshotId}.`
        : `Activated existing snapshot ${json.snapshotId}.`
    );
    toast.success(
      json.created ? "Snapshot created and activated." : "Snapshot activated."
    );
    await loadSnapshotSettings();
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Control source sync, snapshot repository settings, create-or-activate snapshot flows, and shell execution for the active organization."
        eyebrow="Developer"
        title="Sandbox"
      />

      {status ? (
        <AdminStatusBanner
          description={
            snapshotStatus?.currentSnapshotId
              ? `Current snapshot: ${snapshotStatus.currentSnapshotId}`
              : undefined
          }
          title={status}
          variant={status.toLowerCase().includes("failed") ? "error" : "info"}
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Sandbox Controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                data-testid="sandbox-create-snapshot"
                disabled={busy}
                onClick={() => void createSnapshot()}
              >
                Create Snapshot
              </Button>
              <Button
                data-testid="sandbox-sync-all"
                disabled={busy}
                onClick={() => void syncAll()}
                variant="outline"
              >
                Sync Sources
              </Button>
            </div>
            {status ? (
              <div
                className="text-muted-foreground text-sm"
                data-testid="sandbox-status"
              >
                {status}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Snapshot Repository</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="snapshot-repo">Repository</Label>
              <Input
                id="snapshot-repo"
                onChange={(event) => setSnapshotRepo(event.target.value)}
                value={snapshotRepo}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="snapshot-branch">Branch</Label>
              <Input
                id="snapshot-branch"
                onChange={(event) => setSnapshotBranch(event.target.value)}
                value={snapshotBranch}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void saveSnapshotConfig()}>
                Save Config
              </Button>
              <Button
                disabled={busy}
                onClick={() => void syncSnapshot()}
                variant="outline"
              >
                Create Or Activate Snapshot
              </Button>
            </div>
            <div className="text-muted-foreground text-sm">
              {snapshotStatus?.currentSnapshotId
                ? `Current snapshot ${snapshotStatus.currentSnapshotId}`
                : "No active snapshot"}
              {snapshotStatus?.needsSync ? " · sync recommended" : ""}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Shell</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sandbox-command">Command</Label>
              <Input
                data-testid="sandbox-command"
                id="sandbox-command"
                onChange={(event) => setCommand(event.target.value)}
                value={command}
              />
            </div>
            <Button
              data-testid="sandbox-run"
              disabled={busy}
              onClick={() => void runShell()}
            >
              Run
            </Button>
            <div className="space-y-2">
              <Label htmlFor="sandbox-output">Output</Label>
              <Textarea
                className="min-h-72 font-mono text-xs"
                data-testid="sandbox-output"
                id="sandbox-output"
                readOnly
                value={output}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
