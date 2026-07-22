import type { CreateEnvironmentAppConnectionInput } from "./contracts";

export async function validateVercelConnection(
  input: CreateEnvironmentAppConnectionInput
) {
  if (input.kind === "ngrok_agent") {
    throw new Error("Vercel requires an API-key credential.");
  }
  if (input.baseUrl) {
    throw new Error("Vercel connections use Vercel's managed API endpoint.");
  }
  const url = new URL("https://api.vercel.com/v9/projects");
  url.searchParams.set("limit", "1");
  if (input.projectId) url.searchParams.set("teamId", input.projectId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Vercel rejected this access token or Team ID."
        : "Vercel could not verify this connection."
    );
  }
  return { status: "connected" as const, checkedAt: new Date() };
}
