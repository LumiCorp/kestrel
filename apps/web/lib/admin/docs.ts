import { promises as fs } from "node:fs";
import path from "node:path";

export const ADMIN_DOCS = [
  {
    group: "Start",
    slug: "getting-started",
    title: "Getting Started",
    description:
      "Bootstrap Kestrel One locally and understand the admin workspace.",
  },
  {
    group: "Operate",
    slug: "admin-mode",
    title: "Admin Mode",
    description:
      "How admin routing, policy, and org scoping work in Kestrel One.",
  },
  {
    group: "Operate",
    slug: "api-keys",
    title: "API Keys",
    description: "Manage app-owned admin API keys and rotation expectations.",
  },
  {
    group: "Integrate",
    slug: "discord-bot",
    title: "Discord Bot",
    description:
      "Configure Discord guild bindings, gateway activation, and interactions endpoint readiness.",
  },
  {
    group: "Integrate",
    slug: "sdk",
    title: "SDK",
    description:
      "Integrate against the canonical chat and knowledge API family.",
  },
  {
    group: "Operate",
    slug: "knowledge-library",
    title: "Knowledge Library",
    description:
      "Operate the MinIO-backed document upload and RAG pipeline, including queue and retrieval troubleshooting.",
  },
] as const;

const DOCS_DIR = path.join(process.cwd(), "content", "admin-docs");

export async function readAdminDoc(slug: string) {
  const doc = ADMIN_DOCS.find((entry) => entry.slug === slug);
  if (!doc) {
    return null;
  }

  const filePath = path.join(DOCS_DIR, `${slug}.md`);
  const content = await fs.readFile(filePath, "utf8");

  return {
    ...doc,
    content: content.replace(/^#\s+[^\n]+\n+/u, ""),
  };
}
