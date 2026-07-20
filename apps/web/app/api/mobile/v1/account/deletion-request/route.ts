import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { deliverTransactionalEmail } from "@/lib/email/service";
import { requireSession } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { mobileErrorResponse } from "@/lib/mobile/http";

const requestSchema = z.object({ confirmation: z.literal("DELETE") });

export async function GET(incomingRequest: Request) {
  try {
    const session = await requireSession(incomingRequest);
    const request = await knowledgeDb.query.accountDeletionRequests.findFirst({
      where: eq(schema.accountDeletionRequests.userId, session.user.id),
      orderBy: desc(schema.accountDeletionRequests.createdAt),
      columns: {
        id: true,
        status: true,
        createdAt: true,
        confirmedAt: true,
        completedAt: true,
      },
    });
    return NextResponse.json({
      request: request
        ? {
            ...request,
            createdAt: request.createdAt.toISOString(),
            confirmedAt: request.confirmedAt?.toISOString() ?? null,
            completedAt: request.completedAt?.toISOString() ?? null,
          }
        : null,
    });
  } catch (error) {
    return mobileErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    requestSchema.parse(await request.json());
    const existing = await knowledgeDb.query.accountDeletionRequests.findFirst({
      where: and(
        eq(schema.accountDeletionRequests.userId, session.user.id),
        inArray(schema.accountDeletionRequests.status, [
          "confirmed",
          "processing",
        ])
      ),
      orderBy: desc(schema.accountDeletionRequests.createdAt),
    });
    if (existing) {
      return NextResponse.json({
        requestId: existing.id,
        status: existing.status,
      });
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const id = crypto.randomUUID();
    await knowledgeDb.transaction(async (tx) => {
      await tx
        .update(schema.accountDeletionRequests)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(schema.accountDeletionRequests.userId, session.user.id),
            eq(schema.accountDeletionRequests.status, "requested")
          )
        );
      await tx.insert(schema.accountDeletionRequests).values({
        id,
        userId: session.user.id,
        email: session.user.email,
        confirmationTokenHash: tokenHash,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
    });
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.BETTER_AUTH_URL ??
      "http://localhost:43103";
    const confirmUrl = `${baseUrl.replace(/\/$/, "")}/account/deletion/confirm?token=${encodeURIComponent(token)}`;
    await deliverTransactionalEmail({
      kind: "account_deletion_confirmation",
      to: session.user.email,
      subject: "Confirm deletion of your Kestrel One account",
      html: `<p>Confirm your Kestrel One account deletion request:</p><p><a href="${confirmUrl}">Confirm account deletion</a></p><p>This link expires in one hour. If you did not make this request, you can ignore this email.</p>`,
      developmentContent: confirmUrl,
      idempotencyKey: `account-deletion-${id}`,
    });
    return NextResponse.json(
      { requestId: id, status: "requested" },
      { status: 202 }
    );
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
