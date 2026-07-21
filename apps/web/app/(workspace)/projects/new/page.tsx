import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { AppPage } from "@/components/app-page";
import { CreateProjectForm } from "@/components/projects/create-project-form";
import { Button } from "@/components/ui/button";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { resolveMobileProjectReturn } from "@/lib/projects/mobile-return";

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; returnTo?: string }>;
}) {
  await requireActiveOrganization();
  const mobileReturnTo = resolveMobileProjectReturn(await searchParams);

  return (
    <AppPage>
      <div className="flex items-start gap-3 border-b pb-5">
        <Button asChild className="mt-0.5" size="icon" variant="ghost">
          <Link aria-label="Back to Projects" href="/projects">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.16em]">
            Projects
          </p>
          <h1 className="mt-1 font-semibold text-3xl tracking-tight">New Project</h1>
          <p className="mt-1 text-muted-foreground">
            Create a shared workspace for context, files, and collaborative Threads.
          </p>
        </div>
      </div>
      <CreateProjectForm mobileReturnTo={mobileReturnTo} />
    </AppPage>
  );
}
