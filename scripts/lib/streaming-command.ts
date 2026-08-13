import { spawn } from "node:child_process";

export const STREAMING_COMMAND_STDERR_TAIL_BYTES = 64 * 1024;

type WritableTarget = Pick<NodeJS.WritableStream, "write">;

export class StreamingCommandError extends Error {
  readonly code: number | string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(input: {
    command: string;
    cause?: Error;
    code: number | string | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }) {
    const outcome = input.signal
      ? `signal ${input.signal}`
      : `exit code ${String(input.exitCode ?? input.code ?? "unknown")}`;
    super(`${input.command} failed with ${outcome}.`, {
      cause: input.cause,
    });
    this.name = "StreamingCommandError";
    this.code = input.code;
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.stderr = input.stderr;
  }
}

export async function runStreamingCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdout?: WritableTarget;
    stderr?: WritableTarget;
    captureStdout?: boolean;
  },
) {
  return new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const stdoutChunks: Buffer<ArrayBufferLike>[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.captureStdout) {
        stdoutChunks.push(chunk);
      } else {
        (options.stdout ?? process.stdout).write(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      (options.stderr ?? process.stderr).write(chunk);
      stderrTail = appendBoundedTail(stderrTail, chunk);
    });
    child.once("error", (cause: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(
        new StreamingCommandError({
          command,
          cause,
          code: cause.code ?? null,
          exitCode: null,
          signal: null,
          stderr: stderrTail.toString("utf8"),
        }),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (exitCode === 0) {
        resolve({
          stdout: options.captureStdout
            ? Buffer.concat(stdoutChunks).toString("utf8")
            : "",
        });
        return;
      }
      reject(
        new StreamingCommandError({
          command,
          code: exitCode,
          exitCode,
          signal,
          stderr: stderrTail.toString("utf8"),
        }),
      );
    });
  });
}

export async function captureStreamingCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stderr?: WritableTarget;
  },
) {
  const result = await runStreamingCommand(command, args, {
    ...options,
    captureStdout: true,
  });
  return result.stdout;
}

function appendBoundedTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
) {
  if (chunk.length >= STREAMING_COMMAND_STDERR_TAIL_BYTES) {
    return chunk.subarray(chunk.length - STREAMING_COMMAND_STDERR_TAIL_BYTES);
  }
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= STREAMING_COMMAND_STDERR_TAIL_BYTES
    ? combined
    : combined.subarray(combined.length - STREAMING_COMMAND_STDERR_TAIL_BYTES);
}
