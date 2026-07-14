import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  authorizeGatewayCredentialBroker,
  GATEWAY_CREDENTIAL_LEASE_VERSION,
  GatewayCredentialLeaseError,
  issueGatewayCredentialLease,
} from "@/lib/ai/gateway-credential-lease";

const requestSchema = z.object({
  version: z.literal(GATEWAY_CREDENTIAL_LEASE_VERSION),
  gatewayId: z.string().trim().min(1),
  organizationId: z.string().trim().min(1),
  environmentId: z.string().trim().min(1),
  rawModelId: z.string().trim().min(1),
});

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export async function POST(request: NextRequest) {
  try {
    authorizeGatewayCredentialBroker({
      authorization: request.headers.get("authorization"),
      expectedToken: process.env.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN,
    });
    const input = requestSchema.parse(await request.json());
    const lease = await issueGatewayCredentialLease(input);
    return NextResponse.json(lease, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof GatewayCredentialLeaseError) {
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status: error.status, headers: NO_STORE_HEADERS }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          code: "GATEWAY_CREDENTIAL_LEASE_REQUEST_INVALID",
          error: "Gateway credential lease request is invalid.",
        },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    return NextResponse.json(
      {
        code: "GATEWAY_CREDENTIAL_LEASE_FAILED",
        error: "Gateway credential lease could not be issued.",
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
