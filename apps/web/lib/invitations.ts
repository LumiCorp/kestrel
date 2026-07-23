import "server-only";

import { APIError } from "better-auth/api";
import { dbClient } from "@/lib/db-client";
import { INVITATION_SIGNUP_HEADER } from "./invitation-shared";
import {
  invitationSignupError,
  type InvitationCandidate,
} from "./invitation-policy";

export const INVITATION_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

async function findInvitation(id: string): Promise<InvitationCandidate | null> {
  return (await dbClient
    .selectFrom("invitation")
    .select(["id", "email", "status", "expiresAt"])
    .where("id", "=", id)
    .executeTakeFirst()) as InvitationCandidate | null;
}

export async function assertInvitationSignup(input: {
  invitationId: string | null;
  email: unknown;
  now?: Date;
  findInvitation?: (id: string) => Promise<InvitationCandidate | null>;
}) {
  const invitation = input.invitationId
    ? await (input.findInvitation ?? findInvitation)(input.invitationId)
    : null;
  const now = input.now ?? new Date();
  const error = invitationSignupError({
    invitationId: input.invitationId,
    email: input.email,
    invitation,
    now,
  });
  if (error) {
    throw new APIError("BAD_REQUEST", {
      message: error,
    });
  }
}

export async function assertInvitationSignupFromHeaders(input: {
  headers: Headers | undefined;
  email: unknown;
}) {
  await assertInvitationSignup({
    invitationId: input.headers?.get(INVITATION_SIGNUP_HEADER) ?? null,
    email: input.email,
  });
}
