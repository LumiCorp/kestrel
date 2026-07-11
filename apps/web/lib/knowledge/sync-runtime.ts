import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { YoutubeTranscript } from "youtube-transcript";
import { knowledgeDb, type schema } from "@/lib/knowledge/db";
import { getRepoToken } from "@/lib/knowledge/github";
import { KV_KEYS, kvSet } from "@/lib/knowledge/kv";
import {
  createKnowledgeSnapshot,
  getActiveKnowledgeSnapshot,
  getKnowledgeSnapshotById,
  markSnapshotActive,
  updateKnowledgeSnapshot,
} from "@/lib/knowledge/snapshot-store";
import {
  countSnapshotFiles,
  removeSnapshotRoot,
  resetSnapshotRoot,
  writeSnapshotFile,
} from "@/lib/knowledge/storage";
import { updateKnowledgeSyncRun } from "@/lib/knowledge/sync-store";

const execFileAsync = promisify(execFile);
const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".json",
]);

type SyncedSourceResult = {
  sourceId: string;
  label: string;
  success: boolean;
  fileCount: number;
  error?: string;
};

function joinSnapshotTarget(
  baseRoot: string,
  basePath: string | null,
  outputPath: string
) {
  const normalizedBase = (basePath || "/docs").replace(/^\/+|\/+$/g, "");
  const segments = [baseRoot];
  if (normalizedBase) {
    segments.push(normalizedBase);
  }
  segments.push(outputPath);
  return path.join(...segments);
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function removeUnsupportedFiles(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") {
        await rm(fullPath, { recursive: true, force: true });
        continue;
      }
      await removeUnsupportedFiles(fullPath);
      const children = await readdir(fullPath).catch(() => []);
      if (children.length === 0) {
        await rm(fullPath, { recursive: true, force: true });
      }
      continue;
    }

    if (
      !SUPPORTED_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      await rm(fullPath, { force: true });
    }
  }
}

async function cloneGitHubRepository(input: {
  repo: string;
  branch: string;
  contentPath?: string | null;
}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "unified-knowledge-"));
  const token = await getRepoToken(input.repo);
  const repoUrl = token
    ? `https://x-access-token:${token}@github.com/${input.repo}.git`
    : `https://github.com/${input.repo}.git`;

  await execFileAsync("git", [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    input.branch || "main",
    "--filter=blob:none",
    "--sparse",
    repoUrl,
    tempDir,
  ]);

  if (input.contentPath) {
    await execFileAsync("git", ["sparse-checkout", "set", input.contentPath], {
      cwd: tempDir,
    });
  }

  return tempDir;
}

async function syncGitHubSource(
  snapshotRoot: string,
  source: typeof schema.sources.$inferSelect
): Promise<SyncedSourceResult> {
  const outputPath = source.outputPath || source.id;
  const targetDir = joinSnapshotTarget(
    snapshotRoot,
    source.basePath,
    outputPath
  );
  await mkdir(targetDir, { recursive: true });

  if (!source.repo) {
    return {
      sourceId: source.id,
      label: source.label,
      success: false,
      fileCount: 0,
      error: "Repository is not configured",
    };
  }

  if (source.readmeOnly) {
    const token = await getRepoToken(source.repo);
    const requestUrl = `https://raw.githubusercontent.com/${source.repo}/${source.branch || "main"}/README.md`;
    const response = await fetch(requestUrl, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

    if (!response.ok) {
      return {
        sourceId: source.id,
        label: source.label,
        success: false,
        fileCount: 0,
        error: `Failed to fetch README (${response.status})`,
      };
    }

    await writeSnapshotFile(targetDir, "README.md", await response.text());
    return {
      sourceId: source.id,
      label: source.label,
      success: true,
      fileCount: 1,
    };
  }

  let tempDir = "";
  try {
    tempDir = await cloneGitHubRepository({
      repo: source.repo,
      branch: source.branch || "main",
      contentPath: source.contentPath,
    });
    const sourcePath = source.contentPath
      ? path.join(tempDir, source.contentPath)
      : tempDir;

    await cp(sourcePath, targetDir, { recursive: true, force: true });
    await removeUnsupportedFiles(targetDir);
    const fileCount = await countSnapshotFiles(targetDir);

    return {
      sourceId: source.id,
      label: source.label,
      success: true,
      fileCount,
    };
  } catch (error) {
    return {
      sourceId: source.id,
      label: source.label,
      success: false,
      fileCount: 0,
      error:
        error instanceof Error ? error.message : "Unknown GitHub sync error",
    };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

type YouTubeVideo = {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
};

async function fetchYouTubeJson<T>(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`YouTube API request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function resolveYouTubeChannelId(
  source: typeof schema.sources.$inferSelect
) {
  if (source.channelId) {
    return source.channelId;
  }

  if (!(source.handle && process.env.YOUTUBE_API_KEY)) {
    return null;
  }

  const handle = source.handle.replace(/^@/, "");
  const query = new URLSearchParams({
    part: "snippet",
    q: handle,
    type: "channel",
    maxResults: "1",
    key: process.env.YOUTUBE_API_KEY,
  });
  const json = await fetchYouTubeJson<{
    items?: Array<{ snippet?: { channelId?: string } }>;
  }>(`https://www.googleapis.com/youtube/v3/search?${query.toString()}`);

  return json.items?.[0]?.snippet?.channelId ?? null;
}

async function fetchChannelVideos(
  channelId: string,
  maxVideos: number
): Promise<YouTubeVideo[]> {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error("YOUTUBE_API_KEY is not configured");
  }

  const videos: YouTubeVideo[] = [];
  let pageToken = "";

  while (videos.length < maxVideos) {
    const query = new URLSearchParams({
      part: "snippet",
      channelId,
      order: "date",
      type: "video",
      maxResults: String(Math.min(50, maxVideos - videos.length)),
      key: process.env.YOUTUBE_API_KEY,
    });
    if (pageToken) {
      query.set("pageToken", pageToken);
    }

    const json = await fetchYouTubeJson<{
      nextPageToken?: string;
      items?: Array<{
        id?: { videoId?: string };
        snippet?: {
          title?: string;
          description?: string;
          publishedAt?: string;
          thumbnails?: { high?: { url?: string }; default?: { url?: string } };
        };
      }>;
    }>(`https://www.googleapis.com/youtube/v3/search?${query.toString()}`);

    for (const item of json.items ?? []) {
      if (!(item.id?.videoId && item.snippet?.title)) {
        continue;
      }
      videos.push({
        id: item.id.videoId,
        title: item.snippet.title,
        description: item.snippet.description || "",
        publishedAt: item.snippet.publishedAt || new Date().toISOString(),
        thumbnailUrl:
          item.snippet.thumbnails?.high?.url ||
          item.snippet.thumbnails?.default?.url ||
          "",
      });
    }

    if (!json.nextPageToken) {
      break;
    }
    pageToken = json.nextPageToken;
  }

  return videos;
}

function buildTranscriptMarkdown(video: YouTubeVideo, transcript: string) {
  return `# ${video.title}

- Video ID: ${video.id}
- Published: ${video.publishedAt}
- Thumbnail: ${video.thumbnailUrl || "n/a"}

## Description

${video.description || "No description."}

## Transcript

${transcript || "Transcript unavailable."}
`;
}

async function syncYouTubeSource(
  snapshotRoot: string,
  source: typeof schema.sources.$inferSelect
): Promise<SyncedSourceResult> {
  const channelId = await resolveYouTubeChannelId(source);
  if (!channelId) {
    return {
      sourceId: source.id,
      label: source.label,
      success: false,
      fileCount: 0,
      error: "YouTube channel ID could not be resolved",
    };
  }

  const targetDir = joinSnapshotTarget(
    snapshotRoot,
    source.basePath || "/youtube",
    source.outputPath || source.id
  );
  await mkdir(targetDir, { recursive: true });

  try {
    const videos = await fetchChannelVideos(channelId, source.maxVideos || 50);
    const index = [];
    let fileCount = 0;

    for (const video of videos) {
      try {
        const transcript = await YoutubeTranscript.fetchTranscript(video.id);
        const body = transcript.map((segment) => segment.text).join(" ");
        const filename = `${video.id}-${slugify(video.title)}.md`;
        await writeSnapshotFile(
          targetDir,
          filename,
          buildTranscriptMarkdown(video, body)
        );
        fileCount += 1;
        index.push({
          id: video.id,
          title: video.title,
          publishedAt: video.publishedAt,
          file: filename,
          hasTranscript: body.length > 0,
        });
      } catch {
        index.push({
          id: video.id,
          title: video.title,
          publishedAt: video.publishedAt,
          file: null,
          hasTranscript: false,
        });
      }
    }

    await writeSnapshotFile(
      targetDir,
      "videos.json",
      JSON.stringify(
        {
          lastSync: new Date().toISOString(),
          channelId,
          handle: source.handle,
          totalVideos: fileCount,
          videos: index,
        },
        null,
        2
      )
    );

    return {
      sourceId: source.id,
      label: source.label,
      success: true,
      fileCount: fileCount + 1,
    };
  } catch (error) {
    return {
      sourceId: source.id,
      label: source.label,
      success: false,
      fileCount: 0,
      error:
        error instanceof Error ? error.message : "Unknown YouTube sync error",
    };
  }
}

async function syncSourceIntoSnapshot(
  snapshotRoot: string,
  source: typeof schema.sources.$inferSelect
) {
  if (source.type === "github") {
    return syncGitHubSource(snapshotRoot, source);
  }

  if (source.type === "youtube") {
    return syncYouTubeSource(snapshotRoot, source);
  }

  return {
    sourceId: source.id,
    label: source.label,
    success: false,
    fileCount: 0,
    error: `Unsupported source type: ${source.type}`,
  } satisfies SyncedSourceResult;
}

export async function processKnowledgeSyncRun(runId: string) {
  const run = await knowledgeDb.query.knowledgeSyncRuns.findFirst({
    where: (table, { eq }) => eq(table.id, runId),
  });

  if (!run) {
    throw new Error("Sync run not found");
  }

  await updateKnowledgeSyncRun(run.id, {
    status: "running",
    startedAt: new Date(),
    error: null,
  });

  const snapshot = await createKnowledgeSnapshot({
    organizationId: run.organizationId,
    filesystemPath: "",
    status: "building",
    metadata: {
      runId: run.id,
      sourceFilter: run.sourceFilter ?? null,
    },
  });

  const snapshotRoot = await resetSnapshotRoot(run.organizationId, snapshot.id);
  await updateKnowledgeSnapshot(snapshot.id, {
    filesystemPath: snapshotRoot,
  });

  const allSources = await knowledgeDb.query.sources.findMany({
    where: (table, { eq }) => eq(table.organizationId, run.organizationId),
  });

  const sources = run.sourceFilter
    ? allSources.filter(
        (source) =>
          source.id === run.sourceFilter ||
          source.label === run.sourceFilter ||
          source.type === run.sourceFilter
      )
    : allSources;

  const results: SyncedSourceResult[] = [];
  try {
    for (const source of sources) {
      results.push(await syncSourceIntoSnapshot(snapshotRoot, source));
    }

    const fileCount = await countSnapshotFiles(snapshotRoot);
    const failed = results.filter((result) => !result.success);
    const status =
      failed.length === 0 ? "ready" : fileCount > 0 ? "ready" : "failed";

    await updateKnowledgeSnapshot(snapshot.id, {
      status,
      sourceCount: sources.length,
      fileCount,
      lastSyncedAt: new Date(),
      error:
        failed.length > 0 && fileCount === 0
          ? failed
              .map((result) => result.error)
              .filter(Boolean)
              .join("; ")
          : null,
      metadata: {
        runId: run.id,
        results,
      },
    });

    if (status === "ready") {
      const previousActive = await getActiveKnowledgeSnapshot(
        run.organizationId
      );
      await markSnapshotActive(run.organizationId, snapshot.id);
      if (previousActive && previousActive.id !== snapshot.id) {
        await updateKnowledgeSnapshot(previousActive.id, {
          status: "stale",
        });
      }

      await Promise.all([
        kvSet(
          KV_KEYS.CURRENT_SNAPSHOT,
          {
            snapshotId: snapshot.id,
            createdAt: Date.now(),
          },
          run.organizationId
        ),
        kvSet(KV_KEYS.ACTIVE_SANDBOX_SESSION, null, run.organizationId),
        kvSet(KV_KEYS.LAST_SOURCE_SYNC, Date.now(), run.organizationId),
      ]);
    }

    await updateKnowledgeSyncRun(run.id, {
      status: status === "ready" ? "completed" : "failed",
      snapshotId: snapshot.id,
      sourceCount: sources.length,
      fileCount,
      finishedAt: new Date(),
      error:
        failed.length > 0 && fileCount === 0
          ? failed
              .map((result) => result.error)
              .filter(Boolean)
              .join("; ")
          : null,
      metadata: {
        results,
      },
    });

    return {
      runId: run.id,
      snapshotId: snapshot.id,
      results,
      fileCount,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown sync error";
    await updateKnowledgeSnapshot(snapshot.id, {
      status: "failed",
      error: message,
    });
    await updateKnowledgeSyncRun(run.id, {
      status: "failed",
      snapshotId: snapshot.id,
      finishedAt: new Date(),
      error: message,
      metadata: {
        results,
      },
    });
    await removeSnapshotRoot(snapshotRoot).catch(() => {});
    throw error;
  }
}

export async function createManualSnapshotFromActive(organizationId: string) {
  const active = await getActiveKnowledgeSnapshot(organizationId);
  if (!active) {
    throw new Error("No active snapshot is available");
  }

  const clone = await createKnowledgeSnapshot({
    organizationId,
    filesystemPath: active.filesystemPath,
    status: "ready",
    metadata: {
      clonedFromSnapshotId: active.id,
    },
  });
  await markSnapshotActive(organizationId, clone.id);
  return getKnowledgeSnapshotById(organizationId, clone.id);
}
