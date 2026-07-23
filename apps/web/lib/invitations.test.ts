import assert from "node:assert/strict";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import {
  invitationSignupError,
  type InvitationCandidate,
} from "./invitation-policy";

const now = new Date("2026-07-23T12:00:00.000Z");

function invitation(
  overrides: Partial<InvitationCandidate> = {},
): InvitationCandidate {
  return {
    id: "invite-1",
    email: "member@example.com",
    status: "pending",
    expiresAt: new Date("2026-07-24T12:00:00.000Z"),
    ...overrides,
  };
}

function signupError(
  record: InvitationCandidate | null,
  email = "member@example.com",
) {
  return invitationSignupError({
    invitationId: "invite-1",
    email,
    invitation: record,
    now,
  });
}

contractTest(
  "web.hermetic",
  "account creation requires a live invitation for the invited email",
  () => {
    assert.equal(signupError(invitation(), "MEMBER@example.com"), null);
    assert.ok(signupError(null));
    assert.ok(signupError(invitation({ status: "canceled" })));
    assert.ok(
      signupError(
        invitation({ expiresAt: new Date("2026-07-22T12:00:00.000Z") }),
      ),
    );
    assert.ok(signupError(invitation(), "other@example.com"));
  },
);
