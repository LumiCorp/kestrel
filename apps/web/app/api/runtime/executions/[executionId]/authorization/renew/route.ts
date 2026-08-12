import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ExecutionAuthorizationRenewalError,
  renewEnvironmentExecutionAuthorization,
} from "@/lib/environments/authorization-renewal";
import { routeIdSchema } from "@/lib/knowledge/validation";

const bodySchema = z.object({
  executionTicket: z.string().trim().min(1).max(32_000),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ executionId: string }> },
) {
  try {
    const { executionId } = await context.params;
    const id = routeIdSchema.parse(executionId);
    const token = request.headers.get("authorization")
      ?.match(/^Bearer ([^\s]+)$/u)?.[1];
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      throw new ExecutionAuthorizationRenewalError(
        "EXECUTION_AUTH_RENEWAL_DENIED",
        401,
      );
    }
    const body = bodySchema.parse(await request.json());
    return NextResponse.json(await renewEnvironmentExecutionAuthorization({
      executionId: id,
      renewalToken: token,
      executionTicket: body.executionTicket,
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ExecutionAuthorizationRenewalError) {
      const { executionId } = await context.params.catch(() => ({ executionId: "invalid" }));
      process.stdout.write(`${JSON.stringify({
        type: "environment.authorization.renewal_failed",
        executionId,
        outcome: error.code === "EXECUTION_AUTH_RENEWAL_DENIED"
          ? "denied"
          : "unavailable",
        occurredAt: new Date().toISOString(),
      })}\n`);
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    const { executionId } = await context.params.catch(() => ({ executionId: "invalid" }));
    process.stdout.write(`${JSON.stringify({
      type: "environment.authorization.renewal_failed",
      executionId,
      outcome: "unavailable",
      occurredAt: new Date().toISOString(),
    })}\n`);
    return NextResponse.json(
      { error: { code: "EXECUTION_AUTH_RENEWAL_UNAVAILABLE" } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
