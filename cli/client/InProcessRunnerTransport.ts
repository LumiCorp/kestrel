import { PassThrough } from "node:stream";
import readline, { type Interface as ReadLineInterface } from "node:readline";

import { CommandRouter } from "../runner/CommandRouter.js";
import { EventWriter } from "../runner/EventWriter.js";
import { RunnerHost } from "../runner/RunnerHost.js";
import type { ProtocolTransport } from "./ProtocolClient.js";

export class InProcessRunnerTransport implements ProtocolTransport {
  private readonly output = new PassThrough();
  private host: RunnerHost | undefined;
  private router: CommandRouter | undefined;
  private onExit: ((code: number | null) => void) | undefined;
  private outputReader: ReadLineInterface | undefined;
  private closed = false;

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void {
    if (this.host !== undefined) {
      return;
    }

    const writer = new EventWriter(this.output);
    this.host = new RunnerHost(writer);
    this.router = new CommandRouter(this.host, writer);
    this.onExit = handlers.onExit;

    this.outputReader = readline.createInterface({
      input: this.output,
      terminal: false,
    });
    this.outputReader.on("line", handlers.onLine);
  }

  send(line: string): void {
    if (this.router === undefined) {
      throw new Error("In-process transport is not started");
    }

    void this.router.acceptLine(line);
  }

  async stop(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.host !== undefined) {
      await this.host.close();
      this.host = undefined;
      this.router = undefined;
    }

    this.outputReader?.close();
    this.outputReader = undefined;
    this.output.end();
    const onExit = this.onExit;
    this.onExit = undefined;
    onExit?.(0);
  }
}
