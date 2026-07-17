import { createOciEgressBroker } from "./egress-broker.js";

const allowlist = JSON.parse(
  process.env.KESTREL_MCP_EGRESS_ALLOWLIST ?? "[]"
) as unknown;
if (!(Array.isArray(allowlist) && allowlist.every((entry) => typeof entry === "string"))) {
  throw new Error("KESTREL_MCP_EGRESS_ALLOWLIST must be a JSON string array.");
}
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port.");
}
createOciEgressBroker({ allowlist }).listen(port, "0.0.0.0");
