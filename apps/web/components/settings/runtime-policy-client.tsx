"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  SettingsActionGroup,
  SettingsExpandableRegion,
  SettingsRow,
  SettingsRows,
  SettingsSection,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type RuntimePolicySettings = {
  allowedRegions: string[];
  defaultRegion: string;
  allowedRuntimeTemplates: string[];
  defaultRuntimeTemplate: string;
};

export function RuntimePolicySettingsClient({
  initialSettings,
}: {
  initialSettings: RuntimePolicySettings;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const setList = (
    key: "allowedRegions" | "allowedRuntimeTemplates",
    value: string
  ) =>
    setDraft((current) => ({
      ...current,
      [key]: value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    }));

  async function save() {
    setBusy(true);
    try {
      const response = await fetch("/api/organization/infrastructure/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error ?? "Runtime policy update failed.");
      }
      setSettings(payload.settings);
      setDraft(payload.settings);
      setEditing(false);
      toast.success("Runtime policy saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setDraft(settings);
    setEditing(false);
  }

  return (
    <SettingsSection
      actions={
        editing ? null : (
          <Button onClick={() => setEditing(true)} size="sm" variant="outline">
            Edit
          </Button>
        )
      }
      description="Control where workspace runtimes may execute and which immutable runtime templates can be selected."
      title="Runtime policy"
    >
      <SettingsRows>
        <SettingsRow label="Regions">
          <div className="text-sm">
            <span>{settings.defaultRegion}</span>
            <span className="ml-2 text-muted-foreground">
              default · {settings.allowedRegions.length} allowed
            </span>
          </div>
        </SettingsRow>
        <SettingsRow label="Runtime templates">
          <div className="text-sm">
            <span>{settings.defaultRuntimeTemplate}</span>
            <span className="ml-2 text-muted-foreground">
              default · {settings.allowedRuntimeTemplates.length} allowed
            </span>
          </div>
        </SettingsRow>
        {editing ? (
          <SettingsExpandableRegion>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="allowed-regions">Allowed Fly regions</Label>
                <Input
                  id="allowed-regions"
                  onChange={(event) => setList("allowedRegions", event.target.value)}
                  value={draft.allowedRegions.join(", ")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="default-region">Default region</Label>
                <Input
                  id="default-region"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      defaultRegion: event.target.value,
                    }))
                  }
                  value={draft.defaultRegion}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="allowed-templates">Allowed runtime templates</Label>
                <Input
                  id="allowed-templates"
                  onChange={(event) =>
                    setList("allowedRuntimeTemplates", event.target.value)
                  }
                  value={draft.allowedRuntimeTemplates.join(", ")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="default-template">Default runtime template</Label>
                <Input
                  id="default-template"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      defaultRuntimeTemplate: event.target.value,
                    }))
                  }
                  value={draft.defaultRuntimeTemplate}
                />
              </div>
              <SettingsActionGroup className="md:col-span-2">
                <Button disabled={busy} onClick={() => void save()} size="sm">
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button disabled={busy} onClick={cancel} size="sm" variant="ghost">
                  Cancel
                </Button>
              </SettingsActionGroup>
            </div>
          </SettingsExpandableRegion>
        ) : null}
      </SettingsRows>
    </SettingsSection>
  );
}
