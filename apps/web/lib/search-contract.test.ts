import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "search.ts"),
  "utf8"
);

contractTest("web.hermetic", "workspace search authorizes every result group before full-text matching", () => {
  assert.match(source, /from projects p[\s\S]*inner join project_members pm/);
  assert.match(
    source,
    /from threads t[\s\S]*created_by_user_id[\s\S]*project_members/
  );
  assert.match(
    source,
    /from thread_messages m[\s\S]*inner join threads t[\s\S]*project_members/
  );
  assert.equal(
    (source.match(/websearch_to_tsquery\('simple'/g) ?? []).length,
    6
  );
});

contractTest("web.hermetic", "workspace search preserves approved grouped ranking without cross-type heuristics", () => {
  assert.match(source, /order by rank desc, p\.updated_at desc, p\.id asc/);
  assert.match(source, /order by rank desc, t\.updated_at desc, t\.id asc/);
  assert.match(source, /order by rank desc, m\.created_at desc, m\.id asc/);
  assert.doesNotMatch(
    source,
    /similarity\(|levenshtein|score_threshold|boost/i
  );
});
