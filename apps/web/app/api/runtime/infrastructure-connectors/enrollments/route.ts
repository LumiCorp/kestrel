import { NextResponse } from "next/server";
import { createKubernetesConnectorEnrollment } from "@/lib/environments/kubernetes-connector";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  try {
    return NextResponse.json(
      await createKubernetesConnectorEnrollment(await request.json()),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
