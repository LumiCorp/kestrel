import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import {
  SettingsDisclosure,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import { SubscriptionTierLabel } from "@/components/tier-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
            <Link href="/organization/billing">Open Org Billing</Link>
          </Button>
        }
        description="Resolve billing configuration or synchronization issues for the active organization."
        eyebrow="Platform"
        title="Billing"
      />

      <SettingsStatusNotice
        description={
          diagnostics.config.isReady
            ? `Stripe is configured and organization sync is ${diagnostics.syncState}.`
            : diagnostics.config.billingEnabled
              ? "Stripe configuration is incomplete. Add the missing deployment values before enabling paid billing."
              : "Billing is intentionally disabled for this deployment."
        }
        title={
          diagnostics.config.isReady
            ? "Billing integration is ready"
            : diagnostics.config.billingEnabled
              ? "Billing needs configuration"
              : "Billing is disabled"
        }
        tone={
          diagnostics.config.isReady
            ? "success"
            : diagnostics.config.billingEnabled
              ? "warning"
              : "info"
        }
      />

      {diagnostics.config.missingEnvVars.length ? (
        <section className="border-y py-5">
          <h2 className="font-medium text-sm">Required action</h2>
          <p className="mt-1 max-w-2xl text-muted-foreground text-sm/6">
            Configure {diagnostics.config.missingEnvVars.length} missing Stripe
            value{diagnostics.config.missingEnvVars.length === 1 ? "" : "s"} in
            the deployment, then redeploy Kestrel One.
          </p>
        </section>
      ) : null}

      <section className="space-y-4 border-y py-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium text-sm">Organization subscription</h2>
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
        <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
          <BillingFact
            label="Organization"
            value={diagnostics.organization?.name || "Unknown"}
          />
          <BillingFact
            label="Status"
            value={diagnostics.subscription?.status || "No subscription"}
          />
          <BillingFact
            label="Billing interval"
            value={
              diagnostics.subscription?.billingInterval || "Not applicable"
            }
          />
          <BillingFact
            label="Next event"
            value={
              diagnostics.subscription?.cancelAtPeriodEnd
                ? "Cancels at period end"
                : "Continues automatically"
            }
          />
        </dl>
        {diagnostics.subscription?.updatedAt ? (
          <p className="text-muted-foreground text-xs">
            Last synchronized{" "}
            {formatDistanceToNow(new Date(diagnostics.subscription.updatedAt), {
              addSuffix: true,
            })}
          </p>
        ) : null}
      </section>

      <SettingsDisclosure
        description="Deployment values, webhook wiring, and provider identifiers."
        title="Technical details"
      >
        <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
          <BillingFact
            label="Feature flag"
            value={diagnostics.config.billingEnabled ? "Enabled" : "Disabled"}
          />
          <BillingFact
            label="Webhook endpoint"
            value={
              diagnostics.config.webhookUrl || diagnostics.config.webhookPath
            }
          />
          <BillingFact
            label="Stripe customer"
            value={diagnostics.organization?.stripeCustomerId || "Not linked"}
          />
          <BillingFact
            label="Subscription ID"
            value={diagnostics.subscription?.stripeSubscriptionId || "None"}
          />
          <BillingFact
            label="Reference ID"
            value={diagnostics.subscription?.referenceId || "None"}
          />
          <BillingFact
            label="Workspace type"
            value={
              diagnostics.organization?.isPersonalWorkspace
                ? "Personal"
                : "Shared"
            }
          />
        </dl>
        {diagnostics.config.missingEnvVars.length ? (
          <div className="mt-5 border-t pt-4">
            <p className="font-medium text-sm">Missing deployment values</p>
            <ul className="mt-2 space-y-1 font-mono text-muted-foreground text-xs">
              {diagnostics.config.missingEnvVars.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </SettingsDisclosure>
    </div>
  );
}

function BillingFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 break-words font-medium">{value}</dd>
    </div>
  );
}
