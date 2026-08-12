import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workspace image includes and smokes common HTTP and process diagnostics", async () => {
  const dockerfile = await readFile(
    path.resolve(import.meta.dirname, "../Dockerfile"),
    "utf8",
  );
  assert.match(dockerfile, /apt-get install[^\n]*curl[^\n]*procps/u);
  assert.match(dockerfile, /curl --version/u);
  assert.match(dockerfile, /ps -ef/u);
});
