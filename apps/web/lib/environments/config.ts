export function hostedEnvironmentsEnabled(
  env: Record<string, string | undefined> = process.env
) {
  return env.KESTREL_ENVIRONMENTS_ENABLED?.trim().toLowerCase() === "true";
}

export function requireHostedEnvironmentsEnabled(
  env: Record<string, string | undefined> = process.env
) {
  if (!hostedEnvironmentsEnabled(env)) {
    throw new Error(
      "Hosted Environments are not enabled for this Kestrel One deployment."
    );
  }
}
