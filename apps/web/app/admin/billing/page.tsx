import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { SubscriptionTierLabel } from "@/components/tier-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminBillingDiagnostics } from "@/lib/admin/billing";
import { requireAdminOrganization } from "@/lib/knowledge/auth";

export default async function AdminBillingPage() {
  const { organizationId } = await requireAdminOrganization();
  const diagnostics = await getAdminBillingDiagnostics(organizationId);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/organizations">Open Org Billing</Link>
          </Button>
        }
        description="Inspect Stripe readiness, webhook wiring, and org subscription sync for the active organization."
        eyebrow="Operations"
        title="Stripe Billing Ops"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Integration Health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {diagnostics.config.billingEnabled ? "enabled" : "disabled"}
              </Badge>
              <Badge
                variant={diagnostics.config.isReady ? "default" : "secondary"}
              >
                {diagnostics.config.isReady ? "ready" : "needs config"}
              </Badge>
            </div>
            <div className="space-y-2 text-sm">
              <p>
                Billing feature flag:{" "}
                <span className="font-medium">
                  {diagnostics.config.billingEnabled ? "on" : "off"}
                </span>
              </p>
              <p>
                Webhook endpoint:{" "}
                <span className="font-medium">
                  {diagnostics.config.webhookUrl ||
                    diagnostics.config.webhookPath}
                </span>
              </p>
              {diagnostics.config.missingEnvVars.length ? (
                <div>
                  <p className="font-medium">Missing Stripe env vars</p>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {diagnostics.config.missingEnvVars.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  All required Stripe env vars are configured.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Org Sync State</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{diagnostics.syncState}</Badge>
              <SubscriptionTierLabel
                tier={
                  (diagnostics.subscription?.plan?.toLowerCase() as
                    | "free"
                    | "plus"
                    | "pro") || "free"
                }
              />
            </div>
            <div className="space-y-2 text-sm">
              <p>
                Active organization:{" "}
                <span className="font-medium">
                  {diagnostics.organization?.name || "Unknown"}
                </span>
              </p>
              <p>
                Workspace type:{" "}
                <span className="font-medium">
                  {diagnostics.organization?.isPersonalWorkspace
                    ? "personal"
                    : "shared"}
                </span>
              </p>
              <p>
                Org Stripe customer:{" "}
                <span className="font-medium">
                  {diagnostics.organization?.stripeCustomerId || "not linked"}
                </span>
              </p>
              <p>
                Subscription record:{" "}
                <span className="font-medium">
                  {diagnostics.subscription?.stripeSubscriptionId || "none"}
                </span>
              </p>
              {diagnostics.subscription?.updatedAt ? (
                <p className="text-muted-foreground">
                  Last synced{" "}
                  {formatDistanceToNow(
                    new Date(diagnostics.subscription.updatedAt),
                    {
                      addSuffix: true,
                    }
                  )}
                  .
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current Subscription Snapshot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {diagnostics.subscription ? (
            <>
              <p>
                Plan:{" "}
                <span className="font-medium">
                  {diagnostics.subscription.plan}
                </span>
              </p>
              <p>
                Status:{" "}
                <span className="font-medium">
                  {diagnostics.subscription.status}
                </span>
              </p>
              <p>
                Reference ID:{" "}
                <span className="font-medium">
                  {diagnostics.subscription.referenceId}
                </span>
              </p>
              <p>
                Billing interval:{" "}
                <span className="font-medium">
                  {diagnostics.subscription.billingInterval || "n/a"}
                </span>
              </p>
              <p>
                Cancel at period end:{" "}
                <span className="font-medium">
                  {diagnostics.subscription.cancelAtPeriodEnd ? "yes" : "no"}
                </span>
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">
              No active org subscription is currently synced for the active
              organization.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
