from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

DATASET = "terminal-bench-core==0.1.1"

Adapter = Literal["kestrel-terminal-bench", "runtime", "cli", "harbor-cli", "codex-harbor-cli"]
Status = Literal["completed", "failed", "timeout"]
FailureKind = Literal[
    "none",
    "tb_verifier_failed",
    "artifact_passed_but_agent_failed",
    "kestrel_run_failed",
    "provider_rate_limited",
    "runtime_external_deadline_exhausted",
    "terminal_bench_bridge_fetch_failed",
    "terminal_bench_protected_path_misuse",
    "model_contract_cannot_satisfy",
    "task_producer_failed",
    "bridge_failed",
    "benchmark_setup_failed",
    "benchmark_setup_timeout",
    "cli_install_failed",
    "cli_command_failed",
    "timeout",
]


@dataclass
class BenchmarkResult:
    adapter: Adapter
    dataset: str
    task_id: str
    status: Status
    duration_ms: int
    failure_kind: FailureKind
    notes: str = ""
    kestrel_session_id: str | None = None
    kestrel_thread_id: str | None = None
    kestrel_run_id: str | None = None
    model_provider: str | None = None
    model: str | None = None
    credential_env: str | None = None
    credential_fingerprint: str | None = None
    job_input_path: str | None = None
    job_output_path: str | None = None
    event_log_path: str | None = None
    bridge_log_path: str | None = None
    job_input_sha256: str | None = None
    runtime_replay_bundle_path: str | None = None
    harness_revision: str | None = None
    failure_details: dict[str, Any] | None = None


def task_id_from_logging_dir(logging_dir: Path | None) -> str:
    if logging_dir is None:
        return "unknown"
    trial_dir = logging_dir.parent if logging_dir.name == "agent-logs" else logging_dir
    name = trial_dir.name.strip()
    if ".1-of-1." in name:
        name = name.split(".1-of-1.", 1)[0]
    return name or "unknown"


def monotonic_ms(started_at: float) -> int:
    return max(0, round((time.monotonic() - started_at) * 1000))


def normalize_status(success: bool, timed_out: bool = False) -> Status:
    if timed_out:
        return "timeout"
    return "completed" if success else "failed"


def failure_kind_for_exception(adapter: Adapter, error: BaseException) -> FailureKind:
    name = error.__class__.__name__.lower()
    message = str(error).lower()
    if "timeout" in name or "timeout" in message:
        return "timeout"
    if adapter == "runtime":
        if "bridge" in message or "dev shell" in message or "dev_shell" in message:
            return "bridge_failed"
        return "kestrel_run_failed"
    if "install" in message:
        return "cli_install_failed"
    return "cli_command_failed"


def result_path(logging_dir: Path | None, adapter: Adapter, task_id: str) -> Path:
    base = logging_dir if logging_dir is not None else Path(__file__).parent / "results"
    base.mkdir(parents=True, exist_ok=True)
    prefix = adapter if adapter.startswith("kestrel-") else f"kestrel-{adapter}"
    return base / f"{prefix}-{task_id}.json"


def write_result(result: BenchmarkResult, logging_dir: Path | None) -> Path:
    path = result_path(logging_dir, result.adapter, result.task_id)
    payload = {key: value for key, value in asdict(result).items() if value is not None}
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
