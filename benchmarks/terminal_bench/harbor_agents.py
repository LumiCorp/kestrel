from __future__ import annotations

import base64
import inspect
import json
import os
import re
import shlex
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable

try:
    from harbor.agents.installed.base import BaseInstalledAgent
except ImportError:
    class BaseInstalledAgent:  # type: ignore[no-redef]
        async def exec_as_root(self, environment: Any, command: str, **kwargs: Any) -> Any:
            raise RuntimeError("harbor is not installed")

        async def exec_as_agent(self, environment: Any, command: str, **kwargs: Any) -> Any:
            raise RuntimeError("harbor is not installed")

from .provider_config import benchmark_provider_artifact_payload
from .results import BenchmarkResult, monotonic_ms, write_result


HARBOR_DATASET = "terminal-bench@2.0"
HARBOR_ADAPTER = "harbor-cli"
HARBOR_AGENT_NAME = "kestrel-harbor-cli"
DEFAULT_HARBOR_AGENT_USER = "root"
DEFAULT_HARBOR_AGENT_TIMEOUT_SEC = 900.0
CLI_RESULT_RE = re.compile(r"KESTREL_TBENCH_RESULT_JSON_BASE64:(?P<payload>[A-Za-z0-9+/=]+)")


class KestrelHarborCliInstalledAgent(BaseInstalledAgent):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super_init = getattr(super(), "__init__", None)
        if callable(super_init):
            try:
                super_init(*args, **kwargs)
            except TypeError:
                super_init()
        self.logs_dir = kwargs.get("logs_dir")
        self.model_name = kwargs.get("model_name")

    @staticmethod
    def name() -> str:
        return HARBOR_AGENT_NAME

    async def install(self, environment: Any) -> None:
        repo_root = resolve_repo_root()
        repo_tarball = create_repo_tarball(repo_root)
        try:
            await self._exec_as_root(environment, "mkdir -p /installed-agent /opt && chmod 755 /installed-agent")
            await upload_file_to_environment(
                environment,
                repo_tarball,
                "/installed-agent/kestrel.tar.gz",
            )
            for source, destination in {
                Path(__file__).parent / "cli_task_runner.py": "/installed-agent/cli_task_runner.py",
                Path(__file__).parent / "container_devshell_bridge.py": "/installed-agent/container_devshell_bridge.py",
                Path(__file__).parent / "job_input.py": "/installed-agent/job_input.py",
                Path(__file__).parent / "provider_config.py": "/installed-agent/provider_config.py",
                repo_root / "src" / "devshell" / "kestrel_devshell.py": "/installed-agent/kestrel_devshell.py",
                Path(__file__).parent / "setup.sh": "/installed-agent/install-agent.sh",
            }.items():
                await upload_file_to_environment(environment, source, destination)

            setup_script = harbor_env_setup_script()
            await write_text_to_environment(self, environment, "/installed-agent/setup-env.sh", setup_script)
            await self._exec_as_root(
                environment,
                "chmod a+r /installed-agent/cli_task_runner.py "
                "/installed-agent/container_devshell_bridge.py "
                "/installed-agent/job_input.py "
                "/installed-agent/provider_config.py "
                "/installed-agent/kestrel_devshell.py "
                "&& chmod +x /installed-agent/install-agent.sh "
                "&& . /installed-agent/setup-env.sh "
                "&& /installed-agent/install-agent.sh",
                timeout_sec=harbor_install_timeout_sec(),
            )
        finally:
            repo_tarball.unlink(missing_ok=True)

    async def run(self, instruction: str, environment: Any, context: Any) -> None:
        started_at = time.monotonic()
        logs_dir = harbor_artifact_dir(context, getattr(self, "logs_dir", None))
        task_id = harbor_task_id(context, logs_dir)
        timeout_sec = resolve_agent_timeout_sec(task_id)
        external_deadline_ms = compute_external_deadline_ms(started_at, timeout_sec)
        encoded = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        env_prefix = build_run_env_prefix(timeout_sec, external_deadline_ms)
        required_artifact_args = " ".join(
            f"--required-artifact {shlex.quote(path)}"
            for path in harbor_required_artifacts(context, logs_dir)
        )
        command = (
            f"{env_prefix}python3 /installed-agent/cli_task_runner.py "
            f"--instruction-base64 {shlex.quote(encoded)} "
            f"--task-id {shlex.quote(task_id)}"
            f"{(' ' + required_artifact_args) if required_artifact_args else ''}"
        )
        wrapped_command = (
            f"{command}; "
            "__kestrel_agent_status=$?; "
            "printf '\\nKESTREL_TBENCH_AGENT_EXIT_CODE:%s\\n' \"$__kestrel_agent_status\"; "
            "exit 0"
        )
        debug_artifacts: list[Path] = []
        try:
            result = await self._exec_as_root(
                environment,
                wrapped_command,
                timeout_sec=timeout_sec,
            )
        finally:
            debug_artifacts = await persist_kestrel_debug_artifacts(
                environment,
                logs_dir,
            )
        write_command_result_artifact(context, result, logs_dir)
        stdout = command_output_text(result)
        parsed = parse_cli_result(stdout) or await read_harbor_cli_result(self, environment)
        if parsed is None:
            result = BenchmarkResult(
                adapter=HARBOR_ADAPTER,
                dataset=HARBOR_DATASET,
                task_id=task_id,
                status="failed",
                duration_ms=monotonic_ms(started_at),
                failure_kind="cli_command_failed",
                notes="Harbor run did not emit a Kestrel result marker.",
                **benchmark_provider_artifact_payload(),
            )
            write_harbor_result_artifact(context, result, logs_dir)
            raise RuntimeError(result.notes)

        normalized = BenchmarkResult(
            adapter=HARBOR_ADAPTER,
            dataset=HARBOR_DATASET,
            task_id=str(parsed.get("task_id") or task_id),
            status=str(parsed.get("status") or "failed"),  # type: ignore[arg-type]
            duration_ms=int(parsed.get("duration_ms") or monotonic_ms(started_at)),
            failure_kind=str(parsed.get("failure_kind") or "cli_command_failed"),  # type: ignore[arg-type]
            notes=str(parsed.get("notes") or ""),
            kestrel_session_id=string_or_none(parsed.get("kestrel_session_id")),
            kestrel_thread_id=string_or_none(parsed.get("kestrel_thread_id")),
            kestrel_run_id=string_or_none(parsed.get("kestrel_run_id")),
            model_provider=string_or_none(parsed.get("model_provider")),
            model=string_or_none(parsed.get("model")),
            credential_env=string_or_none(parsed.get("credential_env")),
            credential_fingerprint=string_or_none(parsed.get("credential_fingerprint")),
            job_input_path=persisted_artifact_path(debug_artifacts, "kestrel-cli-job-input.json"),
            job_output_path=persisted_artifact_path(debug_artifacts, "kestrel-cli-job-output.json"),
            event_log_path=persisted_artifact_path(debug_artifacts, "kestrel-cli-events.jsonl"),
            bridge_log_path=persisted_artifact_path(debug_artifacts, "kestrel-cli-bridge.jsonl"),
            job_input_sha256=string_or_none(parsed.get("job_input_sha256")),
            runtime_replay_bundle_path=persisted_artifact_path(
                debug_artifacts,
                "kestrel-cli-runtime-replay-bundle.json",
            ),
            harness_revision=string_or_none(parsed.get("harness_revision")),
            failure_details=(
                parsed.get("failure_details")
                if isinstance(parsed.get("failure_details"), dict)
                else None
            ),
        )
        write_harbor_result_artifact(context, normalized, logs_dir)

    async def _exec_as_root(self, environment: Any, command: str, **kwargs: Any) -> Any:
        return await maybe_await(self.exec_as_root(environment, command=command, **without_none_values(kwargs)))

    async def _exec_as_agent(self, environment: Any, command: str, **kwargs: Any) -> Any:
        return await maybe_await(self.exec_as_agent(environment, command=command, **without_none_values(kwargs)))


def harbor_env_setup_script() -> str:
    lines = [
        f"export KESTREL_TBENCH_RESULT_ADAPTER={shlex.quote(HARBOR_ADAPTER)}",
        f"export KESTREL_TBENCH_RESULT_DATASET={shlex.quote(HARBOR_DATASET)}",
    ]
    return "\n".join(lines) + "\n"


async def upload_file_to_environment(environment: Any, source: Path, destination: str) -> None:
    for method_name in ("copy_to", "copy_to_container", "upload_file", "upload"):
        method = getattr(environment, method_name, None)
        if method is None:
            continue
        for args in (
            (source, destination),
            (str(source), destination),
            (source, Path(destination)),
            (str(source), Path(destination)),
        ):
            try:
                await maybe_await(method(*args))
                return
            except TypeError:
                continue
    raise RuntimeError(
        "Harbor environment does not expose a supported file upload method "
        f"for {source} -> {destination}."
    )


async def write_text_to_environment(
    agent: KestrelHarborCliInstalledAgent,
    environment: Any,
    path: str,
    content: str,
) -> None:
    parent = str(Path(path).parent)
    await agent._exec_as_root(
        environment,
        f"mkdir -p {shlex.quote(parent)} && printf %s {shlex.quote(content)} > {shlex.quote(path)}",
    )


async def read_harbor_cli_result(agent: KestrelHarborCliInstalledAgent, environment: Any) -> dict[str, Any] | None:
    result = await agent._exec_as_root(
        environment,
        "cat /installed-agent/kestrel-cli-result.json 2>/dev/null || true",
    )
    text = command_output_text(result)
    if not text.strip():
        return None
    try:
        parsed = __import__("json").loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


async def persist_kestrel_debug_artifacts(environment: Any, logs_dir: Any) -> list[Path]:
    if not isinstance(logs_dir, (str, Path)):
        return []
    target_dir = Path(logs_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    copied: list[Path] = []
    for source, name in (
        ("/installed-agent/kestrel-cli-job-input.json", "kestrel-cli-job-input.json"),
        ("/installed-agent/kestrel-cli-job-output.json", "kestrel-cli-job-output.json"),
        (
            "/installed-agent/kestrel-cli-runtime-replay-bundle.json",
            "kestrel-cli-runtime-replay-bundle.json",
        ),
        ("/installed-agent/kestrel-cli-result.json", "kestrel-cli-result.json"),
        ("/installed-agent/kestrel-cli-events.jsonl", "kestrel-cli-events.jsonl"),
        ("/installed-agent/kestrel-cli-bridge.jsonl", "kestrel-cli-bridge.jsonl"),
    ):
        destination = target_dir / name
        try:
            await maybe_await(environment.download_file(source, destination))
        except Exception:
            continue
        copied.append(destination)
    return copied


def persisted_artifact_path(artifacts: Iterable[Path], name: str) -> str | None:
    return next((str(path) for path in artifacts if path.name == name), None)


def write_harbor_result_artifact(
    context: Any,
    result: BenchmarkResult,
    fallback_dir: Any = None,
) -> Path | None:
    artifact_dir = harbor_artifact_dir(context, fallback_dir)
    if artifact_dir is None:
        return None
    return write_result(result, artifact_dir)


def write_command_result_artifact(
    context: Any,
    result: Any,
    fallback_dir: Any = None,
) -> Path | None:
    artifact_dir = harbor_artifact_dir(context, fallback_dir)
    if artifact_dir is None:
        return None
    path = artifact_dir / "kestrel-cli-command-result.json"
    path.write_text(json.dumps(command_result_payload(result), indent=2) + "\n", encoding="utf-8")
    return path


def command_result_payload(result: Any) -> dict[str, Any]:
    return {
        "type": type(result).__name__,
        **{
            name: capped_text(value)
            for name in ("stdout", "stderr", "output", "text")
            if (value := getattr(result, name, None)) is not None
        },
        **{
            name: value
            for name in ("returncode", "return_code", "exit_code", "status")
            if (value := getattr(result, name, None)) is not None
        },
    }


def capped_text(value: Any, limit: int = 20000) -> str:
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
    else:
        text = str(value)
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated]"


def harbor_artifact_dir(context: Any, fallback_dir: Any = None) -> Path | None:
    for name in ("agent_logs_dir", "artifact_dir", "artifacts_dir", "output_dir", "log_dir"):
        value = getattr(context, name, None)
        if isinstance(value, (str, Path)):
            path = Path(value)
            path.mkdir(parents=True, exist_ok=True)
            return path
    if isinstance(fallback_dir, (str, Path)):
        path = Path(fallback_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path
    return None


def harbor_task_id(context: Any, logs_dir: Any = None) -> str:
    for path in (
        ("task_id",),
        ("task", "id"),
        ("task", "name"),
        ("trial", "task_id"),
        ("trial", "task", "id"),
        ("trial", "task", "name"),
    ):
        value = nested_attr(context, path)
        if isinstance(value, str) and value:
            return value
    from_logs_dir = task_id_from_harbor_logs_dir(logs_dir)
    if from_logs_dir is not None:
        return from_logs_dir
    return "unknown"


def harbor_required_artifacts(context: Any, logs_dir: Any = None) -> list[str]:
    candidates: list[Any] = []
    direct = getattr(context, "artifacts", None)
    if isinstance(direct, list):
        candidates.extend(direct)
    config = getattr(context, "config", None)
    if isinstance(config, dict):
        configured = config.get("artifacts")
        if isinstance(configured, list):
            candidates.extend(configured)
    for config_path in harbor_config_candidate_paths(context, logs_dir):
        try:
            config_record = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(config_record, dict):
            continue
        configured = config_record.get("artifacts")
        if isinstance(configured, list):
            candidates.extend(configured)
    result: list[str] = []
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            result.append(candidate.strip())
    return list(dict.fromkeys(result))


def harbor_config_candidate_paths(context: Any, logs_dir: Any = None) -> list[Path]:
    candidates: list[Path] = []
    for source in (
        getattr(context, "config_path", None),
        nested_attr(context, ("config", "path")),
        getattr(context, "agent_logs_dir", None),
        getattr(context, "artifact_dir", None),
        getattr(context, "artifacts_dir", None),
        logs_dir,
    ):
        if not isinstance(source, (str, Path)):
            continue
        path = Path(source)
        if path.name == "config.json":
            candidates.append(path)
            continue
        candidates.extend([
            path / "config.json",
            path.parent / "config.json",
            path.parent.parent / "config.json",
        ])
    deduped: list[Path] = []
    seen: set[Path] = set()
    for path in candidates:
        resolved = path.expanduser()
        if resolved in seen:
            continue
        seen.add(resolved)
        deduped.append(resolved)
    return deduped


def task_id_from_harbor_logs_dir(logs_dir: Any) -> str | None:
    if not isinstance(logs_dir, (str, Path)):
        return None
    for part in reversed(Path(logs_dir).parts):
        if "__" not in part:
            continue
        task_id = part.split("__", 1)[0]
        if task_id:
            return task_id
    return None


def nested_attr(value: Any, path: tuple[str, ...]) -> Any:
    current = value
    for part in path:
        current = getattr(current, part, None)
        if current is None:
            return None
    return current


def command_output_text(result: Any) -> str:
    for name in ("stdout", "output", "text"):
        value = getattr(result, name, None)
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        if isinstance(value, str):
            return value
    if isinstance(result, bytes):
        return result.decode("utf-8", errors="replace")
    return str(result or "")


async def maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def without_none_values(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def harbor_install_timeout_sec() -> float:
    raw = os.environ.get("KESTREL_TBENCH_CLI_INSTALL_TIMEOUT_SEC", "1800")
    try:
        parsed = float(raw)
    except ValueError:
        return 1800.0
    return parsed if parsed > 0 else 1800.0


def string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def resolve_repo_root() -> Path:
    explicit = os.environ.get("KESTREL_TBENCH_REPO_ROOT")
    if explicit:
        return Path(explicit).resolve()
    return Path(__file__).resolve().parents[2]


def compute_external_deadline_ms(started_at: float, timeout_sec: float | None) -> int | None:
    if timeout_sec is None or timeout_sec <= 0:
        return None
    elapsed = max(0.0, time.monotonic() - started_at)
    remaining = max(1.0, timeout_sec - elapsed)
    return round((time.time() + remaining) * 1000)


def resolve_agent_timeout_sec(task_id: str) -> float | None:
    configured = parse_positive_float(os.environ.get("KESTREL_TBENCH_AGENT_TIMEOUT_SEC"))
    if configured is not None:
        return configured
    configured = parse_positive_float(os.environ.get("KESTREL_TBENCH_RUN_TIMEOUT_SEC"))
    if configured is not None:
        return configured
    return DEFAULT_HARBOR_AGENT_TIMEOUT_SEC


def parse_positive_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def build_deadline_env_prefix(timeout_sec: float | None, external_deadline_ms: int | None) -> str:
    assignments = deadline_env_assignments(timeout_sec, external_deadline_ms)
    return "" if not assignments else "env " + " ".join(assignments) + " "


def deadline_env_assignments(timeout_sec: float | None, external_deadline_ms: int | None) -> list[str]:
    assignments: list[str] = []
    if timeout_sec is not None and timeout_sec > 0:
        assignments.append(f"KESTREL_TBENCH_AGENT_TIMEOUT_SEC={shlex.quote(str(timeout_sec))}")
    if external_deadline_ms is not None:
        assignments.append(f"KESTREL_EXTERNAL_DEADLINE_MS={shlex.quote(str(external_deadline_ms))}")
    return assignments


def build_run_env_prefix(timeout_sec: float | None, external_deadline_ms: int | None) -> str:
    assignments = [f"KESTREL_TBENCH_AGENT_USER={shlex.quote(resolve_harbor_agent_user())}"]
    assignments.extend(deadline_env_assignments(timeout_sec, external_deadline_ms))
    return "env " + " ".join(assignments) + " "


def resolve_harbor_agent_user() -> str:
    return (
        os.environ.get("KESTREL_TBENCH_HARBOR_AGENT_USER")
        or os.environ.get("KESTREL_TBENCH_AGENT_USER")
        or DEFAULT_HARBOR_AGENT_USER
    )


def parse_cli_result(output: str) -> dict[str, Any] | None:
    matches = list(CLI_RESULT_RE.finditer(output))
    if not matches:
        return None
    raw = base64.b64decode(matches[-1].group("payload")).decode("utf-8")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


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
