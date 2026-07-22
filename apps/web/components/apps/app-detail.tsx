"use client";

import { Check, ChevronDown, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  AppSettingsHeader,
  AppSettingsSection,
} from "@/components/apps/app-settings-layout";
import { GithubConnectionCard } from "@/components/apps/github-connection-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { AppDetail as AppDetailType } from "@/lib/apps/types";

const CATEGORY_LABELS = {
  kestrel: "Kestrel",
  search_research: "Search & Research",
  productivity: "Productivity",
  engineering: "Engineering",
  knowledge_sources: "Knowledge & Sources",
  communication: "Communication",
  custom: "Custom",
} as const;

function InstallButton({ app }: { app: AppDetailType }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  if (app.installMode === "inherited" || !app.canManageInstallation) return null;
  const installed = app.installationStatus === "installed";

  async function updateInstallation() {
    setWorking(true);
    try {
      const response = await fetch(
        `/api/apps/${encodeURIComponent(app.key)}/installation`,
        { method: installed ? "DELETE" : "POST" }
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error || "App could not be updated.");
      }
      toast.success(installed ? "App disabled" : "App installed", {
        description: installed
          ? "Connections and policy were retained for recovery."
          : "The App can now be configured in Environments and Projects.",
      });
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "App could not be updated."
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <Button
      disabled={working}
      onClick={() => void updateInstallation()}
      variant={installed ? "outline" : "default"}
    >
      {working ? "Saving…" : installed ? "Disable App" : "Install App"}
    </Button>
  );
}

function approvalLabel(mode: AppDetailType["capabilities"][number]["defaultApprovalMode"]) {
  if (mode === "ask") return "Ask first";
  if (mode === "deny") return "Off";
  return "Automatic";
}

export function AppDetail({ app }: { app: AppDetailType }) {
  const groups = new Map<string, AppDetailType["capabilities"]>();
  for (const capability of app.capabilities) {
    const entries = groups.get(capability.groupKey) ?? [];
    entries.push(capability);
    groups.set(capability.groupKey, entries);
  }

  return (
    <div className="space-y-8">
      <AppSettingsHeader
        action={<InstallButton app={app} />}
        appKey={app.key}
        backHref="/apps"
        backLabel="Apps"
        description={app.description}
        icon={app.icon}
        name={app.displayName}
        status={CATEGORY_LABELS[app.category]}
      />

      {app.key === "github" && app.installationStatus === "installed" ? (
        <GithubConnectionCard />
      ) : null}

      <AppSettingsSection icon={<KeyRound className="size-4" />} title="Connections">
        {app.connectionModel === "none" ? (
          <p className="py-3 text-muted-foreground text-sm">
            No account or credential is required.
          </p>
        ) : app.connections.length ? (
          app.connections.map((connection) => (
            <div
              className="flex items-center justify-between gap-4 py-3"
              key={connection.id}
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-sm">{connection.name}</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {connection.ownerType === "personal"
                    ? "Personal connection"
                    : connection.ownerType === "deployment_managed"
                      ? "Deployment managed"
                      : "Environment connection"}
                </p>
              </div>
              <Badge
                variant={connection.status === "connected" ? "default" : "outline"}
              >
                {connection.status}
              </Badge>
            </div>
          ))
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4 py-3">
            <p className="max-w-2xl text-muted-foreground text-sm">
              {app.installationStatus === "installed"
                ? app.connectionRequirement === "optional"
                  ? "This App is ready. Add a connection to enable its optional provider path."
                  : "This App is installed but still needs a connection."
                : "Install this App before adding a connection."}
            </p>
            {app.connectionModel === "environment" ||
            app.connectionModel === "hybrid" ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/organization/environments">
                  Open Environments
                </Link>
              </Button>
            ) : null}
          </div>
        )}
      </AppSettingsSection>

      <AppSettingsSection
        description="Environment policy is the ceiling. Projects can narrow these defaults, but never broaden them."
        icon={<ShieldCheck className="size-4" />}
        title="Capabilities"
      >
        {[...groups.entries()].map(([group, capabilities]) => (
          <div className="py-3" key={group}>
            <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group.replaceAll("_", " ")}
            </h3>
            <div className="mt-2 divide-y">
              {capabilities.map((capability) => (
                <div
                  className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_8rem] md:items-center"
                  key={capability.key}
                >
                  <div className="flex gap-3">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <Check className="size-3.5" />
                    </span>
                    <div>
                      <p className="font-medium text-sm">
                        {capability.displayName}
                      </p>
                      <p className="mt-1 text-muted-foreground text-sm">
                        {capability.description}
                      </p>
                    </div>
                  </div>
                  <Badge className="justify-self-start md:justify-self-end" variant="secondary">
                    {approvalLabel(capability.defaultApprovalMode)}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ))}
      </AppSettingsSection>

      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between border-y py-3 text-left">
          <div>
            <h2 className="font-medium text-sm">Advanced</h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Runtime names, logging, and limits
            </p>
          </div>
          <ChevronDown className="size-4 text-muted-foreground" />
        </CollapsibleTrigger>
        <CollapsibleContent className="divide-y border-b">
          {app.capabilities.map((capability) => (
            <div
              className="grid gap-1 py-3 text-sm md:grid-cols-[minmax(0,1fr)_12rem]"
              key={capability.key}
            >
              <code className="truncate text-xs">
                {capability.runtimeName ?? capability.key}
              </code>
              <span className="text-muted-foreground md:text-right">
                {capability.defaultLoggingMode.replaceAll("_", " ")} ·{" "}
                {capability.defaultRateLimitMode}
              </span>
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>

      <div className="flex gap-3 border-y py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <ShieldCheck className="size-4" />
        </span>
        <div>
          <p className="font-medium text-sm">Access stays governed</p>
          <p className="mt-1 text-muted-foreground text-sm">
            Environment access is the ceiling. Projects and personal sharing can
            only narrow it.
          </p>
        </div>
      </div>
    </div>
  );
}
