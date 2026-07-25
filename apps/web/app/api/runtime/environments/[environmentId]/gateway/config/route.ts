import { NextResponse } from "next/server";
import {
  EnvironmentGatewayConfigError,
  resolveEnvironmentGatewayConfig,
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
