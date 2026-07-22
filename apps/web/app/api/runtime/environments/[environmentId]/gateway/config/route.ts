import { NextResponse } from "next/server";
import {
  EnvironmentGatewayConfigError,
  resolveEnvironmentGatewayConfig,
  reportEnvironmentGatewayNgrokStatus,
} from "@/lib/environments/gateway-config";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ environmentId: string }> }
) {
  try {
    const { environmentId } = await context.params;
    return NextResponse.json(
      await resolveEnvironmentGatewayConfig({
        environmentId,
        authorization: request.headers.get("authorization"),
      }),
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof EnvironmentGatewayConfigError) {
      return NextResponse.json(
        { error: { code: error.code } },
        { status: error.status, headers: NO_STORE_HEADERS }
      );
    }
    return NextResponse.json(
      { error: { code: "ENVIRONMENT_GATEWAY_CONFIG_FAILED" } },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ environmentId: string }> }
) {
  try {
    const { environmentId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    if (
      typeof body.connectionId !== "string" ||
      (body.status !== "connected" && body.status !== "degraded") ||
      (body.failureCode !== undefined && typeof body.failureCode !== "string") ||
      (body.failureMessage !== undefined &&
        (typeof body.failureMessage !== "string" || body.failureMessage.length > 500))
    ) {
      return NextResponse.json({ error: { code: "ENVIRONMENT_NGROK_STATUS_INVALID" } }, { status: 400, headers: NO_STORE_HEADERS });
    }
    await reportEnvironmentGatewayNgrokStatus({
      environmentId,
      authorization: request.headers.get("authorization"),
      connectionId: body.connectionId,
      status: body.status,
      ...(typeof body.failureCode === "string" ? { failureCode: body.failureCode } : {}),
      ...(typeof body.failureMessage === "string" ? { failureMessage: body.failureMessage } : {}),
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof EnvironmentGatewayConfigError) {
      return NextResponse.json({ error: { code: error.code } }, { status: error.status, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({ error: { code: "ENVIRONMENT_NGROK_STATUS_FAILED" } }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
