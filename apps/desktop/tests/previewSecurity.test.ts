import assert from "node:assert/strict";

import { isAllowedEmbeddedPreviewUrl } from "../src/previewSecurity.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "embedded preview permits only credential-free loopback http URLs", () => {
  for (const value of ["http://127.0.0.1:3000", "https://localhost:4443/path", "http://[::1]:8080/"])
    assert.equal(isAllowedEmbeddedPreviewUrl(value), true, value);
  for (const value of ["https://example.com", "file:///tmp/index.html", "javascript:alert(1)", "http://user:secret@localhost:3000", "http://0.0.0.0:3000"])
    assert.equal(isAllowedEmbeddedPreviewUrl(value), false, value);
});
