if (process.env.VERCEL_ENV === "production") {
  await import("./hosted-environment-preflight");
} else {
  process.stdout.write(
    "Skipping hosted Environment cutover preflight outside Vercel production.\n"
  );
}

export {};
