import assert from "node:assert/strict";
import { workspaceListenHost } from "../src/network.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("services.hermetic", "Workspace runtime binds dual-stack when Fly's private 6PN is present", () => {
  assert.equal(
    workspaceListenHost({
      flyPrivateIp: " fdaa:9a:e3e3:a7b:fb:94e3:11c:2 ",
    }),
    "::"
  );
});

contractTest("services.hermetic", "Workspace runtime keeps an explicit local host fallback", () => {
  assert.equal(
    workspaceListenHost({
      flyPrivateIp: "fdaa:9a:e3e3:a7b:fb:94e3:11c:2",
      configuredHost: "127.0.0.1",
    }),
    "127.0.0.1"
  );
  assert.equal(workspaceListenHost({}), "0.0.0.0");
});
