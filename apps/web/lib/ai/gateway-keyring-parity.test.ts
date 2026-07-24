import assert from "node:assert/strict";
import { contractTest } from "../../../../tests/helpers/contract-test.js";
import {
  assertGatewayKeyringParity,
  summarizeGatewayKeyring,
} from "./gateway-keyring-parity";

const source = summarizeGatewayKeyring({
  activeKeyId: "primary",
  keys: JSON.stringify({ primary: "a", previous: "b" }),
});

contractTest(
  "web.hermetic",
  "gateway keyring parity rejects missing, extra, and mismatched worker keys",
  () => {
    for (const worker of [
      summarizeGatewayKeyring({
        activeKeyId: "primary",
        keys: JSON.stringify({ primary: "a" }),
      }),
      summarizeGatewayKeyring({
        activeKeyId: "primary",
        keys: JSON.stringify({ primary: "a", previous: "b", next: "c" }),
      }),
      summarizeGatewayKeyring({
        activeKeyId: "previous",
        keys: JSON.stringify({ primary: "a", previous: "b" }),
      }),
    ]) {
      assert.throws(() =>
        assertGatewayKeyringParity({ canonical: source, worker }),
      );
    }
  },
);
