import { NextResponse } from "next/server";
import { listAdminUsers } from "@/lib/admin/users";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    await requireAdmin();
    const users = await listAdminUsers();
    return NextResponse.json(users);
  } catch (error) {
    return errorResponse(error);
  }
}
