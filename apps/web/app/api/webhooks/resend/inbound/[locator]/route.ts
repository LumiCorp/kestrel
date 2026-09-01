import { z } from "zod";
import { handleResendInboundWebhook } from "@/lib/email-receipts/ingress";

const paramsSchema = z.object({ locator: z.string().min(40).max(128) }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ locator: string }> },
) {
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return Response.json({ error: "Webhook unavailable." }, { status: 404 });
  }
  return handleResendInboundWebhook(request, params.data.locator);
}
