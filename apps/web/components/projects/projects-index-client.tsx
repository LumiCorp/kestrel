"use client";

import { FolderOpen, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { buildMobileProjectCallback } from "@/lib/projects/mobile-return";

export type ProjectIndexItem = {
  id: string;
  name: string;
  description: string | null;
  role: "owner" | "editor" | "member";
  updatedAt: string;
};

export function ProjectsIndexClient({
  projects,
  allowCreate = true,
  mobileReturnTo,
}: {
  projects: ProjectIndexItem[];
  allowCreate?: boolean;
  mobileReturnTo?: string | null;
}) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  async function submit() {
    setCreating(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description, instructions }),
      });
      const result = (await response.json()) as {
        project?: { id: string };
        error?: string;
      };
      if (!(response.ok && result.project)) {
        throw new Error(result.error || "Project creation failed.");
      }
      toast.success("Project created");
      await mutate("/api/projects");
      if (mobileReturnTo) {
        window.location.assign(
          buildMobileProjectCallback(mobileReturnTo, result.project.id)
        );
        return;
      }
      router.push(`/projects/${result.project.id}`);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Project creation failed."
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid content-start gap-3 md:grid-cols-2">
        {projects.map((project) => (
          <Link href={`/projects/${project.id}`} key={project.id}>
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FolderOpen className="size-4" /> {project.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="line-clamp-2 text-muted-foreground">
                  {project.description || "No description yet."}
                </p>
                <p className="text-xs uppercase tracking-wide">
                  {project.role}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
        {!projects.length && (
          <Card className="md:col-span-2">
            <CardContent className="py-12 text-center text-muted-foreground">
              Create your first Project to share context, files, and Threads.
            </CardContent>
          </Card>
        )}
      </div>
      {allowCreate && (
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="size-4" /> New Project
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              value={name}
            />
            <Input
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Description"
              value={description}
            />
            <Textarea
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Instructions shared by every project Thread"
              rows={6}
              value={instructions}
            />
            <Button
              className="w-full"
              disabled={creating || !name.trim()}
              onClick={() => void submit()}
            >
              {creating ? "Creating…" : "Create Project"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
