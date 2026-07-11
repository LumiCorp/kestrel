import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KV_KEYS, kvGet, kvSet } from "@/lib/knowledge/kv";
import type { ShellExecutionResult } from "@/lib/knowledge/sandbox/types";
import { validateShellCommand } from "@/lib/knowledge/shell-policy";
import { getActiveKnowledgeSnapshot } from "@/lib/knowledge/snapshot-store";
import { snapshotExists } from "@/lib/knowledge/storage";

const execFileAsync = promisify(execFile);

type SandboxSessionState = {
  snapshotId: string;
  filesystemPath: string;
  createdAt: number;
};

async function resolveSnapshotSession(
  organizationId: string,
  preferredSessionId?: string
) {
  if (preferredSessionId) {
    const existing = await kvGet<SandboxSessionState>(
      KV_KEYS.session(preferredSessionId),
      organizationId
    );
    if (existing && (await snapshotExists(existing.filesystemPath))) {
      return {
        sessionId: preferredSessionId,
        state: existing,
      };
    }
  }

  const activeSnapshot = await getActiveKnowledgeSnapshot(organizationId);
  if (
    !(activeSnapshot && (await snapshotExists(activeSnapshot.filesystemPath)))
  ) {
    throw new Error("No active knowledge snapshot is available");
  }

  const sessionId = crypto.randomUUID();
  const state: SandboxSessionState = {
    snapshotId: activeSnapshot.id,
    filesystemPath: activeSnapshot.filesystemPath,
    createdAt: Date.now(),
  };

  await Promise.all([
    kvSet(KV_KEYS.session(sessionId), state, organizationId),
    kvSet(KV_KEYS.ACTIVE_SANDBOX_SESSION, sessionId, organizationId),
  ]);

  return {
    sessionId,
    state,
  };
}

export async function getOrCreateSessionId(
  organizationId: string,
  preferredSessionId?: string
): Promise<string> {
  const session = await resolveSnapshotSession(
    organizationId,
    preferredSessionId
  );
  return session.sessionId;
}

export async function runShellCommand(input: {
  organizationId: string;
  sessionId?: string;
  command: string;
}): Promise<ShellExecutionResult & { sessionId: string }> {
  const session = await resolveSnapshotSession(
    input.organizationId,
    input.sessionId
  );

  const validation = validateShellCommand(
    input.command,
    session.state.filesystemPath
  );
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "/bin/bash",
      ["-lc", input.command],
      {
        cwd: session.state.filesystemPath,
        maxBuffer: 1024 * 1024,
      }
    );
    return {
      sessionId: session.sessionId,
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      sessionId: session.sessionId,
      stdout: failure.stdout || "",
      stderr: failure.stderr || "",
      exitCode: failure.code ?? 1,
    };
  }
}
