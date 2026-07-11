import type { ParsedInput } from "../contracts.js";
import { buildTuiCommandHelp, parseUnknownCommandName } from "./TuiCommandInventory.js";

export type TuiCommandInput = Extract<ParsedInput, { kind: "command" }>;
export type TuiCommandName = TuiCommandInput["command"];
export type TuiCommandHandler = (args: string[], parsed: TuiCommandInput) => Promise<void>;

export type TuiCommandHandlers = Omit<Record<TuiCommandName, TuiCommandHandler>, "help">;

export interface TuiCommandRouterContext {
  appendHistoryLine(role: "system", text: string): Promise<void>;
  handlers: TuiCommandHandlers;
}

export class TuiCommandRouter {
  private readonly context: TuiCommandRouterContext;

  constructor(context: TuiCommandRouterContext) {
    this.context = context;
  }

  async handle(parsed: TuiCommandInput): Promise<void> {
    if (parsed.command === "help") {
      const unknown = parseUnknownCommandName(parsed.args);
      if (unknown !== undefined) {
        await this.context.appendHistoryLine("system", `Unknown command '/${unknown}'.`);
      }
      await this.context.appendHistoryLine("system", buildTuiCommandHelp());
      return;
    }

    await this.context.handlers[parsed.command](parsed.args, parsed);
  }
}
