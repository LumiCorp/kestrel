import { runCliCommand } from "./dist/cli/commandMode.js";

await runCliCommand(["web", ...process.argv.slice(2)], process.cwd());
