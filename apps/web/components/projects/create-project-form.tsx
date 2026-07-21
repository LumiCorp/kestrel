"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { buildMobileProjectCallback } from "@/lib/projects/mobile-return";

export function CreateProjectForm({
  mobileReturnTo,
}: {
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
      router.push("/projects");
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
    <form
      className="divide-y border-y"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 py-5 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-8">
        <div>
          <Label htmlFor="project-name">Name</Label>
          <p className="mt-1 text-muted-foreground text-xs">
            A clear, recognizable name for this workspace.
          </p>
        </div>
        <Input
          autoFocus
          id="project-name"
          onChange={(event) => setName(event.target.value)}
          placeholder="Project name"
          value={name}
        />
      </div>
      <div className="grid gap-3 py-5 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-8">
        <div>
          <Label htmlFor="project-description">Description</Label>
          <p className="mt-1 text-muted-foreground text-xs">
            Summarize the purpose of the Project.
          </p>
        </div>
        <Input
          id="project-description"
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What is this Project for?"
          value={description}
        />
      </div>
      <div className="grid gap-3 py-5 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-8">
        <div>
          <Label htmlFor="project-instructions">Instructions</Label>
          <p className="mt-1 text-muted-foreground text-xs">
            Shared with every Thread created in this Project.
          </p>
        </div>
        <Textarea
          id="project-instructions"
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Add durable context and working instructions…"
          rows={8}
          value={instructions}
        />
      </div>
      <div className="flex justify-end gap-2 py-5">
        <Button onClick={() => router.push("/projects")} type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={creating || !name.trim()} type="submit">
          {creating ? "Creating…" : "Create Project"}
        </Button>
      </div>
    </form>
  );
}
