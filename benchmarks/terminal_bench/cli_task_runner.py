from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, TextIO

from container_devshell_bridge import ContainerDevShellBridge

try:
    from .job_input import (
        TERMINAL_BENCH_ENTRY_STEP_AGENT,
        build_terminal_bench_job_input,
        build_terminal_bench_profile,
        default_decision_model_for_provider,
        default_model_for_provider,
        react_model_stages,
        terminal_bench_job_input_contract_hash,
        terminal_bench_model_by_stage,
    )
    from .provider_config import (
        benchmark_provider_artifact_payload,
        benchmark_provider_issues,
    )
except ImportError:
    from job_input import (  # type: ignore[no-redef]
        TERMINAL_BENCH_ENTRY_STEP_AGENT,
        build_terminal_bench_job_input,
        build_terminal_bench_profile,
        default_decision_model_for_provider,
        default_model_for_provider,
        react_model_stages,
        terminal_bench_job_input_contract_hash,
        terminal_bench_model_by_stage,
    )
    from provider_config import (  # type: ignore[no-redef]
        benchmark_provider_artifact_payload,
        benchmark_provider_issues,
    )


DEFAULT_DEADLINE_RESERVE_SEC = 30.0
DEFAULT_RESULT_ADAPTER = "kestrel-terminal-bench"
DEFAULT_RESULT_DATASET = "terminal-bench-core==0.1.1"
COMPLETION_PACKET_START = "COMPLETION_ATTEMPT_PACKET_START"
COMPLETION_PACKET_END = "COMPLETION_ATTEMPT_PACKET_END"
RUNTIME_ERROR_FAILURE_KIND = {
    "MODEL_RATE_LIMITED": "provider_rate_limited",
    "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED": "runtime_external_deadline_exhausted",
}
TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND = "terminal_bench_protected_path_misuse"
MODEL_CONTRACT_CANNOT_SATISFY_FAILURE_KIND = "model_contract_cannot_satisfy"
TERMINAL_BENCH_PROTECTED_PATH_DENIAL_MARKER = "Terminal-Bench protected path is not available to agent shell commands"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instruction-base64", required=True)
    parser.add_argument("--task-id", default=os.environ.get("TB_TASK_ID", "unknown"))
    parser.add_argument("--required-artifact", action="append", default=[])
    args = parser.parse_args()
    instruction = base64.b64decode(args.instruction_base64).decode("utf-8")
    started_at = time.monotonic()
    workspace_root = resolve_workspace_root()
    home = Path(tempfile.mkdtemp(prefix="kestrel-tbench-cli-home-"))
    job_in = home / "job-input.json"
    job_out = home / "job-output.json"
    replay_bundle = home / "runtime-replay-bundle.json"
    event_log = Path("/installed-agent/kestrel-cli-events.jsonl")
    bridge_log = Path("/installed-agent/kestrel-cli-bridge.jsonl")
    task_id = args.task_id
    provider_issues = benchmark_provider_issues()
    if provider_issues:
        emit_result(
            {
                "adapter": result_adapter(),
                "dataset": result_dataset(),
                "task_id": task_id,
                "status": "failed",
                "duration_ms": round((time.monotonic() - started_at) * 1000),
                "failure_kind": "benchmark_setup_failed",
                "notes": " ".join(provider_issues),
                **benchmark_provider_artifact_payload(),
            }
        )
        return 2
    bridge = ContainerDevShellBridge(workspace_root, log_path=str(bridge_log))
    emit_progress("starting dev-shell bridge")
    bridge.start()
    emit_progress(f"dev-shell bridge ready at {bridge.url}")

    external_deadline_ms = read_external_deadline_ms()
    runtime_deadline_ms = effective_runtime_deadline_ms(external_deadline_ms)
    job_input = build_job_input(
        instruction,
        task_id,
        external_deadline_ms=external_deadline_ms,
        runtime_deadline_ms=runtime_deadline_ms,
        workspace_root=workspace_root,
        required_artifacts=normalize_required_artifacts(args.required_artifact),
    )
    job_input_hash = terminal_bench_job_input_contract_hash(job_input)
    job_in.write_text(json.dumps(job_input, indent=2) + "\n", encoding="utf-8")
    write_debug_job_input(job_input)
    env = {
        **os.environ,
        "KESTREL_HOME": str(home),
        "KESTREL_STORE_DRIVER": "sqlite",
        "KESTREL_SQLITE_PATH": str(home / "runtime.db"),
        "KESTREL_DEV_SHELL_BRIDGE_URL": bridge.url,
        "KESTREL_JOB_EVENT_LOG_PATH": str(event_log),
        "KESTREL_TBENCH_BRIDGE_LOG_PATH": str(bridge_log),
    }
    try:
        emit_progress(f"launching Kestrel runtime; event log: {event_log}; bridge log: {bridge_log}")
        completed = subprocess.run(
            build_kestrel_job_command(job_in, job_out),
            cwd=workspace_root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=effective_runtime_timeout_sec(external_deadline_ms),
        )
        runtime_status = "completed" if completed.returncode == 0 else "failed"
        emit_progress(f"Kestrel runtime exited with status {runtime_status} and code {completed.returncode}")
        write_debug_job_output(job_out)
        notes = completed.stdout[-2000:]
        payload = runtime_identity_payload(job_out, event_log)
        export_runtime_replay_bundle(payload.get("kestrel_run_id"), replay_bundle, env)
        failure_details = failure_details_payload(
            job_out,
            event_log,
            bridge_log,
            completed.stdout,
            required_artifacts=normalize_required_artifacts(args.required_artifact),
        )
        status, failure_kind = result_status_and_failure_kind(completed.returncode, failure_details)
        result = {
            "adapter": result_adapter(),
            "dataset": result_dataset(),
            "task_id": task_id,
            "status": status,
            "duration_ms": round((time.monotonic() - started_at) * 1000),
            "failure_kind": failure_kind,
            "notes": notes,
            "job_input_path": str(job_in),
            "job_output_path": str(job_out),
            "event_log_path": str(event_log),
            "bridge_log_path": str(bridge_log),
            "job_input_sha256": job_input_hash,
            **({"runtime_replay_bundle_path": str(replay_bundle)} if replay_bundle.exists() else {}),
            **benchmark_provider_artifact_payload(),
            **payload,
        }
        if failure_details:
            result["failure_details"] = failure_details
        emit_result(result)
        return completed.returncode
    except subprocess.TimeoutExpired as error:
        emit_progress("Kestrel runtime timed out")
        write_debug_job_output(job_out)
        payload = runtime_identity_payload(job_out, event_log)
        failure_details = failure_details_payload(
            job_out,
            event_log,
            bridge_log,
            str(error),
            required_artifacts=normalize_required_artifacts(args.required_artifact),
        )
        failure_kind = classify_cli_failure_kind(failure_details)
        emit_result(
            {
                "adapter": result_adapter(),
                "dataset": result_dataset(),
                "task_id": task_id,
                "status": "timeout",
                "duration_ms": round((time.monotonic() - started_at) * 1000),
                "failure_kind": failure_kind if failure_kind != "none" else "timeout",
                "notes": str(error),
                "job_input_path": str(job_in),
                "job_output_path": str(job_out),
                "event_log_path": str(event_log),
                "bridge_log_path": str(bridge_log),
                "job_input_sha256": job_input_hash,
                **benchmark_provider_artifact_payload(),
                **payload,
                **({"failure_details": failure_details} if failure_details else {}),
            }
        )
        return 124
    finally:
        bridge.close()


def result_adapter() -> str:
    return os.environ.get("KESTREL_TBENCH_RESULT_ADAPTER") or DEFAULT_RESULT_ADAPTER


def build_kestrel_job_command(job_input_path: Path, job_output_path: Path) -> list[str]:
    return [
        "node",
        "/opt/kestrel/bin/kestrel.js",
        "job",
        "run",
        "--json-in",
        str(job_input_path),
        "--json-out",
        str(job_output_path),
    ]


def result_dataset() -> str:
    return os.environ.get("KESTREL_TBENCH_RESULT_DATASET") or DEFAULT_RESULT_DATASET


def resolve_workspace_root() -> str:
    configured = os.environ.get("KESTREL_TBENCH_WORKSPACE_ROOT")
    if configured and Path(configured).is_dir():
        return configured
    if Path("/app").is_dir():
        return "/app"
    cwd = Path.cwd()
    if cwd.is_dir() and str(cwd) != "/":
        return str(cwd)
    return "/app"


def build_job_input(
    instruction: str,
    task_id: str,
    external_deadline_ms: int | None = None,
    runtime_deadline_ms: int | None = None,
    workspace_root: str = "/app",
    required_artifacts: list[str] | None = None,
) -> dict:
    return build_terminal_bench_job_input(
        instruction,
        task_id,
        external_deadline_ms=external_deadline_ms,
        runtime_deadline_ms=runtime_deadline_ms,
        workspace_root=workspace_root,
        required_artifacts=required_artifacts,
    )


def normalize_required_artifacts(values: list[str]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        stripped = value.strip()
        if stripped:
            normalized.append(stripped)
    return list(dict.fromkeys(normalized))


def write_debug_job_input(job_input: dict[str, Any]) -> None:
    try:
        Path("/installed-agent/kestrel-cli-job-input.json").write_text(
            json.dumps(job_input, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError:
        return


def write_debug_job_output(
    job_output_path: Path,
    destination: Path = Path("/installed-agent/kestrel-cli-job-output.json"),
) -> None:
    try:
        if job_output_path.exists():
            destination.write_text(job_output_path.read_text(encoding="utf-8"), encoding="utf-8")
    except OSError:
        return


def export_runtime_replay_bundle(run_id: object, destination: Path, env: dict[str, str]) -> None:
    if not isinstance(run_id, str) or not run_id:
        return
    try:
        subprocess.run(
            [
                "node",
                "/opt/kestrel/bin/kestrel.js",
                "runtime",
                "bundle",
                "--run-id",
                run_id,
                "--out",
                str(destination),
            ],
            cwd="/opt/kestrel",
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return


def read_external_deadline_ms() -> int | None:
    raw = os.environ.get("KESTREL_EXTERNAL_DEADLINE_MS")
    if raw:
        try:
            parsed = int(raw)
            return parsed if parsed > 0 else None
        except ValueError:
            return None
    timeout_raw = os.environ.get("KESTREL_TBENCH_AGENT_TIMEOUT_SEC")
    if not timeout_raw:
        return None
    try:
        timeout_sec = float(timeout_raw)
    except ValueError:
        return None
    return round((time.time() + max(1.0, timeout_sec)) * 1000)


def effective_runtime_timeout_sec(external_deadline_ms: int | None) -> float:
    configured = float(os.environ.get("KESTREL_TBENCH_RUN_TIMEOUT_SEC", "7200"))
    if external_deadline_ms is None:
        return configured
    reserve = float(os.environ.get("KESTREL_TBENCH_DEADLINE_RESERVE_SEC", str(DEFAULT_DEADLINE_RESERVE_SEC)))
    remaining = (external_deadline_ms / 1000.0) - time.time() - reserve
    return max(1.0, min(configured, remaining))


def effective_runtime_deadline_ms(external_deadline_ms: int | None) -> int | None:
    if external_deadline_ms is None:
        return None
    reserve = float(os.environ.get("KESTREL_TBENCH_DEADLINE_RESERVE_SEC", str(DEFAULT_DEADLINE_RESERVE_SEC)))
    deadline_sec = max(time.time() + 1.0, (external_deadline_ms / 1000.0) - reserve)
    return round(deadline_sec * 1000)


def build_profile() -> dict:
    return build_terminal_bench_profile()


def parse_job_output(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    job = raw.get("job", {})
    return compact_identity_payload({
        "kestrel_session_id": job.get("sessionId"),
        "kestrel_thread_id": job.get("threadId"),
        "kestrel_run_id": job.get("runId"),
    })


def runtime_identity_payload(job_output_path: Path, event_log_path: Path) -> dict:
    payload = parse_job_output(job_output_path) if job_output_path.exists() else {}
    if {"kestrel_session_id", "kestrel_run_id"}.issubset(payload.keys()):
        return payload
    return {
        **parse_event_log_identity(event_log_path),
        **payload,
    }


def failure_details_payload(
    job_output_path: Path,
    event_log_path: Path,
    bridge_log_path: Path,
    stdout: str,
    filesystem_root: Path = Path("/"),
    required_artifacts: list[str] | None = None,
) -> dict[str, Any]:
    details: dict[str, Any] = {}
    runtime_error = parse_job_error(job_output_path) or parse_event_log_error(event_log_path)
    if runtime_error:
        details["runtime_error"] = runtime_error

    runtime_terminal_status = parse_job_terminal_status(job_output_path) or parse_event_log_terminal_status(event_log_path)
    if runtime_terminal_status:
        details["runtime_terminal_status"] = runtime_terminal_status

    benchmark_contract_failure = parse_benchmark_contract_failure(event_log_path, bridge_log_path)
    if benchmark_contract_failure:
        details["benchmark_contract_failure"] = benchmark_contract_failure

    protected_path_denial = parse_protected_path_denial_observation(event_log_path, bridge_log_path)
    if protected_path_denial:
        details["protected_path_denial_observed_in_output"] = protected_path_denial

    process_failure = latest_process_failure(stdout, bridge_log_path)
    if process_failure:
        details["process_failure"] = process_failure

    completion_attempt = last_completion_attempt_packet(stdout, bridge_log_path)
    if completion_attempt:
        details["completion_attempt"] = completion_attempt
        missing_paths = missing_required_output_paths(completion_attempt, filesystem_root=filesystem_root)
        if missing_paths:
            details["missing_required_output_paths"] = missing_paths
    process_traffic = bridge_process_traffic(bridge_log_path)
    if process_traffic:
        details["interactive_process_traffic"] = process_traffic
    attempt_summary = required_artifact_attempt_summary(
        required_artifacts or [],
        event_log_path=event_log_path,
        bridge_log_path=bridge_log_path,
        filesystem_root=filesystem_root,
    )
    if attempt_summary:
        details["attempt_summary"] = attempt_summary
    return details


def classify_cli_failure_kind(failure_details: dict[str, Any]) -> str:
    benchmark_contract_failure = failure_details.get("benchmark_contract_failure")
    if isinstance(benchmark_contract_failure, dict):
        kind = benchmark_contract_failure.get("kind")
        if kind in {TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND, MODEL_CONTRACT_CANNOT_SATISFY_FAILURE_KIND}:
            return str(kind)

    runtime_error = failure_details.get("runtime_error")
    if isinstance(runtime_error, dict):
        code = runtime_error.get("code")
        if isinstance(code, str) and code in RUNTIME_ERROR_FAILURE_KIND:
            return RUNTIME_ERROR_FAILURE_KIND[code]

    runtime_terminal_status = failure_details.get("runtime_terminal_status")
    if isinstance(runtime_terminal_status, dict):
        status = runtime_terminal_status.get("status")
        if status == "WAITING":
            return "runtime_waiting_for_user"

    missing_paths = failure_details.get("missing_required_output_paths")
    if isinstance(missing_paths, list) and missing_paths:
        return "task_producer_failed"

    attempt_summary = failure_details.get("attempt_summary")
    if isinstance(attempt_summary, dict):
        present = attempt_summary.get("required_artifacts_present")
        if isinstance(present, dict) and any(value is False for value in present.values()):
            return "task_producer_failed"

    completion_attempt = failure_details.get("completion_attempt")
    if isinstance(completion_attempt, dict):
        producer_status = completion_attempt.get("producer_status")
        if isinstance(producer_status, str) and producer_status.lower() not in {"success", "completed", "passed"}:
            return "task_producer_failed"
        blockers = completion_attempt.get("blockers")
        if isinstance(blockers, list) and blockers:
            return "task_producer_failed"
        exact_mismatches = completion_attempt.get("exact_mismatches")
        if isinstance(exact_mismatches, list) and exact_mismatches:
            return "task_producer_failed"
    return "none"


def result_status_and_failure_kind(return_code: int, failure_details: dict[str, Any]) -> tuple[str, str]:
    runtime_status = "completed" if return_code == 0 else "failed"
    failure_kind = classify_cli_failure_kind(failure_details)
    if failure_kind == "none" and runtime_status != "completed":
        failure_kind = "kestrel_run_failed"
    status = "failed" if failure_kind != "none" else runtime_status
    return status, failure_kind


def parse_job_error(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    job = raw.get("job") if isinstance(raw.get("job"), dict) else {}
    error = job.get("error") if isinstance(job.get("error"), dict) else {}
    return compact_error_payload(error)


def parse_job_terminal_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    job = raw.get("job") if isinstance(raw.get("job"), dict) else {}
    status = job.get("status")
    if not isinstance(status, str) or not status:
        return {}
    payload: dict[str, Any] = {"status": status}
    wait_for = job.get("waitFor") if isinstance(job.get("waitFor"), dict) else {}
    wait_event_type = wait_for.get("eventType")
    if isinstance(wait_event_type, str) and wait_event_type:
        payload["wait_event_type"] = wait_event_type
    wait_metadata = wait_for.get("metadata") if isinstance(wait_for.get("metadata"), dict) else {}
    wait_reason = wait_metadata.get("reason")
    if isinstance(wait_reason, str) and wait_reason:
        payload["wait_reason"] = wait_reason
    return payload


def parse_event_log_error(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    latest: dict[str, Any] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
        error = output.get("error") if isinstance(output.get("error"), dict) else payload.get("error")
        if isinstance(error, dict):
            latest = compact_error_payload(error) or latest
            continue

        entry = payload.get("entry") if isinstance(payload.get("entry"), dict) else {}
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        if entry.get("eventName") == "run_failed":
            latest = compact_error_payload(metadata) or latest
    return latest


def parse_event_log_terminal_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    latest: dict[str, Any] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        update = payload.get("update") if isinstance(payload.get("update"), dict) else {}
        if update.get("code") == "WAITING_FOR_EVENT":
            wait_for = update.get("waitFor") if isinstance(update.get("waitFor"), dict) else {}
            event_type = wait_for.get("eventType")
            latest = {
                "status": "WAITING",
                **({"waitForEventType": event_type} if isinstance(event_type, str) else {}),
            }
            continue
        entry = payload.get("entry") if isinstance(payload.get("entry"), dict) else {}
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        if entry.get("eventName") == "run_terminal":
            status = metadata.get("status")
            if isinstance(status, str) and status:
                latest = {
                    "status": status,
                    **(
                        {"finalStep": metadata.get("finalStep")}
                        if isinstance(metadata.get("finalStep"), str)
                        else {}
                    ),
                }
    return latest


def parse_benchmark_contract_failure(event_log_path: Path, bridge_log_path: Path) -> dict[str, Any]:
    event_failure = parse_event_log_benchmark_contract_failure(event_log_path)
    if event_failure:
        return event_failure
    return parse_bridge_log_benchmark_contract_failure(bridge_log_path)


def parse_event_log_benchmark_contract_failure(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event_contains_terminal_bench_protected_path_misuse(record):
            return {
                "kind": TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND,
                "source": "event_log",
            }
        if event_contains_cannot_satisfy(record):
            return {
                "kind": MODEL_CONTRACT_CANNOT_SATISFY_FAILURE_KIND,
                "source": "event_log",
            }
    return {}


def parse_bridge_log_benchmark_contract_failure(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        body = record.get("body") if isinstance(record.get("body"), dict) else {}
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if action_mentions_protected_path(body) or blocked_protected_path_in_output(payload):
            return {
                "kind": TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND,
                "source": "bridge_log",
            }
    return {}


def parse_protected_path_denial_observation(event_log_path: Path, bridge_log_path: Path) -> dict[str, Any]:
    event_observation = parse_event_log_protected_path_denial_observation(event_log_path)
    if event_observation:
        return event_observation
    return parse_bridge_log_protected_path_denial_observation(bridge_log_path)


def parse_event_log_protected_path_denial_observation(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event_contains_protected_path_denial_in_output(record):
            return {
                "kind": "protected_path_denial_observed_in_output",
                "source": "event_log",
            }
    return {}


def parse_bridge_log_protected_path_denial_observation(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if protected_denial_in_output(payload):
            return {
                "kind": "protected_path_denial_observed_in_output",
                "source": "bridge_log",
            }
    return {}


def event_contains_terminal_bench_protected_path_misuse(event: dict[str, Any]) -> bool:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    update = payload.get("update") if isinstance(payload.get("update"), dict) else {}
    if tool_payload_mentions_protected_path(update):
        return True

    output = update.get("output") if isinstance(update.get("output"), dict) else {}
    audit = output.get("auditRecord") if isinstance(output.get("auditRecord"), dict) else {}
    if tool_payload_mentions_protected_path(audit):
        return True

    entry = payload.get("entry") if isinstance(payload.get("entry"), dict) else {}
    metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
    for key in ("next", "previous"):
        state = metadata.get(key) if isinstance(metadata.get(key), dict) else {}
        action = state.get("nextAction") if isinstance(state.get("nextAction"), dict) else {}
        if action_mentions_protected_path(action):
            return True
    latest_evidence = metadata.get("latestEvidence") if isinstance(metadata.get("latestEvidence"), dict) else {}
    summary = latest_evidence.get("summary")
    return isinstance(summary, str) and TERMINAL_BENCH_PROTECTED_PATH_DENIAL_MARKER in summary


def event_contains_protected_path_denial_in_output(event: dict[str, Any]) -> bool:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    update = payload.get("update") if isinstance(payload.get("update"), dict) else {}
    if protected_denial_in_output(update.get("output")):
        return True

    output = update.get("output") if isinstance(update.get("output"), dict) else {}
    audit = output.get("auditRecord") if isinstance(output.get("auditRecord"), dict) else {}
    if protected_denial_in_output(audit.get("output")):
        return True

    entry = payload.get("entry") if isinstance(payload.get("entry"), dict) else {}
    metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
    latest_evidence = metadata.get("latestEvidence") if isinstance(metadata.get("latestEvidence"), dict) else {}
    summary = latest_evidence.get("summary")
    return isinstance(summary, str) and "/protected" in summary and "Permission denied" in summary


def event_contains_cannot_satisfy(event: dict[str, Any]) -> bool:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    update = payload.get("update") if isinstance(payload.get("update"), dict) else {}
    if update.get("toolName") == "FinalizeAnswer" and contains_cannot_satisfy_marker(update.get("input")):
        return True

    output = update.get("output") if isinstance(update.get("output"), dict) else {}
    audit = output.get("auditRecord") if isinstance(output.get("auditRecord"), dict) else {}
    if contains_cannot_satisfy_marker(audit.get("input")):
        return True

    entry = payload.get("entry") if isinstance(payload.get("entry"), dict) else {}
    metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
    if metadata.get("decisionCode") == "cannot_satisfy":
        return True
    for key in ("next", "previous"):
        state = metadata.get(key) if isinstance(metadata.get(key), dict) else {}
        action = state.get("nextAction") if isinstance(state.get("nextAction"), dict) else {}
        if action.get("kind") == "cannot_satisfy":
            return True
    return contains_cannot_satisfy_marker(metadata.get("cannotSatisfy"))


def tool_payload_mentions_protected_path(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    tool_name = value.get("toolName")
    input_value = value.get("input")
    output_value = value.get("output")
    return (
        (isinstance(tool_name, str) and tool_name and action_mentions_protected_path(input_value))
        or blocked_protected_path_in_output(output_value)
    )


def action_mentions_protected_path(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    for key in ("command", "path", "sourcePath", "destinationPath", "cwd", "workspaceRoot"):
        candidate = value.get(key)
        if isinstance(candidate, str) and "/protected" in candidate:
            return True
    return False


def blocked_protected_path_in_output(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("securityMode") == "blocked_protected_path":
        return True
    for key in ("output", "result", "payload"):
        if blocked_protected_path_in_output(value.get(key)):
            return True
    return False


def protected_denial_in_output(value: object) -> bool:
    if isinstance(value, str):
        return TERMINAL_BENCH_PROTECTED_PATH_DENIAL_MARKER in value or (
            "/protected" in value and "Permission denied" in value
        )
    if isinstance(value, dict):
        for key in ("text", "stdout", "stderr", "failureReason", "message"):
            if protected_denial_in_output(value.get(key)):
                return True
        return protected_denial_in_output(value.get("output"))
    return False


def contains_cannot_satisfy_marker(value: object) -> bool:
    if isinstance(value, dict):
        if "cannotSatisfy" in value:
            return True
        if value.get("kind") == "cannot_satisfy" or value.get("reasonCode") == "unsatisfied_by_available_tools":
            return True
        return any(contains_cannot_satisfy_marker(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_cannot_satisfy_marker(item) for item in value)
    return False


def compact_error_payload(error: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    code = error.get("code")
    message = error.get("message")
    details = error.get("details")
    if isinstance(code, str) and code:
        payload["code"] = code
    if isinstance(message, str) and message:
        payload["message"] = message
    if isinstance(details, dict):
        payload["details"] = details
    return payload


def last_completion_attempt_packet(stdout: str, bridge_log_path: Path) -> dict[str, Any]:
    packets = completion_attempt_packets_from_text(stdout)
    packets.extend(completion_attempt_packets_from_bridge_log(bridge_log_path))
    return packets[-1] if packets else {}


def latest_process_failure(stdout: str, bridge_log_path: Path) -> dict[str, Any]:
    failures = process_failures_from_text(stdout)
    failures.extend(process_failures_from_bridge_log(bridge_log_path))
    return failures[-1] if failures else {}


def completion_attempt_packets_from_bridge_log(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    packets: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        for key in ("stdout", "text"):
            value = payload.get(key)
            if isinstance(value, str):
                packets.extend(completion_attempt_packets_from_text(value))
    return packets


def completion_attempt_packets_from_text(text: str) -> list[dict[str, Any]]:
    packets: list[dict[str, Any]] = []
    start = 0
    while True:
        start_index = text.find(COMPLETION_PACKET_START, start)
        if start_index < 0:
            return packets
        payload_start = start_index + len(COMPLETION_PACKET_START)
        end_index = text.find(COMPLETION_PACKET_END, payload_start)
        if end_index < 0:
            return packets
        raw_payload = text[payload_start:end_index].strip()
        start = end_index + len(COMPLETION_PACKET_END)
        try:
            parsed = json.loads(raw_payload)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            packets.append(parsed)


def process_failures_from_bridge_log(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    failures: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        failure = compact_process_failure(payload)
        if failure:
            failures.append(failure)
    return failures


def process_failures_from_text(text: str) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            failure = compact_process_failure(parsed)
            if failure:
                failures.append(failure)
    return failures


def compact_process_failure(payload: dict[str, Any]) -> dict[str, Any]:
    status = payload.get("status")
    exit_code = payload.get("exitCode")
    failure_reason = payload.get("failureReason")
    if status != "FAILED" and failure_reason is None:
        return {}
    result: dict[str, Any] = {}
    command = payload.get("command")
    if isinstance(command, str) and command:
        result["command"] = command
    if isinstance(status, str) and status:
        result["status"] = status
    if isinstance(exit_code, int):
        result["exit_code"] = exit_code
    if isinstance(failure_reason, str) and failure_reason:
        result["failure_reason"] = failure_reason
    for key in ("startedAt", "completedAt", "updatedAt"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            result[camel_to_snake(key)] = value
    return result


def bridge_process_traffic(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    processes: dict[str, dict[str, Any]] = {}
    order = 0

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        event = record.get("event")
        request_path = record.get("path")
        if event == "request" and isinstance(request_path, str):
            parts = request_path.strip("/").split("/")
            body = record.get("body") if isinstance(record.get("body"), dict) else {}
            process_id_from_body = body.get("processId")
            if len(parts) == 2 and parts[0] == "processes" and isinstance(process_id_from_body, str):
                process_id = process_id_from_body
                action = parts[1]
                process = traffic_process(processes, process_id, order)
                order += 1
                if action == "write":
                    process["write_count"] += 1
                    data = body.get("data", body.get("input"))
                    if isinstance(data, str) and data.startswith("move "):
                        process["movement_write_count"] += 1
                        if "&" in data:
                            process["batch_movement_write_count"] += 1
                        else:
                            process["single_step_movement_write_count"] += 1
                elif action == "read":
                    process["read_count"] += 1
            elif len(parts) == 3 and parts[0] == "processes":
                process_id = parts[1]
                action = parts[2]
                process = traffic_process(processes, process_id, order)
                order += 1
                if action == "write":
                    process["write_count"] += 1
                    data = body.get("data", body.get("input"))
                    if isinstance(data, str) and data.startswith("move "):
                        process["movement_write_count"] += 1
                        if "&" in data:
                            process["batch_movement_write_count"] += 1
                        else:
                            process["single_step_movement_write_count"] += 1
                elif action == "read":
                    process["read_count"] += 1

        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        process_id = payload.get("processId")
        if isinstance(process_id, str) and process_id:
            process = traffic_process(processes, process_id, order)
            order += 1
            for key in ("command", "startedAt", "completedAt", "updatedAt"):
                value = payload.get(key)
                if isinstance(value, str) and value and process.get(camel_to_snake(key)) is None:
                    process[camel_to_snake(key)] = value

    process_rows = [
        compact_process_traffic(process)
        for process in sorted(processes.values(), key=lambda item: item["first_seen"])
        if process.get("write_count", 0) > 0 or process.get("read_count", 0) > 0
    ]
    if not process_rows:
        return {}

    totals = {
        "process_count": len(process_rows),
        "write_count": sum_int(process_rows, "write_count"),
        "read_count": sum_int(process_rows, "read_count"),
        "movement_write_count": sum_int(process_rows, "movement_write_count"),
        "single_step_movement_write_count": sum_int(process_rows, "single_step_movement_write_count"),
        "batch_movement_write_count": sum_int(process_rows, "batch_movement_write_count"),
    }
    return {
        **totals,
        "processes": process_rows,
    }


def traffic_process(processes: dict[str, dict[str, Any]], process_id: str, order: int) -> dict[str, Any]:
    if process_id not in processes:
        processes[process_id] = {
            "process_id": process_id,
            "first_seen": order,
            "command": None,
            "started_at": None,
            "completed_at": None,
            "updated_at": None,
            "write_count": 0,
            "read_count": 0,
            "movement_write_count": 0,
            "single_step_movement_write_count": 0,
            "batch_movement_write_count": 0,
        }
    return processes[process_id]


def compact_process_traffic(process: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in process.items()
        if key != "first_seen" and value not in (None, 0)
    }


def sum_int(rows: list[dict[str, Any]], key: str) -> int:
    return sum(value for row in rows if isinstance((value := row.get(key)), int))


def camel_to_snake(value: str) -> str:
    return "".join(f"_{char.lower()}" if char.isupper() else char for char in value).lstrip("_")


def missing_required_output_paths(
    completion_attempt: dict[str, Any],
    filesystem_root: Path | None = None,
) -> list[str]:
    required = completion_attempt.get("required_output_paths")
    if not isinstance(required, list):
        return []
    if filesystem_root is not None:
        missing: list[str] = []
        for value in required:
            if not isinstance(value, str):
                continue
            path = filesystem_root / value.lstrip("/")
            try:
                exists = path.is_file()
            except OSError:
                exists = False
            if not exists:
                missing.append(value)
        return missing
    written = completion_attempt.get("artifacts_written")
    if not isinstance(written, list):
        return []
    written_paths = {value for value in written if isinstance(value, str)}
    return [value for value in required if isinstance(value, str) and value not in written_paths]


def required_artifact_attempt_summary(
    required_artifacts: list[str],
    event_log_path: Path,
    bridge_log_path: Path,
    filesystem_root: Path,
) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    if required_artifacts:
        present = required_artifact_presence(required_artifacts, filesystem_root)
        writes = required_artifact_writes(required_artifacts, event_log_path, bridge_log_path)
        summary["required_artifacts"] = required_artifacts
        summary["required_artifacts_present"] = present
        summary["required_artifact_writes"] = writes
    model_tool = last_model_tool(event_log_path)
    if model_tool:
        summary["last_model_tool"] = model_tool
    last_bridge_status = last_bridge_command_status(bridge_log_path)
    if last_bridge_status:
        summary["last_bridge_command_status"] = last_bridge_status
    return summary


def required_artifact_presence(required_artifacts: list[str], filesystem_root: Path) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for artifact in required_artifacts:
        path = filesystem_root / artifact.lstrip("/")
        try:
            result[artifact] = path.is_file()
        except OSError:
            result[artifact] = False
    return result


def required_artifact_writes(
    required_artifacts: list[str],
    event_log_path: Path,
    bridge_log_path: Path,
) -> list[dict[str, Any]]:
    required = expanded_required_artifact_paths(required_artifacts)
    writes: list[dict[str, Any]] = []
    writes.extend(required_artifact_writes_from_event_log(required, event_log_path))
    writes.extend(required_artifact_writes_from_bridge_log(required, bridge_log_path))
    return writes


def expanded_required_artifact_paths(required_artifacts: list[str]) -> set[str]:
    result: set[str] = set()
    for artifact in required_artifacts:
        result.add(artifact)
        stripped = artifact.lstrip("/")
        result.add(stripped)
        if stripped.startswith("app/"):
            result.add(stripped.removeprefix("app/"))
    return result


def required_artifact_writes_from_event_log(required: set[str], path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    writes: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        record = parse_json_line(line)
        if not record:
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        entry = payload.get("entry") if isinstance(payload.get("entry"), dict) else {}
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        for state_key in ("next", "previous"):
            state = metadata.get(state_key) if isinstance(metadata.get(state_key), dict) else {}
            action = state.get("nextAction") if isinstance(state.get("nextAction"), dict) else {}
            path_value = action.get("path")
            name = action.get("name")
            if isinstance(path_value, str) and path_value in required and isinstance(name, str):
                writes.append({
                    "source": "event_log",
                    "tool": name,
                    "path": path_value,
                    **({"step_index": entry.get("stepIndex")} if isinstance(entry.get("stepIndex"), int) else {}),
                })
    return dedupe_dicts(writes)


def required_artifact_writes_from_bridge_log(required: set[str], path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    writes: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        record = parse_json_line(line)
        if not record or record.get("event") != "response":
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        changed_files = payload.get("changedFiles")
        if not isinstance(changed_files, list):
            continue
        for changed in changed_files:
            if isinstance(changed, str) and changed in required:
                writes.append({
                    "source": "bridge_log",
                    "tool": "exec_command",
                    "path": changed,
                    **({"status": payload.get("status")} if isinstance(payload.get("status"), str) else {}),
                    **({"ts": record.get("ts")} if isinstance(record.get("ts"), str) else {}),
                })
    return dedupe_dicts(writes)


def last_model_tool(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    latest: dict[str, Any] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        record = parse_json_line(line)
        if not record:
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        entry = payload.get("entry") if isinstance(payload.get("entry"), dict) else {}
        if entry.get("eventName") not in {"decision_generated", "decision_executed"}:
            continue
        metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}
        tool_name = metadata.get("toolName")
        canonical_names = metadata.get("canonicalNames")
        if isinstance(tool_name, str):
            latest = {
                "tool": tool_name,
                **({"step_index": entry.get("stepIndex")} if isinstance(entry.get("stepIndex"), int) else {}),
            }
        elif isinstance(canonical_names, list):
            names = [name for name in canonical_names if isinstance(name, str)]
            if names:
                latest = {
                    "tools": names,
                    **({"step_index": entry.get("stepIndex")} if isinstance(entry.get("stepIndex"), int) else {}),
                }
    return latest


def last_bridge_command_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    latest: dict[str, Any] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        record = parse_json_line(line)
        if not record or record.get("event") != "response":
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        command = payload.get("command")
        status = payload.get("status")
        if isinstance(command, str) or isinstance(status, str):
            latest = {
                **({"status": status} if isinstance(status, str) else {}),
                **({"command": command[:300]} if isinstance(command, str) else {}),
                **({"changed_files": payload.get("changedFiles")} if isinstance(payload.get("changedFiles"), list) else {}),
                **({"ts": record.get("ts")} if isinstance(record.get("ts"), str) else {}),
            }
    return latest


def parse_json_line(line: str) -> dict[str, Any]:
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        return {}
    return record if isinstance(record, dict) else {}


def dedupe_dicts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for row in rows:
        key = json.dumps(row, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def parse_event_log_identity(path: Path) -> dict:
    if not path.exists():
        return {}
    session_ids: set[str] = set()
    thread_ids: set[str] = set()
    run_ids: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        collect_event_identity(record, session_ids, thread_ids, run_ids)
        payload = record.get("payload")
        if isinstance(payload, dict):
            collect_event_identity(payload, session_ids, thread_ids, run_ids)
            entry = payload.get("entry")
            if isinstance(entry, dict):
                collect_event_identity(entry, session_ids, thread_ids, run_ids)
            update = payload.get("update")
            if isinstance(update, dict):
                collect_event_identity(update, session_ids, thread_ids, run_ids)
    return compact_identity_payload(
        {
            "kestrel_session_id": single_value(session_ids),
            "kestrel_thread_id": single_value(thread_ids),
            "kestrel_run_id": single_value(run_ids),
        }
    )


def collect_event_identity(
    record: dict,
    session_ids: set[str],
    thread_ids: set[str],
    run_ids: set[str],
) -> None:
    add_string(session_ids, record.get("sessionId"))
    add_string(thread_ids, record.get("threadId"))
    add_string(run_ids, record.get("runId"))


def add_string(values: set[str], value: object) -> None:
    if isinstance(value, str) and value:
        values.add(value)


def single_value(values: set[str]) -> str | None:
    return next(iter(values)) if len(values) == 1 else None


def compact_identity_payload(payload: dict) -> dict:
    return {
        key: value
        for key, value in payload.items()
        if isinstance(value, str) and value
    }


def emit_result(result: dict) -> None:
    result_path = Path("/installed-agent/kestrel-cli-result.json")
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    encoded = base64.b64encode(json.dumps(result, sort_keys=True).encode("utf-8")).decode("ascii")
    print(f"KESTREL_TBENCH_RESULT_JSON_BASE64:{encoded}", flush=True)


def emit_progress(message: str, stdout: TextIO = sys.stdout) -> None:
    print(f"KESTREL_TBENCH_PROGRESS: {message}", file=stdout, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
