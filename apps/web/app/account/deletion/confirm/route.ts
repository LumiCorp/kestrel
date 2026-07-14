import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

function page(title: string, message: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui;margin:0;background:#10120f;color:#f2f3ec"><main style="max-width:620px;margin:12vh auto;padding:32px"><h1>${title}</h1><p style="line-height:1.6;color:#adb5a6">${message}</p></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token || token.length > 200) {
    return page(
      "Invalid confirmation link",
      "This account deletion confirmation link is invalid.",
      400
    );
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const [confirmed] = await knowledgeDb
    .update(schema.accountDeletionRequests)
    .set({ status: "confirmed", confirmedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.accountDeletionRequests.confirmationTokenHash, tokenHash),
        eq(schema.accountDeletionRequests.status, "requested"),
        gt(schema.accountDeletionRequests.expiresAt, now)
      )
    )
    .returning({ id: schema.accountDeletionRequests.id });
  if (!confirmed) {
    return page(
      "Confirmation link expired",
      "This link has expired or was already used. Return to Kestrel One Mobile to check your request or send a new one.",
      410
    );
  }
  return page(
    "Deletion request confirmed",
    "Your request is confirmed. Kestrel One will preserve organization-owned records as required, remove your account data through the hosted deletion process, and email you when it is complete."
  );
}
