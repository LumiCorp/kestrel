# ci-required Optimization Investigation

## Question

How can we optimize and improve the required GitHub Actions job named `ci-required` without weakening the local validation contract it is meant to enforce?

## Answer

The best near-term improvement is to remove duplicated validation work and overlap independent hermetic groups inside the repository-owned validator. As of August 13, 2026, the required workflow is already minimal at the GitHub Actions layer: checkout, shared setup, and `pnpm validate`. A recent successful run spent about 43 seconds in setup and 302 seconds in the local validation contract. The slow path is inside the repository-owned validation graph, especially sequential hermetic groups, not dependency installation.

Keep `ci-required` as the required full portable gate, publish the machine-readable validation report to the workflow summary and a short-lived artifact, remove type-analysis filters already covered by `build:shared`, and run hermetic groups with bounded group concurrency. Do not add path-based required skipping without explicit approval because that would be heuristic policy behavior.

## Findings

### Observed

- The checked-in workflow at `.github/workflows/ci.yml` runs on `pull_request` and `workflow_dispatch`, grants `contents: read`, cancels in-progress runs for the same workflow and ref, and has exactly one required job named `ci-required`.
- `ci-required` runs on `ubuntu-latest`, has a 15 minute timeout, checks out the repo, uses `./.github/actions/setup`, then runs `pnpm validate`.
- The shared setup action installs pnpm via `pnpm/action-setup@v4`, sets Node.js 22 with `actions/setup-node@v4` and `cache: pnpm`, installs ripgrep on Linux if missing, then runs `pnpm install --frozen-lockfile`.
- The repository root declares `packageManager: pnpm@9.12.2+sha512...`; the setup action no longer repeats an explicit pnpm version, so it avoids the older duplicate pnpm-version failure mode.
- Latest inspected successful run: GitHub Actions run `31705273439`, job `94464132594`, PR title `feat: make workspace backups non-blocking`, URL <https://github.com/LumiCorp/kestrel/actions/runs/31705273439>. The job started at `2026-08-13T13:30:44Z` and completed at `2026-08-13T13:36:36Z`.
- In that run, setup took about 43 seconds. The log showed a pnpm cache hit, Node setup plus cache restore took about 15.6 seconds, ripgrep install/availability took about 8.7 seconds, and `pnpm install --frozen-lockfile` took about 15.8 seconds.
- In that run, `pnpm validate` passed in 302.1 seconds. Preflight took 1.2 seconds, shared build and type analysis took 56.4 seconds, and hermetic validation took 244.5 seconds.
- The slowest hermetic groups in that run were runtime hermetic at 160.5 seconds, Web hermetic at 57.2 seconds, and desktop hermetic at 15.5 seconds.
- Static tracked-test inventory in this checkout found 822 tracked test files in the validation search roots, including 357 root unit tests, 299 `apps/web` tests, 70 `apps/desktop` tests, and 24 direct process-boundary candidates.
- `scripts/validate.mjs --plan` says full validation covers public boundary, shared build and type analysis, hermetic groups, focused manual boundaries for process/postgres/chromium/audit, observational durations, and the GitHub Actions job timeout.
- Full `pnpm validate` currently runs preflight, shared artifacts, root artifact, selected workspace type analysis, then hermetic tasks. It does not run the focused process, postgres, chromium, or audit leaves unless explicitly requested.
- Before this work, `scripts/validate.mjs` wrote detailed JSON timing and slow-task data to `test-results/validation/report.json`, but the workflow did not upload the report or append a summary to `GITHUB_STEP_SUMMARY`.
- GitHub's current dependency caching documentation says `setup-node` supports pnpm caching and that setup actions can create and restore dependency caches with minimal configuration. It also states that workflow runs can restore caches from the current branch and the default branch. Source: <https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching>.
- The `actions/setup-node` README states that its cache support covers pnpm and caches global package data, not `node_modules`. Source: <https://github.com/actions/setup-node/blob/main/README.md>.
- GitHub's workflow-command documentation states that content written to `GITHUB_STEP_SUMMARY` is shown on the workflow run summary page. Source: <https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions>.
- GitHub's concurrency documentation states that `cancel-in-progress: true` cancels currently running jobs or workflow runs in the same concurrency group. Source: <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency>.
- The `actions/upload-artifact` action supports a configurable `retention-days` input and exposes an artifact ID when upload succeeds. Source: <https://github.com/actions/upload-artifact>.

### Inferred

- Dependency caching is already working for the inspected run. More cache tuning may save seconds, but it is not the main optimization lever unless the install step becomes cold-cache dominated.
- The current 15 minute timeout has enough headroom for the inspected 5 minute validation run, but it leaves limited room for growth if hermetic tests continue expanding.
- The full required gate has a clear reliability value: it is the same `pnpm validate` contract named in `AGENTS.md` and used by local development. Splitting it into multiple required jobs would improve failure locality but would not automatically reduce wall-clock time unless the validation graph itself becomes parallel-safe across jobs.
- Path-based skipping could reduce work on docs-only or asset-only changes, but it would be a heuristic runtime policy choice. Under this repo's guardrails, that should be surfaced and approved before implementation.
- The missing workflow summary/artifact is the highest-confidence improvement because the data already exists and publishing it would not weaken validation semantics.

## Improvement Options

### 1. Publish Validation Report

Add an `always()` step after `pnpm validate` that reads `test-results/validation/report.json`, appends a concise Markdown table to `$GITHUB_STEP_SUMMARY`, and uploads the report as a short-lived artifact.

Expected value:

- Keeps `ci-required` behavior unchanged.
- Makes slow phases, slow tasks, and validation invariants visible without log scraping.
- Creates a baseline for future optimization PRs.

Risk:

- Low. The step should be non-blocking or should fail only on malformed report data if we want report integrity enforced.

### 2. Add Optional Fast Feedback Jobs

Add non-required jobs for preflight/build or focused hermetic subsets while keeping `ci-required` required.

Expected value:

- Developers see public-boundary, build, or workspace-specific failures earlier.
- Required merge semantics stay simple.

Risk:

- Moderate. More jobs can increase Actions minutes and noise. If optional jobs become interpreted as sufficient, they can dilute the meaning of the required gate.

### 3. Split Required Gate By Contract

Replace one required job with several required jobs, such as preflight/build, runtime hermetic, web hermetic, desktop hermetic, and package hermetic.

Expected value:

- Better failure locality.
- Potential wall-clock reduction if jobs run in parallel and setup duplication is acceptable.

Risk:

- Moderate to high. It duplicates setup per job, increases cache contention and Actions minutes, and requires preserving the exact contract currently centralized in `scripts/validate.mjs`.

### 4. Introduce Changed-Path Gating

Run narrower checks for changes that appear to affect only docs, assets, or isolated packages.

Expected value:

- Potentially large wall-clock savings for narrow PRs.

Risk:

- High without explicit policy approval. Path matching is a heuristic and can miss cross-boundary contracts, generated consumers, or root policy changes.

### 5. Optimize The Validation Graph Internally

Investigate whether runtime hermetic, Web hermetic, and desktop hermetic can safely run concurrently or be broken into deterministic shards while preserving replay and contract invariants.

Expected value:

- Targets the actual slow path.

Risk:

- Moderate. The current validator intentionally runs groups sequentially and bounds test concurrency to 4, which likely reflects prior resource and flake control work. Any change needs proof that it does not reintroduce the earlier concurrency instability.

## Implemented Direction

1. Publish validation-report data in `ci-required` using the existing `test-results/validation/report.json`.
2. Keep `build:shared` as the owner of shared package compilation and remove those same packages from the later no-emit workspace type-analysis pass.
3. Replace the 336-file root `runtime hermetic` catch-all with an explicit, versioned ownership manifest for `runtime-core`, `cli-command-mode`, `local-core-store`, `eval-replay`, and `provider-tool-contracts`.
4. Fail closed when a tracked root hermetic test is unassigned, duplicated, stale, assigned to an unknown lane, or moved to another validation boundary.
5. Run hermetic tasks through a weighted queue with a global worker budget of 12 and Node test concurrency 4 per task. The queue scans forward for runnable work and preserves fail-fast cancellation.
6. Expose `pnpm validate:lane <lane-id>` for focused iteration while preserving `pnpm validate`, `pnpm validate:hermetic`, and `pnpm test:unit` coverage.
7. Do not implement changed-path required gating unless the heuristic and its failure mode are explicitly approved.

Current local validation evidence after these changes:

- Web and the five root lanes now run through four deterministic shared-process shards per group. Desktop and the remaining workspace groups retain process-per-file isolation.
- All five focused lanes passed independently. The final standalone lane timings were runtime-core 14.0 seconds, CLI/command-mode 16.3 seconds, Local Core/store 25.3 seconds, eval/replay 4.0 seconds, and provider/tool contracts 13.4 seconds.
- Standalone Web validation passed all 267 files and 1,028 assertions in 5.6 seconds, down from the 44.3-second process-per-file baseline.
- The aggregate `pnpm validate:hermetic` acceptance run passed in 37.6 seconds, below the 82-second target and the prior 94.4-second baseline.
- The first full `pnpm validate` acceptance run passed in 61.3 seconds, down from 141.9 seconds. The final run on synchronized `origin/main` passed in 75.8 seconds with a 47.4-second hermetic phase, still below the acceptance ceiling under local contention.
- The required gate still runs preflight, shared artifacts, parallel root compilation and workspace type analysis, and every hermetic test. No test or path-based skip was introduced.

## Sources

- `.github/workflows/ci.yml`
- `.github/actions/setup/action.yml`
- `scripts/validate.mjs`
- `package.json`
- GitHub Actions run `31705273439`: <https://github.com/LumiCorp/kestrel/actions/runs/31705273439>
- GitHub Actions dependency caching reference: <https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching>
- `actions/setup-node` README: <https://github.com/actions/setup-node/blob/main/README.md>
- GitHub Actions workflow commands: <https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions>
- GitHub Actions concurrency docs: <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency>
- `actions/upload-artifact`: <https://github.com/actions/upload-artifact>
