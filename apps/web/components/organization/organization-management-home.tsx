import { AlertTriangle } from "lucide-react";
import { CreateOrganizationEnvironmentDialog } from "@/components/organization/create-environment-dialog";
import { OrganizationIdentityEditor } from "@/components/organization/organization-identity-editor";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import {
  SettingsDangerSection,
  SettingsDisclosure,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusNotice,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import type { OrganizationManagementEnvironment } from "@/lib/organizations/management";

const managementGroups = [
  {
    title: "Organization",
    links: [
      {
        href: "/organization/setup",
        title: "Setup",
        description: "Readiness and next steps",
      },
      {
        href: "/organization/people",
        title: "People",
        description: "Members, roles, and invitations",
      },
      {
        href: "/organization/billing",
        title: "Billing",
        description: "Plan, subscription, and usage",
      },
    ],
  },
  {
    title: "Runtime",
    links: [
      {
        href: "/organization/systems",
        title: "Systems",
        description: "Managed estate and active work",
      },
      {
        href: "/organization/connections",
        title: "Connections",
        description: "Providers, credentials, and models",
      },
      {
        href: "/organization/inference",
        title: "Inference",
        description: "Private profiles and fleet health",
      },
      {
        href: "/organization/agent-defaults",
        title: "Agent defaults",
        description: "Shared model and interaction defaults",
      },
    ],
  },
  {
    title: "Governance",
    links: [
      {
        href: "/organization/usage",
        title: "Costs & usage",
        description: "Attributed spend and pricing",
      },
      {
        href: "/organization/email",
        title: "Email",
        description: "Delivery configuration and testing",
      },
      {
        href: "/organization/api-keys",
        title: "API keys",
        description: "Organization credentials",
      },
      {
        href: "/organization/audit",
        title: "Audit",
        description: "Activity and retention",
      },
    ],
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
    id: string;
    name: string;
    slug: string;
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
    <SettingsPage>
      <SettingsPageHeader
        actions={<CreateOrganizationEnvironmentDialog />}
        description="Environments, access, and operating policy for this organization."
        eyebrow="Organization"
        status={
          <div className="flex flex-wrap gap-2">
            {organization.isPersonal ? (
              <Badge variant="secondary">Personal</Badge>
            ) : null}
            {organization.lifecycleState === "deleting" ? (
              <Badge variant="destructive">Deletion in progress</Badge>
            ) : null}
          </div>
        }
        title={organization.name}
      />

      {attention > 0 ? (
        <SettingsStatusNotice
          description={`${attention} environment${attention === 1 ? "" : "s"} require review.`}
          title="Some systems need attention"
          tone="warning"
        />
      ) : null}

      <SettingsSection
        description={`${environments.length} total · ${activeOperations.length} active operation${activeOperations.length === 1 ? "" : "s"}`}
        title="Environments"
      >
        {environments.length === 0 ? (
          <ResourceEmpty
            description="Create the first environment when this organization is ready to run work."
            title="No environments yet"
          />
        ) : (
          <ResourceList>
            {environments.map((environment) => {
              const needsAttention =
                ["failed", "degraded"].includes(environment.status) ||
                environment.counts.attention > 0;
              return (
                <ResourceRow
                  description={
                    environment.provider === "desktop"
                      ? `Desktop · ${environment.connectionState ?? "offline"}`
                      : `${environment.region} · ${environment.runtimeTemplate}`
                  }
                  href={`/organization/environments/${environment.id}`}
                  key={environment.id}
                  metadata={`${environment.counts.total} workspace${environment.counts.total === 1 ? "" : "s"}${environment.counts.attention ? ` · ${environment.counts.attention} need attention` : ""}`}
                  status={
                    <div className="flex items-center gap-2">
                      {environment.isDefault ? (
                        <Badge variant="secondary">Default</Badge>
                      ) : null}
                      {needsAttention ? (
                        <AlertTriangle
                          aria-label="Needs attention"
                          className="size-4 text-amber-600"
                        />
                      ) : null}
                      <Badge variant={statusTone(environment.status)}>
                        {environment.status}
                      </Badge>
                    </div>
                  }
                  title={environment.name}
                />
              );
            })}
          </ResourceList>
        )}
      </SettingsSection>

      <SettingsSection
        description="Quiet identifying details used throughout Kestrel One."
        title="Identity"
      >
        <SettingsRows>
          <SettingsRow label="Slug">
            <span className="text-muted-foreground text-sm">
              {organization.slug}
            </span>
          </SettingsRow>
          <SettingsRow label="Your role">
            <SettingsStatusSummary status={organization.role} />
          </SettingsRow>
        </SettingsRows>
        {organization.role === "owner" || organization.role === "admin" ? (
          <SettingsDisclosure
            className="mt-4"
            description="Change the name or URL-safe organization identifier."
            title="Edit identity"
          >
            <OrganizationIdentityEditor
              id={organization.id}
              initialName={organization.name}
              initialSlug={organization.slug}
            />
          </SettingsDisclosure>
        ) : null}
      </SettingsSection>

      {managementGroups.map((group) => (
        <SettingsSection key={group.title} title={group.title}>
          <ResourceList>
            {group.links.map((link) => (
              <ResourceRow
                description={link.description}
                href={link.href}
                key={link.href}
                title={link.title}
              />
            ))}
          </ResourceList>
        </SettingsSection>
      ))}

      {organization.role === "owner" && !organization.isPersonal ? (
        <SettingsDangerSection
          description="Permanent organization and infrastructure actions."
          title="Danger zone"
        >
          <ResourceList>
            <ResourceRow
              description="Review billing preconditions and deletion progress."
              href="/organization/danger"
              title="Delete organization"
            />
          </ResourceList>
        </SettingsDangerSection>
      ) : null}
    </SettingsPage>
  );
}
