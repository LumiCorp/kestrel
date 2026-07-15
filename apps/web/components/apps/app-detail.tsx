"use client";

import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AppIcon } from "@/components/apps/app-icon";
import { GithubConnectionCard } from "@/components/apps/github-connection-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  if (app.installMode === "inherited" || !app.canManageInstallation)
    return null;
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
      if (!response.ok)
        throw new Error(body.error || "App could not be updated.");
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

export function AppDetail({ app }: { app: AppDetailType }) {
  const groups = new Map<string, AppDetailType["capabilities"]>();
  for (const capability of app.capabilities) {
    const entries = groups.get(capability.groupKey) ?? [];
    entries.push(capability);
    groups.set(capability.groupKey, entries);
  }
  return (
    <div className="space-y-7">
      <Link
        className="text-muted-foreground text-sm hover:text-foreground"
        href="/apps"
      >
        ← Apps
      </Link>
      <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
        <div className="flex items-start gap-4">
          <AppIcon appKey={app.key} className="size-14" icon={app.icon} />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-semibold text-3xl tracking-tight">
                {app.displayName}
              </h1>
              <Badge variant="outline">{CATEGORY_LABELS[app.category]}</Badge>
            </div>
            <p className="mt-2 max-w-2xl text-muted-foreground leading-6">
              {app.description}
            </p>
          </div>
        </div>
        <InstallButton app={app} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="space-y-5">
          {app.key === "github" && app.installationStatus === "installed" ? (
            <GithubConnectionCard />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>What agents can do</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {[...groups.entries()].map(([group, capabilities]) => (
                <section key={group}>
                  <h2 className="font-medium text-sm capitalize">
                    {group.replaceAll("_", " ")}
                  </h2>
                  <div className="mt-3 divide-y rounded-lg border">
                    {capabilities.map((capability) => (
                      <div
                        className="flex gap-3 px-4 py-3"
                        key={capability.key}
                      >
                        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                          <Check className="size-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-medium text-sm">
                              {capability.displayName}
                            </p>
                            <Badge variant="secondary">
                              {capability.defaultApprovalMode === "ask"
                                ? "Ask first"
                                : capability.defaultApprovalMode === "deny"
                                  ? "Off"
                                  : "Automatic"}
                            </Badge>
                          </div>
                          <p className="mt-1 text-muted-foreground text-sm">
                            {capability.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </CardContent>
          </Card>

          <Collapsible>
            <Card>
              <CardHeader>
                <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
                  <div>
                    <CardTitle>Advanced</CardTitle>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Runtime names, logging, and limits
                    </p>
                  </div>
                  <ChevronDown className="size-4" />
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="space-y-3 border-t pt-5">
                  {app.capabilities.map((capability) => (
                    <div
                      className="grid gap-1 text-sm md:grid-cols-[minmax(0,1fr)_12rem]"
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
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Connections</CardTitle>
            </CardHeader>
            <CardContent>
              {app.connectionModel === "none" ? (
                <p className="text-muted-foreground text-sm">
                  No account or credential is required.
                </p>
              ) : app.connections.length ? (
                <div className="space-y-3">
                  {app.connections.map((connection) => (
                    <div className="rounded-lg border p-3" key={connection.id}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate font-medium text-sm">
                          {connection.name}
                        </p>
                        <Badge
                          variant={
                            connection.status === "connected"
                              ? "default"
                              : "outline"
                          }
                        >
                          {connection.status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-muted-foreground text-xs">
                        {connection.ownerType === "personal"
                          ? "Personal connection"
                          : connection.ownerType === "deployment_managed"
                            ? "Deployment managed"
                            : "Environment connection"}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-muted-foreground text-sm">
                    {app.installationStatus === "installed"
                      ? app.connectionRequirement === "optional"
                        ? "This App is ready. Add a connection to enable its optional provider path."
                        : "This App is installed but still needs a connection."
                      : "Install this App before adding a connection."}
                  </p>
                  {app.connectionModel === "environment" ||
                  app.connectionModel === "hybrid" ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href="/settings/environments">
                        Open Environments
                      </Link>
                    </Button>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex gap-3 p-5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                <ShieldCheck className="size-5" />
              </span>
              <div>
                <p className="font-medium text-sm">Access stays governed</p>
                <p className="mt-1 text-muted-foreground text-sm leading-5">
                  Environment access is the ceiling. Projects and personal
                  sharing can only narrow it.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
