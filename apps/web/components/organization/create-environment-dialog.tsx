"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { DEFAULT_FLY_REGION, FLY_REGIONS } from "@/lib/environments/regions";

export function CreateOrganizationEnvironmentDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [region, setRegion] = useState<string>(DEFAULT_FLY_REGION);
  const [provider, setProvider] = useState<"fly" | "kubernetes">("fly");
  const [connections, setConnections] = useState<
    Array<{
      id: string;
      displayName: string;
      status: string;
      supportStatus: string;
      configuration: null | {
        value: { runtimeTemplateAllowlist: string[] };
      };
    }>
  >([]);
  const [connectionId, setConnectionId] = useState("");
  const [runtimeTemplate, setRuntimeTemplate] = useState("");
  const [workspaceLimit, setWorkspaceLimit] = useState(10);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void fetch("/api/organization/infrastructure/kubernetes/connections", {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        const ready = (payload.connections ?? []).filter(
          (connection: { status: string }) => connection.status === "ready",
        );
        setConnections(ready);
        const first = ready[0];
        if (first) {
          setConnectionId(first.id);
          setRuntimeTemplate(
            first.configuration?.value.runtimeTemplateAllowlist[0] ?? "",
          );
        }
      })
      .catch(() => setConnections([]));
  }, [open]);

  const selectedConnection = connections.find(
    (connection) => connection.id === connectionId,
  );
  async function submit() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/environments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          provider === "kubernetes"
            ? {
                provider,
                name,
                providerConnectionId: connectionId,
                runtimeTemplate,
                workspaceLimit,
              }
            : { provider: "fly", name, region },
        ),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(payload?.error ?? "Environment creation failed.");
      toast.success("Environment provisioning requested.");
      setOpen(false);
      setName("");
      setRegion(DEFAULT_FLY_REGION);
      setProvider("fly");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Environment creation failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" /> New environment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Environment</DialogTitle>
          <DialogDescription>
            Create an execution plane for this organization. Workspaces,
            machines, and volumes will belong to it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label htmlFor="organization-environment-name">Name</Label>
            <Input
              id="organization-environment-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Development"
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="organization-environment-provider">Provider</Label>
            <Select
              onValueChange={(value: "fly" | "kubernetes") => setProvider(value)}
              value={provider}
            >
              <SelectTrigger id="organization-environment-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fly">Fly.io</SelectItem>
                <SelectItem value="kubernetes">Kubernetes BYOC</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {provider === "kubernetes" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="organization-environment-connection">Kubernetes connection</Label>
                <Select
                  onValueChange={(value) => {
                    setConnectionId(value);
                    const connection = connections.find((item) => item.id === value);
                    setRuntimeTemplate(connection?.configuration?.value.runtimeTemplateAllowlist[0] ?? "");
                  }}
                  value={connectionId}
                >
                  <SelectTrigger id="organization-environment-connection"><SelectValue placeholder="Select a qualified connection" /></SelectTrigger>
                  <SelectContent>
                    {connections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.displayName} · {connection.supportStatus}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-environment-template">Runtime template</Label>
                <Select onValueChange={setRuntimeTemplate} value={runtimeTemplate}>
                  <SelectTrigger id="organization-environment-template"><SelectValue placeholder="Select a runtime template" /></SelectTrigger>
                  <SelectContent>
                    {(selectedConnection?.configuration?.value.runtimeTemplateAllowlist ?? []).map((template) => (
                      <SelectItem key={template} value={template}>{template}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-environment-workspace-limit">Workspace limit</Label>
                <Input id="organization-environment-workspace-limit" min={1} onChange={(event) => setWorkspaceLimit(Number(event.target.value))} type="number" value={workspaceLimit} />
              </div>
            </>
          ) : null}
          {provider === "fly" ? (
            <div className="space-y-2">
              <Label htmlFor="organization-environment-region">Fly region</Label>
              <Select onValueChange={setRegion} value={region}>
                <SelectTrigger id="organization-environment-region">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FLY_REGIONS.map((flyRegion) => (
                    <SelectItem key={flyRegion.code} value={flyRegion.code}>
                      {flyRegion.name} · {flyRegion.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            disabled={
              busy ||
              !name.trim() ||
              (provider === "kubernetes" &&
                (!(connectionId && runtimeTemplate ) || workspaceLimit < 1))
            }
            onClick={() => void submit()}
          >
            {busy ? "Requesting…" : "Create Environment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
