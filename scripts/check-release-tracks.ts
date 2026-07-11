import { readFile } from "node:fs/promises";
import path from "node:path";

interface ReleaseTrack {
  id: string;
  title: string;
  status: "active" | "pending" | "done";
  owner: string;
  order: number;
  depends_on: string[];
  required_checks: string[];
  file_prefixes: string[];
}

interface ReleaseTrackManifest {
  version: number;
  generated_at: string;
  tracks: ReleaseTrack[];
}

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, "docs", "references", "release-tracks.json");

async function main(): Promise<void> {
  const manifest = await loadManifest();
  const errors: string[] = [];

  if (manifest.tracks.length < 5 || manifest.tracks.length > 7) {
    errors.push(`manifest must define 5-7 tracks, found ${manifest.tracks.length}`);
  }

  const seenIds = new Set<string>();
  for (const track of manifest.tracks) {
    if (track.id.trim().length === 0) {
      errors.push("track id cannot be empty");
      continue;
    }
    if (seenIds.has(track.id)) {
      errors.push(`duplicate track id '${track.id}'`);
    }
    seenIds.add(track.id);

    if (track.owner.trim().length === 0) {
      errors.push(`track '${track.id}' has empty owner`);
    }
    if (track.required_checks.length === 0) {
      errors.push(`track '${track.id}' must declare required_checks`);
    }
    if (track.file_prefixes.length === 0) {
      errors.push(`track '${track.id}' must declare file_prefixes`);
    }
  }

  const byOrder = [...manifest.tracks].sort((a, b) => a.order - b.order);
  byOrder.forEach((track, index) => {
    if (track.order !== index + 1) {
      errors.push(`track '${track.id}' has non-contiguous order '${track.order}' (expected ${index + 1})`);
    }
  });

  for (const track of manifest.tracks) {
    for (const dep of track.depends_on) {
      if (seenIds.has(dep) === false) {
        errors.push(`track '${track.id}' depends on unknown track '${dep}'`);
      }
      const dependency = manifest.tracks.find((candidate) => candidate.id === dep);
      if (dependency !== undefined && dependency.order >= track.order) {
        errors.push(`track '${track.id}' dependency '${dep}' must have lower order`);
      }
    }
  }

  const activeTracks = manifest.tracks.filter((track) => track.status === "active");
  if (activeTracks.length === 0) {
    errors.push("at least one release track must be marked active");
  }
  for (let index = 0; index < activeTracks.length; index += 1) {
    const current = activeTracks[index];
    for (let peerIndex = index + 1; peerIndex < activeTracks.length; peerIndex += 1) {
      const peer = activeTracks[peerIndex];
      const overlap = findPrefixOverlap(current.file_prefixes, peer.file_prefixes);
      if (overlap.length > 0) {
        errors.push(
          `active tracks '${current.id}' and '${peer.id}' overlap file ownership: ${overlap.join(", ")}`,
        );
      }
    }
  }

  const changedPaths = readChangedPaths();
  if (changedPaths.length > 0) {
    const activeAssignments = assignChangedPaths(activeTracks, changedPaths);
    for (const [file, owners] of activeAssignments.entries()) {
      if (owners.length === 0) {
        errors.push(`changed file '${file}' is not owned by any active release track`);
        continue;
      }
      if (owners.length > 1) {
        errors.push(`changed file '${file}' is owned by multiple active tracks: ${owners.join(", ")}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const message of errors) {
      process.stderr.write(`[release-tracks] ${message}\n`);
    }
    process.stderr.write(`[release-tracks] failed with ${errors.length} issue(s)\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `[release-tracks] validated ${manifest.tracks.length} tracks (${activeTracks.length} active)\n`,
  );
}

async function loadManifest(): Promise<ReleaseTrackManifest> {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as ReleaseTrackManifest;
}

function findPrefixOverlap(left: string[], right: string[]): string[] {
  const overlaps: string[] = [];
  for (const lhs of left) {
    for (const rhs of right) {
      if (lhs.startsWith(rhs) || rhs.startsWith(lhs)) {
        overlaps.push(`${lhs}<->${rhs}`);
      }
    }
  }
  return overlaps;
}

function readChangedPaths(): string[] {
  const value = process.env.CHANGED_PATHS;
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => (typeof entry === "string" ? toPosix(entry) : ""))
        .filter((entry) => entry.length > 0);
    }
  } catch {
    // Fallback: comma-separated list.
  }
  return value
    .split(",")
    .map((entry) => toPosix(entry.trim()))
    .filter((entry) => entry.length > 0);
}

function assignChangedPaths(
  activeTracks: ReleaseTrack[],
  changedPaths: string[],
): Map<string, string[]> {
  const assignments = new Map<string, string[]>();
  for (const file of changedPaths) {
    const owners = activeTracks
      .filter((track) => track.file_prefixes.some((prefix) => matchesOwnedPath(file, prefix)))
      .map((track) => track.id);
    assignments.set(file, owners);
  }
  return assignments;
}

function matchesOwnedPath(file: string, prefix: string): boolean {
  const owned = normalizePrefix(prefix);
  if (owned.length === 0) {
    return false;
  }
  if (owned.endsWith("/")) {
    return file.startsWith(owned);
  }
  return file === owned || file.startsWith(`${owned}/`);
}

function normalizePrefix(prefix: string): string {
  const normalized = toPosix(prefix.trim());
  return normalized;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

void main().catch((error) => {
  process.stderr.write(
    `check-release-tracks failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
