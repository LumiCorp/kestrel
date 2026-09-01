"use client";

import { Globe2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AppSettingsSection } from "@/components/apps/app-settings-layout";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface BrowserPersonalDomainView {
  canonicalDomain: string;
  scheme: "https";
  includeSubdomains: true;
  port: 443;
  status: "active" | "revoked";
  personalRevision: number;
  approvedAt: string;
  revokedAt: string | null;
}

export interface BrowserPersonalDomainEnvironmentView {
  id: string;
  name: string;
  domains: readonly BrowserPersonalDomainView[];
}

export function BrowserPersonalDomains({
  initialEnvironments,
}: {
  initialEnvironments: readonly BrowserPersonalDomainEnvironmentView[];
}) {
  const [environments, setEnvironments] = useState(initialEnvironments);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    initialEnvironments[0]?.id ?? "",
  );
  const [pendingDomain, setPendingDomain] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const selectedEnvironment = environments.find(
    (environment) => environment.id === selectedEnvironmentId,
  );

  async function revokeDomain() {
    if (!(selectedEnvironment && pendingDomain)) return;
    setWorking(true);
    try {
      const response = await fetch("/api/apps/browser/personal-domains", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environmentId: selectedEnvironment.id,
          canonicalDomain: pendingDomain,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        domain?: BrowserPersonalDomainView | null;
      };
      if (!response.ok) {
        throw new Error(body.error || "The domain could not be revoked.");
      }
      if (!body.domain) {
        throw new Error("The revoked domain result was unavailable.");
      }
      setEnvironments((current) =>
        current.map((environment) =>
          environment.id === selectedEnvironment.id
            ? {
                ...environment,
                domains: environment.domains.map((domain) =>
                  domain.canonicalDomain === body.domain?.canonicalDomain
                    ? body.domain
                    : domain,
                ),
              }
            : environment,
        ),
      );
      toast.success("Domain revoked", {
        description:
          "Active Browser Sessions have adopted the updated allowlist.",
      });
      setPendingDomain(null);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The domain could not be revoked.",
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <AppSettingsSection
        description="Domains you allowed for Browser operator sessions. Each entry covers the apex and its subdomains in this Environment."
        icon={<Globe2 className="size-4" />}
        title="Your allowed domains"
      >
        {initialEnvironments.length === 0 ? (
          <p className="py-3 text-muted-foreground text-sm">
            No Environment is available.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <label
                className="font-medium text-sm"
                htmlFor="browser-domain-environment"
              >
                Environment
              </label>
              <select
                className="h-9 rounded-md border bg-background px-3 text-sm"
                id="browser-domain-environment"
                onChange={(event) =>
                  setSelectedEnvironmentId(event.currentTarget.value)
                }
                value={selectedEnvironmentId}
              >
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </div>
            {selectedEnvironment?.domains.length ? (
              selectedEnvironment.domains.map((domain) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-4 py-3"
                  key={domain.canonicalDomain}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-sm">
                      {domain.canonicalDomain}
                    </p>
                    <p className="mt-1 text-muted-foreground text-xs">
                      HTTPS on port 443 · apex and subdomains
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={domain.status === "active" ? "default" : "outline"}>
                      {domain.status === "active" ? "Allowed" : "Revoked"}
                    </Badge>
                    {domain.status === "active" ? (
                      <Button
                        onClick={() => setPendingDomain(domain.canonicalDomain)}
                        size="sm"
                        variant="outline"
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="py-3 text-muted-foreground text-sm">
                You have not allowed any Browser domains in this Environment.
              </p>
            )}
          </>
        )}
      </AppSettingsSection>

      <AlertDialog
        onOpenChange={(open) => {
          if (!(open || working)) setPendingDomain(null);
        }}
        open={pendingDomain !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {pendingDomain}?</AlertDialogTitle>
            <AlertDialogDescription>
              New Browser requests to this apex and its subdomains will be
              blocked unless Environment policy allows them separately. Past
              Thread results and artifacts are retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={working}
              onClick={(event) => {
                event.preventDefault();
                void revokeDomain();
              }}
            >
              {working ? "Revoking…" : "Revoke domain"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
