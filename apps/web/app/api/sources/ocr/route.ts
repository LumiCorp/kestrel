import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  images: z.array(z.string()).optional().default([]),
  configs: z
    .array(
      z.object({
        filename: z.string(),
        content: z.string(),
      })
    )
    .optional()
    .default([]),
});

const sourceOcrItemSchema = z.object({
  type: z.enum(["github", "youtube"]),
  label: z.string().max(50),
  repo: z.string().max(120).optional(),
  branch: z.string().max(50).optional(),
  contentPath: z.string().max(120).optional(),
  outputPath: z.string().max(120).optional(),
  readmeOnly: z.boolean().optional(),
  channelId: z.string().length(24).optional(),
  handle: z.string().max(50).optional(),
  maxVideos: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  unsupportedReason: z.string().optional(),
});

type SourceOcrItem = z.infer<typeof sourceOcrItemSchema>;

const YOUTUBE_CHANNEL_PATTERN = /^UC[a-zA-Z0-9_-]{22}$/;

function sanitizeLabel(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/\.+/g, ".")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
}

function sanitizeRepo(repo: string) {
  const cleaned = repo
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9_./-]/g, "")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");

  const [owner, name, ...rest] = cleaned.split("/");
  if (!(owner && name) || rest.length > 0) {
    return null;
  }

  const validPart = /^[a-z0-9][a-z0-9._-]*$/;
  if (!(validPart.test(owner) && validPart.test(name))) {
    return null;
  }

  return `${owner}/${name}`;
}

function sanitizeSource(source: SourceOcrItem): SourceOcrItem | null {
  const label = sanitizeLabel(source.label || "");
  if (!label) {
    return null;
  }

  if (source.type === "github") {
    const repo = sanitizeRepo(source.repo || "");
    if (!repo) {
      return null;
    }

    const [, repoName] = repo.split("/");
    const normalizedLabel =
      repoName && repoName.replace(/\./g, "") === label.replace(/\./g, "")
        ? repoName
        : label;

    return {
      ...source,
      label: normalizedLabel,
      repo,
      branch:
        source.branch?.toLowerCase().replace(/[^a-z0-9._-]/g, "") || "main",
      contentPath: source.contentPath?.replace(/^\/+|\/+$/g, "") || "",
      confidence: source.confidence ?? 1,
    };
  }

  const channelId = source.channelId?.trim();
  if (!(channelId && YOUTUBE_CHANNEL_PATTERN.test(channelId))) {
    return null;
  }

  return {
    ...source,
    label,
    channelId,
    handle: source.handle
      ? source.handle.startsWith("@")
        ? source.handle
        : `@${source.handle}`
      : undefined,
    confidence: source.confidence ?? 1,
  };
}

function extractFromConfig(content: string): SourceOcrItem[] {
  const sources: SourceOcrItem[] = [];
  const githubPattern =
    /(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/g;
  const channelPattern = /(UC[a-zA-Z0-9_-]{22})/g;

  for (const match of content.matchAll(githubPattern)) {
    const repo = match[1];
    const label = repo.split("/")[1] || repo;
    sources.push({
      type: "github",
      label,
      repo,
      branch: "main",
      confidence: 0.9,
    });
  }

  for (const match of content.matchAll(channelPattern)) {
    const channelId = match[1];
    sources.push({
      type: "youtube",
      label: channelId,
      channelId,
      maxVideos: 50,
      confidence: 0.9,
    });
  }

  return sources;
}

function deduplicate(sources: SourceOcrItem[]): SourceOcrItem[] {
  const seen = new Set<string>();
  const unique: SourceOcrItem[] = [];

  for (const source of sources) {
    const sanitized = sanitizeSource(source);
    if (!sanitized) {
      continue;
    }

    const key =
      sanitized.type === "github"
        ? sanitized.repo
          ? `gh:${sanitized.repo}`
          : `gh-label:${sanitized.label}`
        : sanitized.channelId
          ? `yt:${sanitized.channelId}`
          : `yt-label:${sanitized.label}`;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(sanitized);
  }

  return unique;
}

export async function POST(request: NextRequest) {
  try {
    await requireSession();
    const body = bodySchema.parse(await request.json());

    const extracted = body.configs.flatMap((config) =>
      extractFromConfig(config.content)
    );

    const imageResults: SourceOcrItem[] = body.images.map((_image, index) => ({
      type: "github",
      label: `image-${index + 1}`,
      confidence: 0,
      unsupportedReason: "image-ocr-not-configured",
    }));

    const sources = deduplicate([...extracted, ...imageResults]).map((item) =>
      sourceOcrItemSchema.parse(item)
    );

    return NextResponse.json({ sources });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
