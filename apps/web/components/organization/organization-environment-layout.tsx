import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { EnvironmentTabs } from "@/components/settings/environment-tabs";
import { SettingsPage } from "@/components/settings/settings-section";
import { isEnvironmentPrivateInferenceEnabled } from "@/lib/ai/managed-runpod-config";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const baseTabs = [
  ["Overview", ""],
  ["Runtime", "/runtime"],
  ["Access", "/access"],
  ["Workspaces", "/workspaces"],
  ["Apps", "/apps"],
  ["Activity", "/activity"],
] as const;

export async function OrganizationEnvironmentLayout({
  children,
  environmentId,
}: {
  children: ReactNode;
  environmentId: string;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const environment = await getOrganizationEnvironment({
    organizationId,
    environmentId,
  });
  if (!environment) notFound();
  const base = `/organization/environments/${environment.id}`;
  const tabs =
    environment.provider === "desktop"
      ? [baseTabs[0], ...baseTabs.slice(2)]
      : isEnvironmentPrivateInferenceEnabled()
        ? [
            baseTabs[0],
            baseTabs[1],
            ["Private inference", "/inference"] as const,
            ...baseTabs.slice(2),
          ]
        : baseTabs;
  return (
    <SettingsPage>
      <div className="space-y-3">
        <Link
          className="text-muted-foreground text-sm hover:text-foreground"
          href="/organization"
        >
          ← {"Organization"}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-semibold text-3xl tracking-tight">
            {environment.name}
          </h1>
          {environment.isDefault ? <Badge>Default</Badge> : null}
          <Badge variant="outline">{environment.status}</Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          {environment.provider === "desktop"
            ? "Kestrel Desktop · Local Core"
            : `${environment.region} · ${environment.runtimeTemplate}`}
        </p>
      </div>
      <EnvironmentTabs base={base} tabs={tabs} />
      {children}
    </SettingsPage>
  );
}
