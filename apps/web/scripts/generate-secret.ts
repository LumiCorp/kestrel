/**
 * Generate a secure random secret for Better Auth
 * Usage: pnpm generate-secret or tsx scripts/generate-secret.ts
 */
import { randomBytes } from "node:crypto";

function generateSecret() {
  // Generate 32 random bytes and encode as base64
  const secret = randomBytes(32).toString("base64");
  return secret;
}

const secret = generateSecret();

console.log("\n🔐 Better Auth Secret Generated:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(secret);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(
  "\n💡 Copy this value and use it as BETTER_AUTH_SECRET in your environment variables."
);
console.log(
  "   You can add it to .env.local for local development or in Vercel for deployment.\n"
);

process.exit(0);
