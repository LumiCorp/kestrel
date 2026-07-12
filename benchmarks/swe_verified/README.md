# SWE Verified Single-Instance Bench

This bench runs one SWE-bench Verified instance at a time through Kestrel and
then hands the generated patch to the official SWE-bench evaluator.

## Prerequisites

- Docker running for the official evaluator.
- `.venv-swebench` with the official `swebench` package installed.
- `datasets` available when loading instances from Hugging Face.
- Model provider keys exported for the Kestrel run.

The repo entrypoints default `KESTREL_SWE_PYTHON` to the dedicated repo-local
venv. If you invoke the underlying runner directly, it still falls back to
`python3`, so local SWE Verified runs should use:

```bash
python3.11 -m venv .venv-swebench
.venv-swebench/bin/python -m pip install --upgrade pip
git clone https://github.com/princeton-nlp/SWE-bench.git /private/tmp/SWE-bench
.venv-swebench/bin/python -m pip install -e /private/tmp/SWE-bench
export KESTREL_SWE_PYTHON=.venv-swebench/bin/python
```

If the environment already exists, only export the interpreter path:

```bash
export KESTREL_SWE_PYTHON=.venv-swebench/bin/python
```

Check local evaluator prerequisites:

```bash
pnpm run bench:swe -- preflight
```

## Run One Instance

Use the convenience helper for normal single-instance runs:

```bash
pnpm run swe astropy__astropy-12907
```

Each run writes a fresh attempt under:

```text
runs/swe-verified/kestrel-swe-<instance-id>/attempts/<attempt-id>/
```

Key artifacts:

- `job-input.json`: sanitized Kestrel job input.
- `job-output.json`: Kestrel runtime output.
- `kestrel-output.txt`: stdout/stderr from the runtime command.
- `model.patch`: validated patch reconstructed from the final `/testbed`
  filesystem against the read-only instance baseline.
- `workspace-baseline-report.json`: cryptographic commit/tree identity for the
  prepared image's initial `/testbed` snapshot, captured before the agent runs.
- `workspace-patch-report.json`: harvesting status, changed and excluded paths,
  stage results, patch SHA-256, target tree, validation result, and the Kestrel
  process exit code. This report, not the agent's Git state, authorizes evaluation.
- `predictions.jsonl`: official SWE-bench prediction row with
  `instance_id`, `model_name_or_path`, and `model_patch`.
- `evaluator-output.txt` and `evaluator-report.json`: raw and parsed official
  evaluator results when a validated non-empty patch is available.
- `../../latest.json`: metadata for the newest attempt, including the latest
  attempt id and artifact paths.

List recorded attempts for one instance:

```bash
pnpm run bench:swe -- list --instance-id astropy__astropy-12907
```

For offline prompt rendering or deterministic dry runs, provide a local JSONL
file containing SWE-bench rows:

```bash
pnpm run swe astropy__astropy-12907 \
  --instances-jsonl /path/to/verified.jsonl \
  --dry-run
```

The runner only forwards issue-facing fields into the Kestrel prompt:
`instance_id`, `repo`, `base_commit`, `problem_statement`, and optional
`hints_text`. It strips solution and verifier fields before prompt rendering.

## Evaluate One Existing Prediction

```bash
pnpm run bench:swe -- evaluate \
  --instance-id astropy__astropy-12907 \
  --predictions-path runs/swe-verified/kestrel-swe-astropy__astropy-12907/attempts/<attempt-id>/predictions.jsonl
```

The evaluator command is scoped with `--instance_ids <id>` and
`--max_workers 1` so each run is a single test bench attempt.
