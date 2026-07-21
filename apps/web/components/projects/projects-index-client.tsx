import { ArrowUpRight, FolderOpen } from "lucide-react";
import Link from "next/link";

export type ProjectIndexItem = {
  id: string;
  name: string;
  description: string | null;
  role: "owner" | "editor" | "member";
  updatedAt: string;
};

export function ProjectsIndexClient({
  projects,
}: {
  projects: ProjectIndexItem[];
}) {
  if (!projects.length) {
    return (
      <div className="border-y py-14 text-center text-muted-foreground text-sm">
        No Projects yet. Create one to share context, files, and Threads.
      </div>
    );
  }

  return (
    <div className="grid border-y sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <Link
          className="group flex min-h-40 min-w-0 flex-col border-border/70 border-r border-b p-5 transition-colors hover:bg-muted/40 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          href={`/projects/${project.id}`}
          key={project.id}
        >
          <div className="flex items-start justify-between gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg border bg-background">
              <FolderOpen className="size-4" />
            </span>
            <ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <h2 className="mt-4 truncate font-medium">{project.name}</h2>
          <p className="mt-1 line-clamp-2 text-muted-foreground text-sm">
            {project.description || "No description yet."}
          </p>
          <p className="mt-auto pt-4 text-muted-foreground text-xs capitalize">
            {project.role}
          </p>
        </Link>
      ))}
    </div>
  );
}
