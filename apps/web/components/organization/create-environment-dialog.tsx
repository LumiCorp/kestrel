"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/environments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, region }),
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
        </div>
        <DialogFooter>
          <Button disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? "Requesting…" : "Create Environment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
