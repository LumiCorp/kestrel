import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { WorkspaceRequestError } from "./security.js";

type TerminalStatus = "running" | "exited" | "failed";

type TerminalSession = {
  id: string;
  process: ChildProcessWithoutNullStreams;
  chunks: Array<{ sequence: number; data: string }>;
  nextSequence: number;
  status: TerminalStatus;
  exitCode: number | null;
};

export class WorkspaceTerminalRegistry {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly childEnvironment: () => NodeJS.ProcessEnv = () => ({
      ...process.env,
    })
  ) {}

  get activeCount() {
    return [...this.sessions.values()].filter(
      (session) => session.status === "running"
    ).length;
  }

  create(cwd: string) {
    const id = randomUUID();
    const child = spawn("script", ["-qefc", "/bin/bash", "/dev/null"], {
      cwd,
      env: { ...this.childEnvironment(), TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: TerminalSession = {
      id,
      process: child,
      chunks: [],
      nextSequence: 0,
      status: "running",
      exitCode: null,
    };
    this.sessions.set(id, session);
    child.stdout.on("data", (chunk: Buffer) => this.append(session, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.append(session, chunk));
    child.once("error", (error) => {
      session.status = "failed";
      this.append(session, Buffer.from(`\r\n${error.message}\r\n`));
    });
    child.once("exit", (code) => {
      session.status = code === 0 ? "exited" : "failed";
      session.exitCode = code;
    });
    return { id, status: session.status };
  }

  write(id: string, input: string) {
    const session = this.require(id);
    if (session.status !== "running") {
      throw new WorkspaceRequestError(409, "TERMINAL_SESSION_NOT_RUNNING");
    }
    session.process.stdin.write(input);
  }

  read(id: string, cursor: number) {
    const session = this.require(id);
    return {
      output: session.chunks
        .filter((chunk) => chunk.sequence >= cursor)
        .map((chunk) => chunk.data)
        .join(""),
      cursor: session.nextSequence,
      status: session.status,
      exitCode: session.exitCode,
    };
  }

  close(id: string) {
    const session = this.require(id);
    if (session.status === "running") session.process.kill("SIGTERM");
    this.sessions.delete(id);
  }

  closeAll() {
    for (const session of this.sessions.values()) {
      if (session.status === "running") session.process.kill("SIGTERM");
    }
    this.sessions.clear();
  }

  private append(session: TerminalSession, chunk: Buffer) {
    session.chunks.push({
      sequence: session.nextSequence,
      data: chunk.toString("utf8"),
    });
    session.nextSequence += 1;
    if (session.chunks.length > 2000) session.chunks.shift();
  }

  private require(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new WorkspaceRequestError(404, "TERMINAL_SESSION_NOT_FOUND");
    }
    return session;
  }
}
