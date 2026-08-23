import { runTurnAttachmentDeploymentCanary } from "../../../src/runtime/attachments/deploymentCanaryRunner.ts";

const result = await runTurnAttachmentDeploymentCanary({
  appUrl: process.env.KESTREL_ONE_APP_URL ?? "",
  privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
});
process.stdout.write(`${JSON.stringify(result)}\n`);
