"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  CalendarDays,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { AppIcon } from "@/components/apps/app-icon";
import { AppGallery } from "@/components/apps/app-gallery";
import { ProjectSharedAppSheet } from "@/components/projects/project-shared-app-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ProjectAppConfiguration } from "@/lib/apps/project-service";
import { cn } from "@/lib/utils";

type GoogleConnectionStatus = {
  configured: boolean;
  linked: boolean;
  projectConnected: boolean;
  shareAvailability: boolean;
  needsReconnect: boolean;
  providerLogin: string | null;
  scopes: string[];
  environmentCapabilities: Array<{
    capabilityKey: string;
    enabled: boolean;
  }>;
};

type ProjectAppsResponse = {
  apps: ProjectAppConfiguration[];
  role: "owner" | "editor" | "member";
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body as T;
}

async function requestJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

function ProviderIcon({
  src,
  alt,
  compact = false,
}: {
  src: string;
  alt: string;
  compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm",
        compact ? "size-10" : "size-12"
      )}
    >
      <Image
        alt={alt}
        className="size-7 object-contain"
        height={28}
        src={src}
        width={28}
      />
    </span>
  );
}

export function ProjectApps({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const statusUrl = `/api/projects/${projectId}/apps/google`;
  const { data, error, isLoading, mutate } = useSWR<GoogleConnectionStatus>(
    statusUrl,
    fetchJson
  );
  const projectAppsUrl = `/api/projects/${projectId}/apps`;
  const { data: projectApps, mutate: mutateProjectApps } =
    useSWR<ProjectAppsResponse>(projectAppsUrl, fetchJson);
  const [googleOpen, setGoogleOpen] = useState(false);
  const [sharedAppKey, setSharedAppKey] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [shareOverride, setShareOverride] = useState<boolean | null>(null);
  const handledCallback = useRef(false);
  const shareAvailability = shareOverride ?? data?.shareAvailability ?? false;

  const syncGoogle = useCallback(
    async (shouldShare: boolean) => {
      setWorking(true);
      try {
        await requestJson(`${statusUrl}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            calendar: true,
            shareAvailability: shouldShare,
          }),
        });
        await mutate();
        setShareOverride(null);
        setGoogleOpen(false);
        toast.success("Google Calendar connected", {
          description: shouldShare
            ? "Calendar tools are ready and your free/busy availability is shared with this Project."
            : "Calendar tools are ready for you in this Project.",
        });
      } catch (syncError) {
        toast.error(
          syncError instanceof Error
            ? syncError.message
            : "Google Calendar could not be synchronized."
        );
        throw syncError;
      } finally {
        setWorking(false);
      }
    },
    [mutate, statusUrl]
  );

  useEffect(() => {
    const googleResult = searchParams.get("google");
    if (!googleResult || handledCallback.current) return;
    handledCallback.current = true;
    setGoogleOpen(true);
    const cleanCallbackUrl = () => {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("google");
      next.delete("shareAvailability");
      next.set("tab", "apps");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    };
    if (googleResult === "error") {
      toast.error("Google Calendar authorization was not completed.");
      cleanCallbackUrl();
      return;
    }
    const shouldShare = searchParams.get("shareAvailability") === "1";
    void syncGoogle(shouldShare)
      .then(() => cleanCallbackUrl())
      .catch(() => cleanCallbackUrl());
  }, [pathname, router, searchParams, syncGoogle]);

  function chooseApp(configuration: ProjectAppConfiguration) {
    if (configuration.app.key === "google_workspace") {
      setGoogleOpen(true);
      return;
    }
    setSharedAppKey(configuration.app.key);
  }

  function setGoogleDialogOpen(open: boolean) {
    setGoogleOpen(open);
    if (!(open || working)) setShareOverride(null);
  }

  async function connectGoogle() {
    setWorking(true);
    try {
      const result = await requestJson<{ linked: boolean; url: string | null }>(
        `${statusUrl}/connect`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ calendar: true, shareAvailability }),
        }
      );
      if (result.url) {
        window.location.assign(result.url);
        return;
      }
      await syncGoogle(shareAvailability);
    } catch (connectError) {
      toast.error(
        connectError instanceof Error
          ? connectError.message
          : "Google Calendar could not be connected."
      );
    } finally {
      setWorking(false);
    }
  }

  async function updateSharing(enabled: boolean) {
    setShareOverride(enabled);
    setWorking(true);
    try {
      await requestJson(`${statusUrl}/sharing`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shareAvailability: enabled }),
      });
      await mutate();
      setShareOverride(null);
      toast.success(
        enabled
          ? "Calendar availability shared with this Project"
          : "Calendar availability is private"
      );
    } catch (sharingError) {
      setShareOverride(null);
      toast.error(
        sharingError instanceof Error
          ? sharingError.message
          : "Availability sharing could not be updated."
      );
    } finally {
      setWorking(false);
    }
  }

  async function disconnectGoogle() {
    setWorking(true);
    try {
      await requestJson(`${statusUrl}/disconnect`, { method: "DELETE" });
      await mutate();
      setGoogleOpen(false);
      toast.success("Google Calendar removed from this Project", {
        description:
          "Your Google account remains linked and available to other Projects.",
      });
    } catch (disconnectError) {
      toast.error(
        disconnectError instanceof Error
          ? disconnectError.message
          : "Google Calendar could not be removed."
      );
    } finally {
      setWorking(false);
    }
  }

  const environmentReady =
    data?.environmentCapabilities.every((capability) => capability.enabled) ??
    false;
  const googleLabel = data?.needsReconnect
    ? "Reconnect"
    : data?.projectConnected
      ? "Connected"
      : "Not connected";

  return (
    <div className="w-full py-5">
      {projectApps?.apps.length ? (
        <AppGallery
          items={projectApps.apps.map((configuration) => {
          const isGoogle = configuration.app.key === "google_workspace";
          const needsConnection =
            configuration.app.connectionRequirement === "required";
          const projectDefault =
            configuration.attachedConnections.find(
              (connection) =>
                connection.isDefault && connection.scope === "personal"
            ) ??
            configuration.attachedConnections.find(
              (connection) =>
                connection.isDefault && connection.scope === "shared"
            );
          const status = isGoogle
            ? isLoading
              ? "Checking…"
              : googleLabel
            : configuration.enabled && !needsConnection
              ? "Enabled"
              : configuration.enabled && projectDefault
                ? `Using ${projectDefault.name}`
                : configuration.availableConnections.length
                  ? "Available"
                  : "Setup required";
          return {
            key: configuration.app.key,
            name: configuration.app.displayName,
            description: configuration.app.description,
            icon: configuration.app.icon,
            status,
            statusTone:
              status === "Enabled" || status === "Connected" || status.startsWith("Using ")
                ? "ready"
                : status === "Setup required" || status === "Reconnect"
                  ? "warning"
                  : "neutral",
          };
        })}
          onSelect={(item) => {
            const configuration = projectApps.apps.find(
              (candidate) => candidate.app.key === item.key
            );
            if (configuration) chooseApp(configuration);
          }}
        />
      ) : projectApps ? (
        <div className="border-y py-6">
          <p className="font-medium text-sm">No Apps available</p>
          <p className="mt-1 text-muted-foreground text-sm">
            An organization admin must install an App before it can be added to
            this Project.
          </p>
        </div>
      ) : null}

      <Dialog.Root onOpenChange={setGoogleDialogOpen} open={googleOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-transparent" />
          <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-[-14px_0_40px_rgba(17,17,17,0.05)] outline-none sm:w-[36.5rem]">
            <div className="relative flex items-center gap-4 border-b px-6 py-7 pr-16 sm:px-8">
              <ProviderIcon alt="Google logo" src="/integrations/google.svg" />
              <div>
                <Dialog.Title className="font-semibold text-xl tracking-tight">
                  {data?.projectConnected
                    ? "Google Calendar"
                    : "Connect Google Calendar"}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-muted-foreground text-sm">
                  Connect your calendar to this Project for you and your agents.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  aria-label="Close Google Calendar connection"
                  className="absolute top-5 right-5"
                  size="icon"
                  variant="ghost"
                >
                  <X className="size-5" />
                </Button>
              </Dialog.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 sm:px-8">
              <section className="py-7">
                <h3 className="font-semibold text-base">For you</h3>
                <p className="mt-1 text-muted-foreground text-sm">
                  Calendar connects to your account and is used directly by you.
                </p>
                <div className="mt-4 flex items-start gap-4 py-3">
                  <ProviderIcon
                    alt="Google Calendar logo"
                    compact
                    src="/integrations/google-calendar.svg"
                  />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="font-semibold">Calendar</p>
                    <p className="mt-1 max-w-sm text-muted-foreground text-sm leading-5">
                      Check your schedule, create events, and manage time across
                      your day.
                    </p>
                    {data?.providerLogin && (
                      <p className="mt-2 text-muted-foreground text-xs">
                        Connected as {data.providerLogin}
                      </p>
                    )}
                    {data?.projectConnected && !environmentReady && (
                      <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-amber-900 text-xs dark:bg-amber-950 dark:text-amber-200">
                        Calendar is connected, but this Project&apos;s
                        Environment must enable all Calendar capabilities before
                        agents can use them.
                      </p>
                    )}
                  </div>
                  <span className="mt-1 rounded-md bg-emerald-100 px-2.5 py-1.5 font-medium text-emerald-800 text-sm dark:bg-emerald-950 dark:text-emerald-300">
                    Included
                  </span>
                </div>
              </section>

              <section className="border-t py-7">
                <h3 className="font-semibold text-base">
                  For project teammates
                </h3>
                <p className="mt-1 text-muted-foreground text-sm">
                  You control what your own connection shares with this Project.
                </p>
                <div className="mt-6 flex items-start gap-4">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm">
                    <CalendarDays className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">Calendar availability</p>
                    <p className="mt-1 max-w-sm text-muted-foreground text-sm leading-5">
                      Share free/busy times so teammates can schedule meetings
                      with you.
                    </p>
                    <p className="mt-4 max-w-sm text-muted-foreground text-xs leading-5">
                      Only free/busy intervals are shared. Event titles,
                      locations, attendees, and details remain private.
                    </p>
                  </div>
                  <Switch
                    aria-label="Share calendar availability with project teammates"
                    checked={shareAvailability}
                    className="mt-1"
                    disabled={working || !data?.configured}
                    onCheckedChange={(enabled) => {
                      if (data?.projectConnected) void updateSharing(enabled);
                      else setShareOverride(enabled);
                    }}
                  />
                </div>
              </section>
            </div>

            <div className="border-t px-6 py-6 sm:px-8">
              {error && (
                <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
                  {error.message}
                </p>
              )}
              {!(data?.configured || isLoading) && (
                <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:bg-amber-950 dark:text-amber-200">
                  Google OAuth credentials must be configured before Calendar
                  can be connected.
                </p>
              )}
              <div className="mb-6 flex items-center gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">
                  <ShieldCheck className="size-5" />
                </span>
                <p className="font-medium text-sm">
                  Google will ask you to approve only Calendar permissions.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                {data?.projectConnected && !data.needsReconnect ? (
                  <Button
                    className="sm:min-w-52"
                    disabled={working}
                    onClick={() => void disconnectGoogle()}
                    variant="outline"
                  >
                    {working && <Loader2 className="size-4 animate-spin" />}
                    Remove from this Project
                  </Button>
                ) : (
                  <Button
                    className="sm:min-w-44"
                    disabled={working || isLoading || !data?.configured}
                    onClick={() => void connectGoogle()}
                  >
                    {working ? (
                      <>
                        <Loader2 className="size-4 animate-spin" /> Connecting…
                      </>
                    ) : data?.needsReconnect ? (
                      "Reconnect Google"
                    ) : data?.linked ? (
                      "Add to this Project"
                    ) : (
                      "Continue to Google"
                    )}
                  </Button>
                )}
                <Dialog.Close asChild>
                  <Button className="sm:min-w-28" variant="outline">
                    Cancel
                  </Button>
                </Dialog.Close>
              </div>
              <p className="mt-5 text-center text-muted-foreground text-xs">
                Removing Calendar here does not revoke your Google account or
                remove it from other Projects.
              </p>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ProjectSharedAppSheet
        canAttachPersonal={Boolean(projectApps)}
        canEdit={canEdit && projectApps?.role !== "member"}
        configuration={
          projectApps?.apps.find(
            (configuration) => configuration.app.key === sharedAppKey
          ) ?? null
        }
        onChanged={() => mutateProjectApps()}
        onOpenChange={(open) => {
          if (!open) setSharedAppKey(null);
        }}
        open={sharedAppKey !== null}
        projectId={projectId}
      />
    </div>
  );
}
