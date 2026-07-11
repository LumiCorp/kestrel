import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import {
  getOrCreateSessionId,
  runShellCommand,
} from "@/lib/knowledge/sandbox/manager";
import type { CommandResult } from "@/lib/knowledge/sandbox/types";

const bodySchema = z
  .object({
    command: z.string().min(1).max(2000).optional(),
    commands: z.array(z.string().min(1).max(2000)).max(10).optional(),
    sessionId: z.string().min(1).max(200).optional(),
  })
  .refine(
    (data) =>
      (data.command && !data.commands) || (!data.command && data.commands),
    { message: 'Provide either "command" or "commands", not both' }
  );

const MAX_OUTPUT = 50_000;

function truncateOutput(output: string): string {
  if (output.length > MAX_OUTPUT) {
    return `${output.slice(0, MAX_OUTPUT)}\n... (truncated, ${output.length} total chars)`;
  }
  return output;
}

export async function POST(request: NextRequest) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const body = bodySchema.parse(await request.json());
    const commands = body.commands ?? (body.command ? [body.command] : []);
    const sessionId = await getOrCreateSessionId(
      organizationId,
      body.sessionId
    );

    const results: CommandResult[] = [];

    for (const command of commands) {
      const startedAt = Date.now();
      const result = await runShellCommand({
        organizationId,
        sessionId,
        command,
      });
      results.push({
        command,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr),
        exitCode: result.exitCode,
        execMs: Date.now() - startedAt,
      });
    }

    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "sandbox",
      action: "shell",
      targetType: "sandbox_session",
      targetId: sessionId,
      message: `Ran ${commands.length} sandbox command(s).`,
      metadata: {
        commands,
        exitCodes: results.map((result) => result.exitCode),
      },
    });

    if (commands.length === 1) {
      const [single] = results;
      if (single) {
        return NextResponse.json({
          sessionId,
          stdout: single.stdout,
          stderr: single.stderr,
          exitCode: single.exitCode,
        });
      }
    }

    return NextResponse.json({
      sessionId,
      results: results.map((result) => ({
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      })),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
