import { NextResponse } from "next/server";
import { createDesktopEnrollmentRequest } from "@/lib/environments/desktop";
import { errorResponse } from "@/lib/knowledge/http";

export async function POST(request: Request) {
  try {
    return NextResponse.json(
      await createDesktopEnrollmentRequest(await request.json()),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
