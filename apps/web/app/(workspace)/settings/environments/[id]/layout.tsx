import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AppPage } from "@/components/app-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isEnvironmentPrivateInferenceEnabled } from "@/lib/ai/managed-runpod-config";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const baseTabs = [
  ["Overview", ""],
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
  const base = `/settings/environments/${environment.id}`;
  const tabs = isEnvironmentPrivateInferenceEnabled()
    ? [
        baseTabs[0],
        baseTabs[1],
        ["Private inference", "/inference"] as const,
        ...baseTabs.slice(2),
      ]
    : baseTabs;

  return (
    <AppPage className="p-6 lg:p-8">
      <div className="space-y-2">
        <Link
          className="text-muted-foreground text-sm hover:text-foreground"
          href="/settings/environments"
        >
          ← Environments
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-semibold text-3xl tracking-tight">
            {environment.name}
          </h1>
          {environment.isDefault ? <Badge>Default</Badge> : null}
          <Badge variant="outline">{environment.status}</Badge>
        </div>
        <p className="text-muted-foreground">
          {environment.region} · Organization execution and inference boundary
        </p>
      </div>
      <nav aria-label="Environment sections" className="flex flex-wrap gap-2">
        {tabs.map(([label, suffix]) => (
          <Button asChild key={label} size="sm" variant="outline">
            <Link href={`${base}${suffix}`}>{label}</Link>
          </Button>
        ))}
      </nav>
      {children}
    </AppPage>
  );
}
