import { NextResponse } from "next/server";
import { exchangeDesktopUserCredential } from "@/lib/desktop-account";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const credentials = await exchangeDesktopUserCredential(
      Object.fromEntries(form),
    );
    return NextResponse.json(credentials, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "invalid_grant" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
