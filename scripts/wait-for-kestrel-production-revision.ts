const expectedRevision = process.argv[2]?.trim();
const publishUrl = process.env.KESTREL_RELEASE_PUBLISH_URL?.trim();

if (!expectedRevision?.match(/^[a-f0-9]{40}$/u)) {
  throw new Error("Expected a full production Git revision argument.");
}
if (!publishUrl) {
  throw new Error("KESTREL_RELEASE_PUBLISH_URL is required.");
}

const healthUrl = new URL("/api/health", new URL(publishUrl).origin);
const deadline = Date.now() + 15 * 60 * 1000;
let lastObserved = "unavailable";

while (Date.now() < deadline) {
  try {
    const response = await fetch(healthUrl, { cache: "no-store" });
    const body = (await response.json()) as {
      revision?: unknown;
      status?: unknown;
    };
    lastObserved =
      typeof body.revision === "string" ? body.revision : "missing";
    if (
      response.ok &&
      body.status === "healthy" &&
      body.revision === expectedRevision
    ) {
      process.stdout.write(
        `Kestrel One production is healthy at ${expectedRevision}.\n`,
      );
      process.exit(0);
    }
  } catch (error) {
    lastObserved = error instanceof Error ? error.message : "request failed";
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

throw new Error(
  `Kestrel One production did not reach ${expectedRevision}; last observed ${lastObserved}.`,
);
