import "server-only";

import { readHostedApprovalProof } from "@/lib/apps/hosted-approval-proof";

const threadId = argumentValue("--thread");
const interactionId = argumentValue("--interaction");
const proof = await readHostedApprovalProof({ threadId, interactionId });
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
if (!proof.ok) process.exitCode = 1;

function argumentValue(name: string) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) {
    throw new Error(`${name} <id> is required.`);
  }
  return args[index + 1]!;
}
