"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Settings = {
  allowedRegions: string[];
  defaultRegion: string;
  allowedRuntimeTemplates: string[];
  defaultRuntimeTemplate: string;
};

export function InfrastructurePolicyCard({ initialSettings }: { initialSettings: Settings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [busy, setBusy] = useState(false);
  const setList = (key: "allowedRegions" | "allowedRuntimeTemplates", value: string) =>
    setSettings((current) => ({
      ...current,
      [key]: value.split(",").map((item) => item.trim()).filter(Boolean),
    }));

  async function save() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/infrastructure/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Infrastructure settings update failed.");
      setSettings(payload.settings);
      toast.success("Infrastructure policy saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Regions and runtime templates</CardTitle></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="allowed-regions">Allowed Fly regions</Label>
          <Input id="allowed-regions" value={settings.allowedRegions.join(", ")} onChange={(event) => setList("allowedRegions", event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="default-region">Default region</Label>
          <Input id="default-region" value={settings.defaultRegion} onChange={(event) => setSettings((current) => ({ ...current, defaultRegion: event.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="allowed-templates">Allowed runtime templates</Label>
          <Input id="allowed-templates" value={settings.allowedRuntimeTemplates.join(", ")} onChange={(event) => setList("allowedRuntimeTemplates", event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="default-template">Default runtime template</Label>
          <Input id="default-template" value={settings.defaultRuntimeTemplate} onChange={(event) => setSettings((current) => ({ ...current, defaultRuntimeTemplate: event.target.value }))} />
        </div>
        <div className="md:col-span-2"><Button disabled={busy} onClick={save}>Save policy</Button></div>
      </CardContent>
    </Card>
  );
}
