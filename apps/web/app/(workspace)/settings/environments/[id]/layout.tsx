import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SettingsPage } from "@/components/settings/settings-section";
import { EnvironmentTabs } from "@/components/settings/environment-tabs";
import { Badge } from "@/components/ui/badge";
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

export default async function EnvironmentDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const environment = await getOrganizationEnvironment({
    organizationId,
    environmentId: id,
  });
  if (!environment) notFound();
  const base = `/settings/organization/environments/${environment.id}`;
  const tabs = isEnvironmentPrivateInferenceEnabled()
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
          href="/settings/organization/environments"
        >
          ← Environments
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-3xl tracking-tight">
            {environment.name}
          </h2>
          {environment.isDefault ? <Badge>Default</Badge> : null}
          <Badge variant="outline">{environment.status}</Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          {environment.region} · {environment.runtimeTemplate}
        </p>
      </div>
      <EnvironmentTabs base={base} tabs={tabs} />
      {children}
    </SettingsPage>
  );
}
