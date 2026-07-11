from __future__ import annotations

import base64
import json
import os
import re
import shlex
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Iterable

from terminal_bench.agents.base_agent import AgentResult
from terminal_bench.agents.failure_mode import FailureMode
from terminal_bench.agents.installed_agents.abstract_installed_agent import AbstractInstalledAgent
from terminal_bench.terminal.models import TerminalCommand
from terminal_bench.terminal.tmux_session import TmuxSession

from .provider_config import benchmark_provider_artifact_payload
from .results import (
    DATASET,
    BenchmarkResult,
    failure_kind_for_exception,
    monotonic_ms,
    task_id_from_logging_dir,
    write_result,
)

CLI_RESULT_RE = re.compile(r"KESTREL_TBENCH_RESULT_JSON_BASE64:(?P<payload>[A-Za-z0-9+/=]+)")
DEFAULT_DEADLINE_RESERVE_SEC = 30.0
TERMINAL_BENCH_RESULT_ADAPTER = "kestrel-terminal-bench"


class KestrelTerminalBenchAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "kestrel-terminal-bench"

    @property
    def _env(self) -> dict[str, str]:
        env: dict[str, str] = {}
        for key in (
            "OPENROUTER_API_KEY",
            "OPENROUTER_MODEL",
            "TAVILY_API_KEY",
            "KESTREL_BENCHMARK_MODEL_PROVIDER",
            "KESTREL_BENCHMARK_MODEL",
            "KESTREL_BENCHMARK_CREDENTIAL_ENV",
            "KESTREL_BENCHMARK_CREDENTIAL_FINGERPRINT",
            "KCHAT_MODEL_TIMEOUT_MS",
            "KCHAT_MODEL_RETRY_COUNT",
            "KESTREL_MODEL_PROMPT_DUMP",
            "KESTREL_TBENCH_CLI_COMMAND_TIMEOUT_SEC",
            "KESTREL_TBENCH_RUN_TIMEOUT_SEC",
            "KESTREL_TBENCH_DEADLINE_RESERVE_SEC",
        ):
            value = os.environ.get(key)
            if value:
                env[key] = value
        return env

    @property
    def _install_agent_script_path(self) -> Path:
        return Path(__file__).parent / "setup.sh"

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
        timeout_sec: float | None = None,
    ) -> AgentResult:
        started_at = time.monotonic()
        task_id = task_id_from_logging_dir(logging_dir)
        timeout_sec = resolve_agent_timeout_sec(task_id, timeout_sec)
        repo_root = resolve_repo_root()
        repo_tarball = create_repo_tarball(repo_root)
        try:
            session.copy_to_container(
                repo_tarball,
                container_dir="/installed-agent",
                container_filename="kestrel.tar.gz",
            )
            session.copy_to_container(
                [
                    Path(__file__).parent / "cli_task_runner.py",
                    Path(__file__).parent / "container_devshell_bridge.py",
                    Path(__file__).parent / "job_input.py",
                    Path(__file__).parent / "provider_config.py",
                    repo_root / "src" / "devshell" / "kestrel_devshell.py",
                ],
                container_dir="/installed-agent",
            )
            ensure_installed_agent_helpers_readable(session)
            install_result = self._install_agent(session, started_at, task_id, logging_dir)
            if install_result is not None:
                return install_result

            rendered_instruction = self._render_instruction(instruction)
            external_deadline_ms = compute_external_deadline_ms(started_at, timeout_sec)
            for command in self._run_agent_commands(rendered_instruction, task_id, timeout_sec, external_deadline_ms):
                session.send_command(command)

            captured = wait_for_cli_result_marker(
                session,
                timeout_sec=effective_wait_timeout_sec(started_at, timeout_sec),
                logging_dir=logging_dir,
                task_id=task_id,
            )
            event_log_path = copy_cli_event_log(session, logging_dir, task_id)
            bridge_log_path = copy_cli_bridge_log(session, logging_dir, task_id)
            parsed = parse_cli_result(captured)
            if parsed is None:
                write_result(
                    BenchmarkResult(
                        adapter=TERMINAL_BENCH_RESULT_ADAPTER,
                        dataset=DATASET,
                        task_id=task_id,
                        status="failed",
                        duration_ms=monotonic_ms(started_at),
                        failure_kind="kestrel_run_failed",
                        notes="CLI result marker was not emitted.",
                        **benchmark_provider_artifact_payload(),
                    ),
                    logging_dir,
                )
                return AgentResult(failure_mode=FailureMode.UNKNOWN_AGENT_ERROR)
            if event_log_path is not None:
                parsed["event_log_path"] = str(event_log_path)
            if bridge_log_path is not None:
                parsed["bridge_log_path"] = str(bridge_log_path)
            copy_cli_job_artifacts(session, logging_dir, task_id, parsed)
            write_result(
                BenchmarkResult(
                    adapter=parsed.get("adapter", TERMINAL_BENCH_RESULT_ADAPTER),
                    dataset=DATASET,
                    task_id=task_id,
                    status=parsed.get("status", "failed"),
                    duration_ms=int(parsed.get("duration_ms") or monotonic_ms(started_at)),
                    failure_kind=parsed.get("failure_kind", "kestrel_run_failed"),
                    notes=str(parsed.get("notes") or ""),
                    kestrel_session_id=parsed.get("kestrel_session_id"),
                    kestrel_thread_id=parsed.get("kestrel_thread_id"),
                    kestrel_run_id=parsed.get("kestrel_run_id"),
                    model_provider=parsed.get("model_provider"),
                    model=parsed.get("model"),
                    credential_env=parsed.get("credential_env"),
                    credential_fingerprint=parsed.get("credential_fingerprint"),
                    job_input_path=parsed.get("job_input_path"),
                    job_output_path=parsed.get("job_output_path"),
                    event_log_path=parsed.get("event_log_path"),
                    bridge_log_path=parsed.get("bridge_log_path"),
                    job_input_sha256=parsed.get("job_input_sha256"),
                    failure_details=(
                        parsed.get("failure_details")
                        if isinstance(parsed.get("failure_details"), dict)
                        else None
                    ),
                ),
                logging_dir,
            )
            if parsed.get("status") == "completed":
                return AgentResult()
            return AgentResult(failure_mode=FailureMode.UNKNOWN_AGENT_ERROR)
        except TimeoutError as error:
            write_result(
                BenchmarkResult(
                    adapter=TERMINAL_BENCH_RESULT_ADAPTER,
                    dataset=DATASET,
                    task_id=task_id,
                    status="timeout",
                    duration_ms=monotonic_ms(started_at),
                    failure_kind="timeout",
                    notes=str(error),
                    **benchmark_provider_artifact_payload(),
                ),
                logging_dir,
            )
            return AgentResult(failure_mode=FailureMode.AGENT_TIMEOUT)
        finally:
            repo_tarball.unlink(missing_ok=True)

    def _install_agent(
        self,
        session: TmuxSession,
        started_at: float,
        task_id: str,
        logging_dir: Path | None,
    ) -> AgentResult | None:
        session.copy_to_container(
            self._install_agent_script_path,
            container_dir="/installed-agent",
            container_filename="install-agent.sh",
        )
        env_setup_content = self._create_env_setup_file()
        session.container.exec_run(
            [
                "sh",
                "-c",
                f"echo {shlex.quote(env_setup_content)} > /installed-agent/setup-env.sh",
            ]
        )
        try:
            session.send_keys(
                ["source /installed-agent/setup-env.sh", "Enter"],
                block=True,
                max_timeout_sec=30,
            )
            session.send_keys(
                ["bash /installed-agent/install-agent.sh || echo 'INSTALL_FAIL_STATUS'", "Enter"],
                block=True,
                max_timeout_sec=float(os.environ.get("KESTREL_TBENCH_CLI_INSTALL_TIMEOUT_SEC", "1800")),
            )
        except TimeoutError as error:
            write_result(
                BenchmarkResult(
                    adapter=TERMINAL_BENCH_RESULT_ADAPTER,
                    dataset=DATASET,
                    task_id=task_id,
                    status="timeout",
                    duration_ms=monotonic_ms(started_at),
                    failure_kind="timeout",
                    notes=f"CLI install timed out: {error}",
                    **benchmark_provider_artifact_payload(),
                ),
                logging_dir,
            )
            return AgentResult(failure_mode=FailureMode.AGENT_TIMEOUT)

        installation_output = session.capture_pane(capture_entire=True)
        if "INSTALL_FAIL_STATUS" in installation_output.split("\n"):
            write_result(
                BenchmarkResult(
                    adapter=TERMINAL_BENCH_RESULT_ADAPTER,
                    dataset=DATASET,
                    task_id=task_id,
                    status="failed",
                    duration_ms=monotonic_ms(started_at),
                    failure_kind="cli_install_failed",
                    notes="CLI install script emitted INSTALL_FAIL_STATUS.",
                    **benchmark_provider_artifact_payload(),
                ),
                logging_dir,
            )
            return AgentResult(failure_mode=FailureMode.AGENT_INSTALLATION_FAILED)
        return None

    def _run_agent_commands(
        self,
        instruction: str,
        task_id: str,
        timeout_sec: float | None = None,
        external_deadline_ms: int | None = None,
    ) -> list[TerminalCommand]:
        encoded = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        env_prefix = build_deadline_env_prefix(timeout_sec, external_deadline_ms)
        return [
            TerminalCommand(
                command=(
                    f"{env_prefix}python3 /installed-agent/cli_task_runner.py "
                    f"--instruction-base64 {shlex.quote(encoded)} "
                    f"--task-id {shlex.quote(task_id)}"
                ),
                min_timeout_sec=0.2,
                block=False,
            )
        ]


def resolve_repo_root() -> Path:
    explicit = os.environ.get("KESTREL_TBENCH_REPO_ROOT")
    if explicit:
        return Path(explicit).resolve()
    return Path(__file__).resolve().parents[2]


def ensure_installed_agent_helpers_readable(session: TmuxSession) -> None:
    session.container.exec_run(
        [
            "sh",
            "-c",
            "chmod a+r /installed-agent/cli_task_runner.py "
            "/installed-agent/container_devshell_bridge.py "
            "/installed-agent/job_input.py "
            "/installed-agent/provider_config.py "
            "/installed-agent/kestrel_devshell.py",
        ]
    )


def compute_external_deadline_ms(started_at: float, timeout_sec: float | None) -> int | None:
    if timeout_sec is None or timeout_sec <= 0:
        return None
    elapsed = max(0.0, time.monotonic() - started_at)
    remaining = max(1.0, timeout_sec - elapsed)
    return round((time.time() + remaining) * 1000)


def effective_wait_timeout_sec(started_at: float, timeout_sec: float | None) -> float:
    configured = float(os.environ.get("KESTREL_TBENCH_CLI_COMMAND_TIMEOUT_SEC", "7200"))
    if timeout_sec is None or timeout_sec <= 0:
        return configured
    elapsed = max(0.0, time.monotonic() - started_at)
    remaining = max(1.0, timeout_sec - elapsed)
    return min(configured, remaining)


def resolve_agent_timeout_sec(task_id: str, timeout_sec: float | None = None) -> float | None:
    if timeout_sec is not None and timeout_sec > 0:
        return timeout_sec
    configured = parse_positive_float(os.environ.get("KESTREL_TBENCH_AGENT_TIMEOUT_SEC"))
    if configured is not None:
        return configured
    configured = parse_positive_float(os.environ.get("KESTREL_TBENCH_RUN_TIMEOUT_SEC"))
    if configured is not None:
        return configured
    return read_task_max_agent_timeout_sec(task_id)


def read_task_max_agent_timeout_sec(task_id: str) -> float | None:
    if not task_id or task_id == "unknown":
        return None
    dataset_name, _, dataset_version = DATASET.partition("==")
    if not dataset_name or not dataset_version:
        return None
    roots: list[Path] = []
    explicit_root = os.environ.get("KESTREL_TBENCH_CACHE_ROOT")
    if explicit_root:
        roots.append(Path(explicit_root).expanduser())
    roots.append(Path.home() / ".cache" / "terminal-bench")
    for root in roots:
        task_yaml = root / dataset_name / dataset_version / task_id / "task.yaml"
        try:
            content = task_yaml.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in content.splitlines():
            match = re.match(r"^\s*max_agent_timeout_sec\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$", line)
            if match:
                return parse_positive_float(match.group(1))
    return None


def parse_positive_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def build_deadline_env_prefix(timeout_sec: float | None, external_deadline_ms: int | None) -> str:
    assignments: list[str] = []
    if timeout_sec is not None and timeout_sec > 0:
        assignments.append(f"KESTREL_TBENCH_AGENT_TIMEOUT_SEC={shlex.quote(str(timeout_sec))}")
    if external_deadline_ms is not None:
        assignments.append(f"KESTREL_EXTERNAL_DEADLINE_MS={shlex.quote(str(external_deadline_ms))}")
    return "" if not assignments else "env " + " ".join(assignments) + " "


def create_repo_tarball(repo_root: Path) -> Path:
    fd, raw_path = tempfile.mkstemp(prefix="kestrel-", suffix=".tar.gz")
    os.close(fd)
    tarball = Path(raw_path)
    with tarfile.open(tarball, "w:gz") as archive:
        for path in iter_repo_files(repo_root):
            archive.add(path, arcname=path.relative_to(repo_root))
    return tarball


def iter_repo_files(repo_root: Path) -> Iterable[Path]:
    included_root_dirs = {
        "agents",
        "bin",
        "cli",
        "db",
        "models",
        "packages",
        "src",
        "tools",
    }
    included_root_files = {
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.json",
    }
    excluded_dirs = {
        ".git",
        ".external",
        ".kestrel",
        ".next",
        ".turbo",
        ".pnpm-store",
        ".playwright-mcp",
        "node_modules",
        "dist",
        "coverage",
        "runs",
    }
    excluded_suffixes = {
        ".key",
        ".pem",
        ".tsbuildinfo",
        ".cast",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".mp4",
        ".mov",
    }
    for dirpath, dirnames, filenames in os.walk(repo_root):
        current = Path(dirpath)
        relative_parts = current.relative_to(repo_root).parts
        if not relative_parts:
            dirnames[:] = [
                name
                for name in dirnames
                if name in included_root_dirs and name not in excluded_dirs
            ]
        else:
            dirnames[:] = [name for name in dirnames if name not in excluded_dirs]

        for filename in filenames:
            path = current / filename
            relative_file_parts = path.relative_to(repo_root).parts
            top_level = relative_file_parts[0]
            if top_level not in included_root_dirs and filename not in included_root_files:
                continue
            if filename == ".env" or filename.startswith(".env."):
                continue
            if path.suffix in excluded_suffixes:
                continue
            yield path


def parse_cli_result(output: str) -> dict | None:
    matches = list(CLI_RESULT_RE.finditer(output))
    if not matches:
        return None
    raw = base64.b64decode(matches[-1].group("payload")).decode("utf-8")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def benchmark_exception_failure_kind(adapter: str, error: BaseException) -> str:
    message = str(error)
    if "Kestrel benchmarks require OPENROUTER_API_KEY" in message or "Deprecated benchmark env" in message:
        return "benchmark_setup_failed"
    return failure_kind_for_exception(adapter, error)


KestrelCliInstalledAgent = KestrelTerminalBenchAgent


def wait_for_cli_result_marker(
    session: TmuxSession,
    timeout_sec: float,
    logging_dir: Path | None = None,
    task_id: str = "unknown",
    copy_interval_sec: float = 5.0,
) -> str:
    deadline = time.monotonic() + timeout_sec
    last_copy_at = 0.0
    while time.monotonic() < deadline:
        now = time.monotonic()
        if logging_dir is not None and (
            last_copy_at == 0.0 or copy_interval_sec <= 0 or now - last_copy_at >= copy_interval_sec
        ):
            sync_cli_runtime_logs(session, logging_dir, task_id)
            last_copy_at = now
        output = read_agent_log(session) or session.capture_pane(capture_entire=True)
        if CLI_RESULT_RE.search(output):
            sync_cli_runtime_logs(session, logging_dir, task_id)
            return output
        result_json = read_installed_agent_file(session, "/installed-agent/kestrel-cli-result.json")
        if result_json.strip():
            sync_cli_runtime_logs(session, logging_dir, task_id)
            encoded = base64.b64encode(result_json.encode("utf-8")).decode("ascii")
            return f"KESTREL_TBENCH_RESULT_JSON_BASE64:{encoded}"
        time.sleep(0.5)
    sync_cli_runtime_logs(session, logging_dir, task_id)
    raise TimeoutError(f"CLI result marker was not emitted within {timeout_sec:.0f}s.")


def read_agent_log(session: TmuxSession) -> str:
    return read_installed_agent_file(session, "/logs/agent.log")


def read_installed_agent_file(session: TmuxSession, path: str) -> str:
    result = session.container.exec_run(["bash", "-lc", f"cat {shlex.quote(path)} 2>/dev/null || true"])
    if getattr(result, "exit_code", 0) != 0:
        return ""
    output = result.output
    if isinstance(output, bytes):
        return output.decode("utf-8", errors="replace")
    return str(output or "")


def sync_cli_runtime_logs(session: TmuxSession, logging_dir: Path | None, task_id: str) -> None:
    copy_cli_event_log(session, logging_dir, task_id)
    copy_cli_bridge_log(session, logging_dir, task_id)
    copy_cli_prompt_dumps(session, logging_dir)


def copy_cli_event_log(session: TmuxSession, logging_dir: Path | None, task_id: str) -> Path | None:
    if logging_dir is None:
        return None
    result = session.container.exec_run(["bash", "-lc", "cat /installed-agent/kestrel-cli-events.jsonl 2>/dev/null || true"])
    output = result.output
    text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else str(output or "")
    if not text.strip():
        return None
    logging_dir.mkdir(parents=True, exist_ok=True)
    path = logging_dir / f"kestrel-cli-{task_id}.events.jsonl"
    path.write_text(text, encoding="utf-8")
    return path


def copy_cli_bridge_log(session: TmuxSession, logging_dir: Path | None, task_id: str) -> Path | None:
    if logging_dir is None:
        return None
    result = session.container.exec_run(
        ["bash", "-lc", "cat /installed-agent/kestrel-cli-bridge.jsonl 2>/dev/null || true"]
    )
    output = result.output
    text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else str(output or "")
    if not text.strip():
        return None
    logging_dir.mkdir(parents=True, exist_ok=True)
    path = logging_dir / f"kestrel-cli-{task_id}.bridge.jsonl"
    path.write_text(text, encoding="utf-8")
    return path


def copy_cli_prompt_dumps(session: TmuxSession, logging_dir: Path | None) -> Path | None:
    if logging_dir is None:
        return None
    result = session.container.exec_run(
        [
            "bash",
            "-lc",
            "for dir in /tmp/kestrel-home/model-prompts /tmp/kestrel-tbench-cli-home-*/model-prompts; do "
            'if [ -d "$dir" ]; then tar -C "$dir" -czf - .; exit 0; fi; '
            "done",
        ]
    )
    if getattr(result, "exit_code", 0) != 0:
        return None
    output = result.output
    archive = output if isinstance(output, bytes) else bytes(str(output or ""), "utf-8")
    if not archive:
        return None
    host_dir = logging_dir / "kestrel-model-prompts"
    host_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile() as raw:
        raw.write(archive)
        raw.seek(0)
        try:
            with tarfile.open(fileobj=raw, mode="r:gz") as tar:
                safe_extract_tar(tar, host_dir)
        except tarfile.TarError:
            return None
    return host_dir


def safe_extract_tar(tar: tarfile.TarFile, destination: Path) -> None:
    destination_root = destination.resolve()
    members = []
    for member in tar.getmembers():
        target = (destination / member.name).resolve()
        if target != destination_root and destination_root not in target.parents:
            continue
        members.append(member)
    tar.extractall(destination, members=members)


def copy_cli_job_artifacts(
    session: TmuxSession,
    logging_dir: Path | None,
    task_id: str,
    parsed_result: dict,
) -> None:
    if logging_dir is None:
        return
    logging_dir.mkdir(parents=True, exist_ok=True)
    for result_key, suffix in (
        ("job_input_path", "job-input.json"),
        ("job_output_path", "job-output.json"),
    ):
        raw_path = parsed_result.get(result_key)
        if not isinstance(raw_path, str) or not raw_path:
            continue
        content = read_installed_agent_file(session, raw_path)
        if not content.strip():
            continue
        host_path = logging_dir / f"kestrel-terminal-bench-{task_id}.{suffix}"
        host_path.write_text(content, encoding="utf-8")
        parsed_result[result_key] = str(host_path)
