import readline from "node:readline";

export class InputLoop {
  private readonly rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  private stopped = false;

  async start(onLine: (line: string) => Promise<void>): Promise<void> {
    this.rl.setPrompt("> ");

    let processing = false;
    const queue: string[] = [];

    const drain = async (): Promise<void> => {
      if (processing || this.stopped) {
        return;
      }

      processing = true;
      try {
        while (queue.length > 0 && this.stopped === false) {
          const line = queue.shift();
          if (line === undefined) {
            continue;
          }

          await onLine(line);
        }
      } finally {
        processing = false;
        if (this.stopped === false) {
          this.rl.prompt();
        }
      }
    };

    this.rl.on("line", async (line) => {
      if (this.stopped) {
        return;
      }

      queue.push(line);
      void drain();
    });

    this.rl.on("SIGINT", async () => {
      if (this.stopped) {
        return;
      }

      queue.push("/quit");
      void drain();
    });

    this.rl.prompt();

    await new Promise<void>((resolve) => {
      this.rl.on("close", () => {
        this.stopped = true;
        resolve();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.rl.close();
  }

  refreshPrompt(): void {
    if (this.stopped) {
      return;
    }

    this.rl.prompt();
  }
}
