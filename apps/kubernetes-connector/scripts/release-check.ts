import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const chart = path.join(root, "deploy/kubernetes/kestrel-connector");
const resources = fs.readFileSync(path.join(chart, "templates/resources.yaml"), "utf8");
const helpers = fs.readFileSync(path.join(chart, "templates/_helpers.tpl"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "apps/kubernetes-connector/Dockerfile"), "utf8");

assert.match(helpers, /image\.digest is required and must be sha256-pinned/u);
assert.match(helpers, /\^sha256:\[a-f0-9\]\{64\}\$/u);
assert.doesNotMatch(resources, /verbs:\s*\[[^\]]*"\*"/u);
assert.match(resources, /replicas: \{\{ \.Values\.replicaCount \}\}/u);
assert.match(resources, /runAsNonRoot: true/u);
assert.match(resources, /automountServiceAccountToken: false/u);
assert.match(resources, /serviceAccountToken:/u);
assert.match(dockerfile, /USER 10001:10001/u);
process.stdout.write("Kubernetes connector release boundaries passed.\n");
