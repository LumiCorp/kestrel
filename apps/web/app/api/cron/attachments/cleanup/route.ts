import { cleanupExpiredDraftThreadAttachments } from "@/lib/attachments/store";
import { backfillLegacyThreadAttachments } from "@/lib/attachments/backfill";
import {
  authorizeEnvironmentReconcileCron,
  EnvironmentReconcileCronError,
} from "@/lib/environments/cron-contract";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    authorizeEnvironmentReconcileCron({
      authorization: request.headers.get("authorization"),
      expectedSecret: process.env.CRON_SECRET,
    });
    const deletedDraftAttachments = await cleanupExpiredDraftThreadAttachments();
    const legacyBackfill = await backfillLegacyThreadAttachments(100);
    console.info("[attachments.cleanup] completed", { deletedDraftAttachments, legacyBackfill });
    return Response.json({ ok: true, deletedDraftAttachments, legacyBackfill }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof EnvironmentReconcileCronError) {
      return Response.json({ ok: false, error: { code: error.code } }, {
        status: error.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    console.error("[attachments.cleanup] failed", error);
    return Response.json({ ok: false, error: { code: "ATTACHMENT_CLEANUP_FAILED" } }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
