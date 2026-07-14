import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { withExpoOrigin } from "@/lib/mobile/native-auth-origin";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

export async function POST(request: Request) {
  return handlers.POST(await withExpoOrigin(request));
}
