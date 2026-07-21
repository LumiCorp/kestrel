import assert from "node:assert/strict";
import {
  assertUploadPathOwnedByUser,
  buildUploadPath,
  getUploadOwnerSegment,
} from "./upload-path";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const UPLOAD_FILENAME_PATTERN = /^Quarterly-Report-[a-f0-9]{8}\.pdf$/;
const FORBIDDEN_ERROR_PATTERN = /Forbidden/;

contractTest("web.hermetic", "buildUploadPath namespaces uploads under the sanitized user id", () => {
  const pathname = buildUploadPath({
    userId: "user:123",
    threadId: "chat/456",
    filename: "Quarterly Report.pdf",
  });

  assert.equal(pathname[0], getUploadOwnerSegment("user:123"));
  assert.equal(pathname[1], "chat-456");
  assert.match(pathname[2] ?? "", UPLOAD_FILENAME_PATTERN);
});

contractTest("web.hermetic", "assertUploadPathOwnedByUser rejects uploads owned by a different user", () => {
  assert.throws(
    () =>
      assertUploadPathOwnedByUser(
        ["other-user", "chat-456", "Quarterly-Report-deadbeef.pdf"],
        "user:123"
      ),
    FORBIDDEN_ERROR_PATTERN
  );
});
