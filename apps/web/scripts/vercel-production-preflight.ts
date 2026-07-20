import { loadKestrelBuildIdentity } from "../lib/deployment/build-identity";

if (process.env.VERCEL_ENV === "production") {
  const identity = loadKestrelBuildIdentity();
  process.stdout.write(
    `Kestrel One build identity passed: ${identity.version} ${identity.revision} (${identity.source}).\n`
  );
  await import("./hosted-environment-preflight");
} else {
  process.stdout.write(
    "Skipping hosted Environment cutover preflight outside Vercel production.\n"
  );
}

export {};
