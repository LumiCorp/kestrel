import { z } from "zod";

export const routeIdSchema = z.string().min(1).max(200);

export const uiMessagePartSchema = z
  .object({
    type: z.string().min(1).max(100),
  })
  .passthrough();

export const uiMessageSchema = z
  .object({
    id: z.string().min(1).max(200),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(uiMessagePartSchema).max(200),
  })
  .passthrough();
