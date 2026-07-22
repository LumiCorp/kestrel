from __future__ import annotations

import hashlib
import json
import os
import uuid
from typing import Mapping

try:
    from .provider_config import (
        BENCHMARK_MODEL_PROVIDER,
        assert_benchmark_profile_mode,
        assert_benchmark_provider_env,
        assert_benchmark_turn_mode,
        benchmark_guardrails,
        benchmark_profile_mode,
        benchmark_turn_mode,
        resolve_benchmark_provider_config,
    )
except ImportError:
    from provider_config import (  # type: ignore[no-redef]
        BENCHMARK_MODEL_PROVIDER,
        assert_benchmark_profile_mode,
        assert_benchmark_provider_env,
        assert_benchmark_turn_mode,
        benchmark_guardrails,
        benchmark_profile_mode,
        benchmark_turn_mode,
        resolve_benchmark_provider_config,
    )


TERMINAL_BENCH_ENTRY_STEP_AGENT = "agent.loop"
TERMINAL_BENCH_PROFILE_ID = "terminal-bench-kestrel"
TERMINAL_BENCH_SESSION_PREFIX = "terminal-bench-kestrel"
TERMINAL_BENCH_REQUIRED_PROFILE_TOOLS = [
    "FinalizeAnswer",
    "effect_result_lookup",
    "fs.list",
    "fs.read_text",
    "fs.write_text",
    "fs.replace_text",
    "fs.search_text",
    "fs.mkdir",
    "exec_command",
]


def build_terminal_bench_profile() -> dict:
    profile_path = os.environ.get("KESTREL_BENCHMARK_PROFILE_FILE", "").strip()
    profile_id = os.environ.get("KESTREL_BENCHMARK_PROFILE_ID", "").strip()
    if profile_path:
        if not profile_id:
            raise AssertionError("KESTREL_BENCHMARK_PROFILE_ID is required with KESTREL_BENCHMARK_PROFILE_FILE.")
        with open(profile_path, encoding="utf-8") as profile_file:
            payload = json.load(profile_file)
        profiles = payload.get("profiles") if isinstance(payload, dict) else None
        candidates = profiles if isinstance(profiles, list) else [payload]
        selected = next((profile for profile in candidates if isinstance(profile, dict) and profile.get("id") == profile_id), None)
        if selected is None:
            raise AssertionError(f"Benchmark profile '{profile_id}' was not found in {profile_path}.")
        return dict(selected)
    assert_benchmark_provider_env()
    config = resolve_benchmark_provider_config()
    return {
        "id": TERMINAL_BENCH_PROFILE_ID,
        "label": "Terminal-Bench Kestrel",
        "agent": "reference-react",
        "sessionPrefix": TERMINAL_BENCH_SESSION_PREFIX,
        "modelProvider": config.model_provider,
        "model": config.model,
        "agentStageConfig": {
            "modelByStage": terminal_bench_model_by_stage(config.model),
        },
        "storeDriver": "sqlite",
        "approvalPolicyPackId": "dev",
        "modeSystemV2Enabled": True,
        **benchmark_profile_mode(),
        "toolAllowlist": list(TERMINAL_BENCH_REQUIRED_PROFILE_TOOLS),
        "mcpServers": [],
        "devShell": {"enabled": True, "envMode": "inherit", "maxReadBytes": 131072},
        "toolQueue": {
            "perRunConcurrency": 2,
            "globalConcurrency": 4,
            "maxQueuedJobsPerRun": 20,
            "checkpointSize": 5,
            "retryCount": 1,
        },
        "guardrails": benchmark_guardrails(),
    }


def build_terminal_bench_job_input(
    instruction: str,
    task_id: str,
    external_deadline_ms: int | None = None,
    runtime_deadline_ms: int | None = None,
    workspace_root: str = "/app",
    required_artifacts: list[str] | None = None,
) -> dict:
    metadata_deadline_ms = runtime_deadline_ms if runtime_deadline_ms is not None else external_deadline_ms
    normalized_required_artifacts = normalize_required_artifacts(required_artifacts or [])
    job_input = {
        "version": "job_input_v1",
        "storeDriver": "sqlite",
        "approvalPolicyPackId": "dev",
        "profile": build_terminal_bench_profile(),
        "turn": {
            "sessionId": f"tbench-kestrel-{task_id}-{uuid.uuid4().hex[:8]}",
            "message": instruction.rstrip(),
            "eventType": "job.run",
            "stepAgent": TERMINAL_BENCH_ENTRY_STEP_AGENT,
            **benchmark_turn_mode(),
            "metadata": {
                **(
                    {"externalDeadlineMs": metadata_deadline_ms}
                    if metadata_deadline_ms is not None
                        else {}
                ),
                "benchmark": {
                    "name": "terminal-bench",
                    "taskId": task_id,
                    "context": {
                        "source": "terminal-bench",
                        "taskId": task_id,
                        "workspaceRoot": workspace_root,
                        **(
                            {"requiredArtifacts": normalized_required_artifacts}
                            if normalized_required_artifacts
                            else {}
                        ),
                    },
                },
                "workspace": {
                    "workspaceId": "terminal-bench",
                    "workspaceRoot": workspace_root,
                    "label": "Terminal-Bench task container",
                    "managedWorktreeRequired": False,
                    "memoryBootstrap": "",
                    "memoryFiles": [],
                    "planDocumentSync": False,
                },
            },
        },
    }
    assert_terminal_bench_job_input_contract(job_input)
    return job_input


def normalize_required_artifacts(values: list[str]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        if isinstance(value, str) and value.strip():
            normalized.append(value.strip())
    return list(dict.fromkeys(normalized))


def assert_terminal_bench_job_input_contract(job_input: Mapping[str, object]) -> None:
    if job_input.get("version") != "job_input_v1":
        raise AssertionError("Terminal-Bench job input must use job_input_v1.")

    profile = job_input.get("profile")
    if not isinstance(profile, Mapping):
        raise AssertionError("Terminal-Bench job input must include a profile.")
    assert_benchmark_profile_mode(profile, "Terminal-Bench profile")
    if profile.get("agent") != "reference-react":
        raise AssertionError("Terminal-Bench profile must use reference-react.")
    if profile.get("modelProvider") != BENCHMARK_MODEL_PROVIDER:
        raise AssertionError("Terminal-Bench profile must use OpenRouter.")
    if profile.get("devShell") != {"enabled": True, "envMode": "inherit", "maxReadBytes": 131072}:
        raise AssertionError("Terminal-Bench profile must enable inherited dev shell.")
    if profile.get("toolAllowlist") != TERMINAL_BENCH_REQUIRED_PROFILE_TOOLS:
        raise AssertionError("Terminal-Bench profile tool allowlist drifted.")
    if profile.get("guardrails") != benchmark_guardrails():
        raise AssertionError("Terminal-Bench profile guardrails drifted.")

    turn = job_input.get("turn")
    if not isinstance(turn, Mapping):
        raise AssertionError("Terminal-Bench job input must include a turn.")
    assert_benchmark_turn_mode(turn, "Terminal-Bench turn")
    if turn.get("eventType") != "job.run":
        raise AssertionError("Terminal-Bench turn must use job.run.")
    if turn.get("stepAgent") != TERMINAL_BENCH_ENTRY_STEP_AGENT:
        raise AssertionError("Terminal-Bench turn must start at agent.loop.")
    message = turn.get("message")
    if not isinstance(message, str):
        raise AssertionError("Terminal-Bench turn message must be the raw benchmark instruction string.")
    if "Kestrel Terminal-Bench execution contract" in message:
        raise AssertionError("Terminal-Bench Python adapter must not render Kestrel prompt text.")
    metadata = turn.get("metadata")
    if not isinstance(metadata, Mapping):
        raise AssertionError("Terminal-Bench turn must include metadata.")
    benchmark = metadata.get("benchmark")
    if not isinstance(benchmark, Mapping):
        raise AssertionError("Terminal-Bench turn metadata must include benchmark context.")
    if benchmark.get("name") != "terminal-bench":
        raise AssertionError("Terminal-Bench benchmark metadata name drifted.")
    context = benchmark.get("context")
    if not isinstance(context, Mapping):
        raise AssertionError("Terminal-Bench benchmark metadata must include structured context.")
    if context.get("source") != "terminal-bench":
        raise AssertionError("Terminal-Bench benchmark context source drifted.")
    if not isinstance(context.get("taskId"), str):
        raise AssertionError("Terminal-Bench benchmark context must include taskId.")
    workspace = metadata.get("workspace")
    if not isinstance(workspace, Mapping):
        raise AssertionError("Terminal-Bench turn metadata must include workspace.")
    if workspace.get("workspaceRoot") != "/app" and not isinstance(workspace.get("workspaceRoot"), str):
        raise AssertionError("Terminal-Bench workspaceRoot must be a string.")
    if context.get("workspaceRoot") != workspace.get("workspaceRoot"):
        raise AssertionError("Terminal-Bench benchmark workspaceRoot must match workspace metadata.")
    if workspace.get("managedWorktreeRequired") is not False:
        raise AssertionError("Terminal-Bench must not require a managed worktree.")


def terminal_bench_job_input_contract_hash(job_input: Mapping[str, object]) -> str:
    canonical = json.dumps(job_input, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def default_model_for_provider(provider: str) -> str:
    return resolve_benchmark_provider_config().model if provider == BENCHMARK_MODEL_PROVIDER else "z-ai/glm-5.2"


def default_decision_model_for_provider(provider: str) -> str:
    return default_model_for_provider(provider)


def terminal_bench_model_by_stage(base_model: str) -> dict[str, str]:
    return {"agent.loop": base_model}


def react_model_stages() -> list[str]:
    return [
        "agent.loop",
    ]
