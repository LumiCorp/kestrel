"use client";

import { Check, KeyRound, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  AppSettingsHeader,
  AppSettingsSection,
} from "@/components/apps/app-settings-layout";
import {
  BrowserPersonalDomains,
  type BrowserPersonalDomainEnvironmentView,
} from "@/components/apps/browser-personal-domains";
import {
  SettingsDisclosure,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppDetail as AppDetailType } from "@/lib/apps/types";

const CATEGORY_LABELS = {
  kestrel: "Kestrel",
  search_research: "Search & Research",
  productivity: "Productivity",
  engineering: "Engineering",
  communication: "Communication",
  workflow: "Workflows",
  custom: "Custom",
} as const;

const READINESS_LABELS: Record<AppDetailType["readiness"], string> = {
  ready: "Ready",
  setup_required: "Setup required",
  install_required: "Install required",
  degraded: "Needs attention",
  disabled: "Disabled",
};

function InstallButton({ app }: { app: AppDetailType }) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  if (app.installMode === "inherited" || !app.canManageInstallation)
    return null;
  const installed = app.installationStatus === "installed";

  async function updateInstallation() {
    setWorking(true);
    try {
      const response = await fetch(
        `/api/apps/${encodeURIComponent(app.key)}/installation`,
        { method: installed ? "DELETE" : "POST" },
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
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "App could not be updated.",
      );
      return false;
    } finally {
      setWorking(false);
    }
  }

  if (installed) {
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="App actions" size="icon" variant="ghost">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => setConfirmDisable(true)}
              variant="destructive"
            >
              Disable App
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog onOpenChange={setConfirmDisable} open={confirmDisable}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disable {app.displayName}?</AlertDialogTitle>
              <AlertDialogDescription>
                The App will no longer be available to Environments or Projects.
                Existing connections and policy are retained for recovery.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={working}
                onClick={(event) => {
                  event.preventDefault();
                  void updateInstallation().then((updated) => {
                    if (updated) setConfirmDisable(false);
                  });
                }}
              >
                {working ? "Disabling…" : "Disable App"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <Button disabled={working} onClick={() => void updateInstallation()}>
      {working
        ? "Saving…"
        : app.installationStatus === "disabled"
          ? "Enable App"
          : "Install App"}
    </Button>
  );
}

function approvalLabel(
  mode: AppDetailType["capabilities"][number]["defaultApprovalMode"],
) {
  if (mode === "ask") return "Ask first";
  if (mode === "deny") return "Off";
  return "Automatic";
}

export function AppDetail({
  app,
  browserPersonalDomainEnvironments = [],
}: {
  app: AppDetailType;
  browserPersonalDomainEnvironments?: readonly BrowserPersonalDomainEnvironmentView[];
}) {
  const groups = new Map<string, AppDetailType["capabilities"]>();
  for (const capability of app.capabilities) {
    const entries = groups.get(capability.groupKey) ?? [];
    entries.push(capability);
    groups.set(capability.groupKey, entries);
  }
  const readinessDescription =
    app.readiness === "ready"
      ? "This App is available where Environment and Project policy allow it."
      : app.readiness === "install_required"
        ? "Install this App before configuring connections or Project access."
        : app.readiness === "setup_required"
          ? "Add the required connection to make this App available."
          : app.readiness === "degraded"
            ? "Review the connection state below before relying on this App."
            : "Enable this App to make it available again.";

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
        status={`${READINESS_LABELS[app.readiness]} · ${CATEGORY_LABELS[app.category]}`}
      />

      <SettingsStatusNotice
        description={readinessDescription}
        title={READINESS_LABELS[app.readiness]}
        tone={
          app.readiness === "ready"
            ? "success"
            : app.readiness === "degraded" || app.readiness === "setup_required"
              ? "warning"
              : "info"
        }
      />

      <AppSettingsSection
        icon={<KeyRound className="size-4" />}
        title="Connections"
      >
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
                <p className="truncate font-medium text-sm">
                  {connection.name}
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {connection.ownerType === "personal"
                    ? "Personal connection"
                    : connection.ownerType === "deployment_managed"
                      ? "Deployment managed"
                      : "Environment connection"}
                </p>
              </div>
              <Badge
                variant={
                  connection.status === "connected" ? "default" : "outline"
                }
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
            {app.connectionModel === "personal" ||
            app.connectionModel === "hybrid" ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/connections">Manage personal connections</Link>
              </Button>
            ) : null}
            {app.connectionModel === "environment" ||
            app.connectionModel === "hybrid" ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/organization">Open Environments</Link>
              </Button>
            ) : null}
          </div>
        )}
      </AppSettingsSection>

      {app.key === "built_in.browser" ? (
        <BrowserPersonalDomains
          initialEnvironments={browserPersonalDomainEnvironments}
        />
      ) : null}

      <SettingsDisclosure
        description={`${app.capabilityCount} capabilities. Environment policy is the ceiling; Projects can only narrow it.`}
        title="Capability details"
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
                  <Badge
                    className="justify-self-start md:justify-self-end"
                    variant="secondary"
                  >
                    {approvalLabel(capability.defaultApprovalMode)}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ))}
      </SettingsDisclosure>
    </div>
  );
}
