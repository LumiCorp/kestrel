import { assertWebProcessConfiguration } from "../lib/runtime/process-contracts";

assertWebProcessConfiguration();
process.stdout.write("Production Web configuration is valid.\n");
