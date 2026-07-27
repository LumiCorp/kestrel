import { NextResponse } from "next/server";
import {
  getDesktopAccountProjection,
  revokeDesktopUserCredentials,
} from "@/lib/desktop-account";

export async function GET(request: Request) {
  try {
    return NextResponse.json(await getDesktopAccountProjection(request), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}

export async function DELETE(request: Request) {
  await revokeDesktopUserCredentials(request).catch(() => undefined);
  return NextResponse.json({ signedOut: true });
}
