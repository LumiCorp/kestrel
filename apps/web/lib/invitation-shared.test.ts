import assert from "node:assert/strict";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import {
  invitationIdFromCallbackURL,
  invitationPath,
  isInvitationCallbackURL,
} from "./invitation-shared";
import { invitationOrigin } from "./invitation-origin";

contractTest(
  "web.hermetic",
  "invitation callbacks stay scoped to a single invitation route",
  () => {
    assert.equal(invitationPath("invite 1"), "/accept-invitation/invite%201");
    assert.equal(
      invitationIdFromCallbackURL("/accept-invitation/invite%201"),
      "invite 1",
    );
    assert.equal(isInvitationCallbackURL("/dashboard"), false);
    assert.equal(isInvitationCallbackURL("/accept-invitation/id/other"), false);
    assert.equal(
      isInvitationCallbackURL("https://example.com/accept-invitation/id"),
      false,
    );
  },
);

contractTest(
  "web.hermetic",
  "invitation links use the canonical Better Auth origin",
  () => {
    assert.equal(
      invitationOrigin({
        BETTER_AUTH_URL: "https://kestrel.example.com/auth",
        NODE_ENV: "production",
      }),
      "https://kestrel.example.com",
    );
    assert.throws(() => invitationOrigin({ NODE_ENV: "production" }));
    assert.throws(() =>
      invitationOrigin({
        BETTER_AUTH_URL: "ftp://kestrel.example.com",
        NODE_ENV: "production",
      }),
    );
  },
);
