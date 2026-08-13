import { GithubConnectionCard } from "@/components/apps/github-connection-card";
import { GoogleWorkspaceConnectionCard } from "@/components/apps/google-workspace-connection-card";
import { Microsoft365ConnectionCard } from "@/components/apps/microsoft-365-connection-card";
import {
  SettingsPage,
  SettingsPageHeader,
} from "@/components/settings/settings-section";
import { listAppsForOrganization } from "@/lib/apps/service";
import {
  getActiveOrganizationSnapshot,
  requireActiveOrganization,
} from "@/lib/knowledge/auth";

export default async function PersonalConnectionsSettingsPage() {
  const { organizationId, session } = await requireActiveOrganization();
  const [organization, apps] = await Promise.all([
    getActiveOrganizationSnapshot(session),
    listAppsForOrganization({
      organizationId,
      userId: session.user.id,
      canManageOrganization: false,
    }),
  ]);
  const installedAppKeys = new Set(
    apps.apps
      .filter((app) => app.installationStatus === "installed")
      .map((app) => app.key),
  );
  const organizationName = organization?.name ?? "this organization";

  return (
    <SettingsPage>
      <SettingsPageHeader
        description={`Personal accounts Kestrel may use within ${organizationName}.`}
        eyebrow="Personal"
        title="Connections"
      />
      <div className="scroll-mt-6" id="github">
        <GithubConnectionCard installed={installedAppKeys.has("github")} />
      </div>
      <div className="scroll-mt-6" id="google-workspace">
        <GoogleWorkspaceConnectionCard
          installed={installedAppKeys.has("google_workspace")}
        />
      </div>
      <div className="scroll-mt-6" id="microsoft-365">
        <Microsoft365ConnectionCard
          installed={installedAppKeys.has("microsoft_365")}
        />
      </div>
    </SettingsPage>
  );
}
