import assert from "node:assert/strict";
import { contractTest } from "../../../tests/helpers/contract-test.js";
import { KESTREL_APP_ORIGIN, resolveKestrelAppUrl } from "./app-url";

contractTest(
  "web.hermetic",
  "production auth URLs always use the canonical Kestrel domain",
  () => {
    assert.equal(
      resolveKestrelAppUrl({
        VERCEL: "1",
        VERCEL_ENV: "production",
        BETTER_AUTH_URL: "https://kestrel-one-green.vercel.app",
        NEXT_PUBLIC_APP_URL: "https://kestrel-one-green.vercel.app",
      }),
      KESTREL_APP_ORIGIN
    );
  }
);

contractTest(
  "web.hermetic",
  "preview and local auth URLs remain environment-driven",
  () => {
    assert.equal(
      resolveKestrelAppUrl({
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_URL: "preview-kestrel.vercel.app",
      }),
      "https://preview-kestrel.vercel.app"
    );
    assert.equal(
      resolveKestrelAppUrl({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:43103" }),
      "http://127.0.0.1:43103"
    );
  }
);
