"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsPanel,
  SettingsPanelContent,
  SettingsPanelHeader,
  SettingsPanelTitle,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Config = {
  additionalPrompt: string | null;
  responseStyle: "concise" | "detailed" | "technical" | "friendly";
  language: string;
  defaultModel: string | null;
  maxStepsMultiplier: number;
  temperature: number;
  searchInstructions: string | null;
  citationFormat: "inline" | "footnote" | "none";
};

type ApprovedModel = {
  id: string;
  name: string;
  provider: string;
};

const emptyConfig: Config = {
  additionalPrompt: "",
  responseStyle: "concise",
  language: "en",
  defaultModel: "",
  maxStepsMultiplier: 1,
  temperature: 0.7,
  searchInstructions: "",
  citationFormat: "inline",
};

export function AgentAdminClient() {
  const [config, setConfig] = useState<Config>(emptyConfig);
  const [approvedModels, setApprovedModels] = useState<ApprovedModel[]>([]);
  const [status, setStatus] = useState("Loading configuration...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [configResponse, modelsResponse] = await Promise.all([
        fetch("/api/organization/agent-config", { cache: "no-store" }),
        fetch("/api/models/approved?modality=language", { cache: "no-store" }),
      ]);
      const json = await configResponse.json().catch(() => ({}));
      const modelsJson = await modelsResponse.json().catch(() => ({}));
      if (!configResponse.ok) {
        setStatus(json.error || "Failed to load configuration");
        return;
      }
      if (Array.isArray(modelsJson.models)) {
        setApprovedModels(modelsJson.models);
      }
      setConfig({
        additionalPrompt: json.additionalPrompt || "",
        responseStyle: json.responseStyle || "concise",
        language: json.language || "en",
        defaultModel: json.defaultModel || "",
        maxStepsMultiplier: json.maxStepsMultiplier || 1,
        temperature: json.temperature || 0.7,
        searchInstructions: json.searchInstructions || "",
        citationFormat: json.citationFormat || "inline",
      });
      setStatus("");
    })();
  }, []);

  async function save() {
    setBusy(true);
    const response = await fetch("/api/organization/agent-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...config,
        defaultModel: config.defaultModel || null,
        additionalPrompt: config.additionalPrompt || null,
        searchInstructions: config.searchInstructions || null,
      }),
    });
    const json = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) {
      setStatus("Configuration saved.");
      toast.success("Configuration saved.");
      return;
    }
    setStatus(json.error || "Save failed");
    toast.error(json.error || "Save failed");
  }

  async function reset() {
    setBusy(true);
    const response = await fetch("/api/organization/agent-config/reset", {
      method: "POST",
    });
    const json = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setStatus(json.error || "Reset failed");
      toast.error(json.error || "Reset failed");
      return;
    }
    setConfig({
      additionalPrompt: json.additionalPrompt || "",
      responseStyle: json.responseStyle || "concise",
      language: json.language || "en",
      defaultModel: json.defaultModel || "",
      maxStepsMultiplier: json.maxStepsMultiplier || 1,
      temperature: json.temperature || 0.7,
      searchInstructions: json.searchInstructions || "",
      citationFormat: json.citationFormat || "inline",
    });
    setStatus("Configuration reset.");
    toast.success("Configuration reset.");
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Manage the default agent prompt, model preferences, and response rules used across the Kestrel One runtime."
        eyebrow="Configuration"
        title="Agent defaults"
      />
      {status ? (
        <AdminStatusBanner
          description="These settings apply to the active organization."
          title={status}
          variant={status.includes("failed") ? "error" : "info"}
        />
      ) : null}
      <SettingsPanel className="max-w-4xl">
        <SettingsPanelHeader>
          <SettingsPanelTitle>Agent configuration</SettingsPanelTitle>
        </SettingsPanelHeader>
        <SettingsPanelContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="agent-response-style">Response style</Label>
            <Select
              onValueChange={(value: Config["responseStyle"]) =>
                setConfig((current) => ({ ...current, responseStyle: value }))
              }
              value={config.responseStyle}
            >
              <SelectTrigger id="agent-response-style">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="concise">Concise</SelectItem>
                <SelectItem value="detailed">Detailed</SelectItem>
                <SelectItem value="technical">Technical</SelectItem>
                <SelectItem value="friendly">Friendly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-language">Language</Label>
            <Input
              id="agent-language"
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  language: event.target.value,
                }))
              }
              value={config.language}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-default-model">Default model</Label>
            <Select
              onValueChange={(value) =>
                setConfig((current) => ({
                  ...current,
                  defaultModel: value,
                }))
              }
              value={config.defaultModel || ""}
            >
              <SelectTrigger id="agent-default-model">
                <SelectValue placeholder="Choose an approved model" />
              </SelectTrigger>
              <SelectContent>
                {approvedModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name} · {model.provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-max-steps-multiplier">
              Max steps multiplier
            </Label>
            <Input
              id="agent-max-steps-multiplier"
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  maxStepsMultiplier: Number(event.target.value || "1"),
                }))
              }
              type="number"
              value={config.maxStepsMultiplier}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-temperature">Temperature</Label>
            <Input
              id="agent-temperature"
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  temperature: Number(event.target.value || "0.7"),
                }))
              }
              step="0.1"
              type="number"
              value={config.temperature}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-citation-format">Citation format</Label>
            <Select
              onValueChange={(value: Config["citationFormat"]) =>
                setConfig((current) => ({ ...current, citationFormat: value }))
              }
              value={config.citationFormat}
            >
              <SelectTrigger id="agent-citation-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inline">Inline</SelectItem>
                <SelectItem value="footnote">Footnote</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-additional-prompt">Additional prompt</Label>
            <Textarea
              id="agent-additional-prompt"
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  additionalPrompt: event.target.value,
                }))
              }
              value={config.additionalPrompt || ""}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-search-instructions">
              Search instructions
            </Label>
            <Textarea
              id="agent-search-instructions"
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  searchInstructions: event.target.value,
                }))
              }
              value={config.searchInstructions || ""}
            />
          </div>
          <div className="flex gap-2">
            <Button
              data-testid="agent-config-save"
              disabled={busy}
              onClick={() => void save()}
            >
              Save
            </Button>
            <Button
              data-testid="agent-config-reset"
              disabled={busy}
              onClick={() => void reset()}
              variant="outline"
            >
              Reset
            </Button>
          </div>
          {status ? (
            <div
              className="text-muted-foreground text-sm"
              data-testid="agent-config-status"
            >
              {status}
            </div>
          ) : null}
        </SettingsPanelContent>
      </SettingsPanel>
    </SettingsPage>
  );
}
