import { ArrowUpRight } from "lucide-react";
import {
  ResourceEmpty,
  ResourceList,
  ResourceRow,
} from "@/components/resource-list";
import { TimeText } from "@/components/ui/time-text";

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
      <div className="border-y">
        <ResourceEmpty
          description="Create one to share context, files, and Threads."
          title="No Projects yet"
        />
      </div>
    );
  }

  return (
    <ResourceList>
      {projects.map((project) => (
        <ResourceRow
          className="px-1 transition-colors hover:bg-muted/30 sm:px-2"
          description={project.description || undefined}
          href={`/projects/${project.id}`}
          key={project.id}
          metadata={
            <>
              <span className="capitalize">{project.role}</span>
              <span aria-hidden="true"> · </span>
              Updated <TimeText mode="relative" value={project.updatedAt} />
            </>
          }
          status={
            <ArrowUpRight className="size-4 text-muted-foreground" />
          }
          title={project.name}
        />
      ))}
    </ResourceList>
  );
}
