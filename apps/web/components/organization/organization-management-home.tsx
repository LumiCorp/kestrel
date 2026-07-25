import {
  ArrowRight,
  Boxes,
  CloudCog,
  CreditCard,
  KeyRound,
  Mail,
  Network,
  ScrollText,
  Users,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OrganizationManagementEnvironment } from "@/lib/organizations/management";
import { CreateOrganizationEnvironmentDialog } from "@/components/organization/create-environment-dialog";

const organizationSections = [
  {
    href: "/organization/systems",
    icon: Network,
    title: "Systems map",
    description: "Kestrel-managed estate, provider state, and active work",
  },
  {
    href: "/organization/people",
    icon: Users,
    title: "People",
    description: "Members, roles, and invitations",
  },
  {
    href: "/organization/billing",
    icon: CreditCard,
    title: "Billing",
    description: "Plan, subscription, and usage",
  },
  {
    href: "/organization/connections",
    icon: CloudCog,
    title: "Connections & models",
    description: "Providers, models, and runtime setup",
  },
  {
    href: "/organization/email",
    icon: Mail,
    title: "Email",
    description: "Delivery configuration and testing",
  },
  {
    href: "/organization/api-keys",
    icon: KeyRound,
    title: "API keys",
    description: "Organization credentials",
  },
  {
    href: "/organization/audit",
    icon: ScrollText,
    title: "Audit",
    description: "Administrative activity and retention",
  },
] as const;

function statusTone(status: string) {
  return ["failed", "degraded", "deleting"].includes(status)
    ? "destructive"
    : "outline";
}

export function OrganizationManagementHome({
  organization,
  environments,
  activeOperations,
}: {
  organization: {
    name: string;
    lifecycleState: string;
    isPersonal: boolean;
    role: string;
  };
  environments: OrganizationManagementEnvironment[];
  activeOperations: Array<{
    id: string;
    type: string;
    stage: string;
    status: string;
  }>;
}) {
  const attention = environments.filter(
    (environment) =>
      ["failed", "degraded"].includes(environment.status) ||
      environment.counts.attention > 0,
  ).length;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-10 px-4 py-8 sm:px-6 lg:px-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-medium text-muted-foreground text-sm">
            Organization
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="font-semibold text-3xl tracking-tight">
              {organization.name}
            </h1>
            {organization.isPersonal ? (
              <Badge variant="secondary">Personal</Badge>
            ) : null}
            {organization.lifecycleState === "deleting" ? (
              <Badge variant="destructive">Deletion in progress</Badge>
            ) : null}
          </div>
          <p className="mt-2 max-w-2xl text-muted-foreground text-sm">
            Manage the execution environments this organization owns. Workspaces
            carry their machine and persistent volume with them.
          </p>
        </div>
        <CreateOrganizationEnvironmentDialog />
      </header>

      <section aria-labelledby="environments-heading" className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-semibold text-xl" id="environments-heading">
              Environments
            </h2>
            <p className="text-muted-foreground text-sm">
              {environments.length} total · {attention} need attention ·{" "}
              {activeOperations.length} active operations
            </p>
          </div>
        </div>
        {environments.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground text-sm">
              No environments yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {environments.map((environment) => (
              <Card key={environment.id}>
                <CardHeader className="space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-lg">
                        {environment.name}
                      </CardTitle>
                      <CardDescription>
                        {environment.region} · {environment.runtimeTemplate}
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      {environment.isDefault ? (
                        <Badge variant="secondary">Default</Badge>
                      ) : null}
                      <Badge variant={statusTone(environment.status)}>
                        {environment.status}
                      </Badge>
                    </div>
                  </div>
                  {environment.failureMessage ? (
                    <p className="text-destructive text-sm">
                      {environment.failureMessage}
                    </p>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-4 gap-2 text-sm">
                    <div>
                      <p className="font-semibold">
                        {environment.counts.total}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Workspaces
                      </p>
                    </div>
                    <div>
                      <p className="font-semibold">
                        {environment.counts.ready}
                      </p>
                      <p className="text-muted-foreground text-xs">Running</p>
                    </div>
                    <div>
                      <p className="font-semibold">
                        {environment.counts.stopped}
                      </p>
                      <p className="text-muted-foreground text-xs">Stopped</p>
                    </div>
                    <div>
                      <p className="font-semibold text-destructive">
                        {environment.counts.attention}
                      </p>
                      <p className="text-muted-foreground text-xs">Attention</p>
                    </div>
                  </div>
                  <Button asChild className="w-full" variant="outline">
                    <Link href={`/organization/environments/${environment.id}`}>
                      Open environment <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section
        aria-labelledby="organization-settings-heading"
        className="space-y-4"
      >
        <div>
          <h2
            className="font-semibold text-xl"
            id="organization-settings-heading"
          >
            Organization management
          </h2>
          <p className="text-muted-foreground text-sm">
            People, access, billing, and operational policy for this
            organization.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {organizationSections.map((section) => (
            <Link
              className="rounded-lg border p-4 transition-colors hover:bg-muted"
              href={section.href}
              key={section.href}
            >
              <section.icon className="mb-3 size-5 text-muted-foreground" />
              <p className="font-medium text-sm">{section.title}</p>
              <p className="mt-1 text-muted-foreground text-xs">
                {section.description}
              </p>
            </Link>
          ))}
          {organization.role === "owner" && !organization.isPersonal ? (
            <Link
              className="rounded-lg border border-destructive/40 p-4 transition-colors hover:bg-destructive/5"
              href="/organization/danger"
            >
              <Boxes className="mb-3 size-5 text-destructive" />
              <p className="font-medium text-sm">Danger zone</p>
              <p className="mt-1 text-muted-foreground text-xs">
                Permanently delete this organization and its infrastructure.
              </p>
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}
