import {
  authorizeEnvironmentReconcileCron,
  EnvironmentReconcileCronError,
} from "@/lib/environments/cron-contract";
import { runScheduledEnvironmentReconciliation } from "@/lib/environments/reconcile-schedule";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export async function GET(request: Request) {
  try {
    authorizeEnvironmentReconcileCron({
      authorization: request.headers.get("authorization"),
      expectedSecret: process.env.CRON_SECRET,
    });
    const reconciliation = await runScheduledEnvironmentReconciliation();
    return Response.json(
      reconciliation.acquired
        ? { ok: true, acquired: true, result: reconciliation.result }
        : { ok: true, acquired: false, result: null },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof EnvironmentReconcileCronError) {
      return Response.json(
        { ok: false, error: { code: error.code } },
        { status: error.status, headers: NO_STORE_HEADERS }
      );
    }
    return Response.json(
      {
        ok: false,
        error: { code: "ENVIRONMENT_RECONCILE_CRON_FAILED" },
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
