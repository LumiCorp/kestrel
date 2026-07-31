import test from "node:test";
import assert from "node:assert/strict";
import { parseDesktopAuthorizationRequest } from "./desktop-account";

const challenge = "a".repeat(43);
const state = "b".repeat(32);

test(
  "Desktop account authorization requires PKCE S256 and an exact loopback callback",
  () => {
    const parsed = parseDesktopAuthorizationRequest(
      new URLSearchParams({
        response_type: "code",
        redirect_uri:
          "http://127.0.0.1:49152/oauth/callback/abcdefghijklmnopqrstuvwx",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }),
    );
    assert.equal(parsed.code_challenge_method, "S256");
    assert.throws(() =>
      parseDesktopAuthorizationRequest(
        new URLSearchParams({
          ...Object.fromEntries(
            new URLSearchParams({
              response_type: "code",
              code_challenge: challenge,
              code_challenge_method: "S256",
              state,
            }),
          ),
          redirect_uri:
            "https://attacker.example/oauth/callback/abcdefghijklmnopqrstuvwx",
        }),
      ),
    );
    assert.throws(() =>
      parseDesktopAuthorizationRequest(
        new URLSearchParams({
          response_type: "code",
          redirect_uri:
            "http://127.0.0.1:49152/oauth/callback/abcdefghijklmnopqrstuvwx",
          code_challenge: challenge,
          code_challenge_method: "plain",
          state,
        }),
      ),
    );
  },
);
