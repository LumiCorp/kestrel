from __future__ import annotations

import base64
import json
import os
import shlex
import time
from pathlib import Path
from typing import Any

from .harbor_agents import (
    BaseInstalledAgent,
    BenchmarkResult,
    command_output_text,
    harbor_artifact_dir,
    harbor_task_id,
    maybe_await,
    parse_positive_float,
    upload_file_to_environment,
    without_none_values,
)
from .results import monotonic_ms, write_result


CODEX_HARBOR_DATASET = "terminal-bench@2.0"
CODEX_HARBOR_ADAPTER = "codex-harbor-cli"
CODEX_HARBOR_AGENT_NAME = "codex-harbor-cli"
CODEX_RESULT_RE_PREFIX = "CODEX_TBENCH_RESULT_JSON_BASE64:"


class CodexHarborCliInstalledAgent(BaseInstalledAgent):
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
        return CODEX_HARBOR_AGENT_NAME

    async def install(self, environment: Any) -> None:
        await self._exec_as_root(environment, "mkdir -p /installed-agent && chmod 755 /installed-agent")
        await upload_file_to_environment(
            environment,
            Path(__file__).parent / "codex_cli_agent_runner.py",
            "/installed-agent/codex_cli_agent_runner.py",
        )
        await self._exec_as_root(
            environment,
            codex_install_command(),
            timeout_sec=codex_install_timeout_sec(),
        )

    async def run(self, instruction: str, environment: Any, context: Any) -> None:
        started_at = time.monotonic()
        task_id = harbor_task_id(context, getattr(self, "logs_dir", None))
        timeout_sec = resolve_codex_timeout_sec()
        encoded = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        model = os.environ.get("KESTREL_TBENCH_CODEX_MODEL", "").strip()
        command = (
            "env "
            f"CODEX_TBENCH_RESULT_DATASET={shlex.quote(CODEX_HARBOR_DATASET)} "
            "python3 /installed-agent/codex_cli_agent_runner.py "
            f"--instruction-base64 {shlex.quote(encoded)} "
            f"--task-id {shlex.quote(task_id)} "
            f"--timeout-sec {shlex.quote(str(timeout_sec))} "
            f"--model {shlex.quote(model)}"
        )
        wrapped_command = (
            f"{command}; "
            "__codex_agent_status=$?; "
            "printf '\\nCODEX_TBENCH_AGENT_EXIT_CODE:%s\\n' \"$__codex_agent_status\"; "
            "exit 0"
        )
        try:
            result = await self._exec_as_agent(
                environment,
                wrapped_command,
                env=codex_cli_env(),
                timeout_sec=timeout_sec + 30,
            )
        finally:
            await persist_codex_debug_artifacts(environment, getattr(self, "logs_dir", None))
        stdout = command_output_text(result)
        parsed = parse_codex_result(stdout) or await read_codex_cli_result(self, environment)
        if parsed is None:
            failure = BenchmarkResult(
                adapter=CODEX_HARBOR_ADAPTER,
                dataset=CODEX_HARBOR_DATASET,
                task_id=task_id,
                status="failed",
                duration_ms=monotonic_ms(started_at),
                failure_kind="cli_command_failed",
                notes="Harbor run did not emit a Codex CLI result marker.",
            )
            write_codex_harbor_result_artifact(context, failure, getattr(self, "logs_dir", None))
            raise RuntimeError(failure.notes)

        normalized = BenchmarkResult(
            adapter=CODEX_HARBOR_ADAPTER,
            dataset=CODEX_HARBOR_DATASET,
            task_id=str(parsed.get("task_id") or task_id),
            status=str(parsed.get("status") or "failed"),  # type: ignore[arg-type]
            duration_ms=int(parsed.get("duration_ms") or monotonic_ms(started_at)),
            failure_kind=str(parsed.get("failure_kind") or "cli_command_failed"),  # type: ignore[arg-type]
            notes=str(parsed.get("notes") or ""),
            failure_details=(
                parsed.get("failure_details")
                if isinstance(parsed.get("failure_details"), dict)
                else None
            ),
        )
        write_codex_harbor_result_artifact(context, normalized, getattr(self, "logs_dir", None))

    async def _exec_as_root(self, environment: Any, command: str, **kwargs: Any) -> Any:
        return await maybe_await(self.exec_as_root(environment, command=command, **without_none_values(kwargs)))

    async def _exec_as_agent(self, environment: Any, command: str, **kwargs: Any) -> Any:
        return await maybe_await(self.exec_as_agent(environment, command=command, **without_none_values(kwargs)))


async def persist_codex_debug_artifacts(environment: Any, logs_dir: Any) -> list[Path]:
    if not isinstance(logs_dir, (str, Path)):
        return []
    target_dir = Path(logs_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    copied: list[Path] = []
    for source, name in (
        ("/installed-agent/codex-cli-result.json", "codex-cli-result.json"),
        ("/installed-agent/codex-cli-stdout.txt", "codex-cli-stdout.txt"),
        ("/installed-agent/codex-cli-stderr.txt", "codex-cli-stderr.txt"),
    ):
        destination = target_dir / name
        try:
            await maybe_await(environment.download_file(source, destination))
        except Exception:
            continue
        copied.append(destination)
    return copied


async def read_codex_cli_result(agent: CodexHarborCliInstalledAgent, environment: Any) -> dict[str, Any] | None:
    result = await agent._exec_as_root(
        environment,
        "cat /installed-agent/codex-cli-result.json 2>/dev/null || true",
    )
    text = command_output_text(result)
    if not text.strip():
        return None
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_codex_result(output: str) -> dict[str, Any] | None:
    payload = None
    for line in output.splitlines():
        if line.startswith(CODEX_RESULT_RE_PREFIX):
            payload = line.removeprefix(CODEX_RESULT_RE_PREFIX)
    if payload is None:
        return None
    try:
        parsed = json.loads(base64.b64decode(payload).decode("utf-8"))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def write_codex_harbor_result_artifact(
    context: Any,
    result: BenchmarkResult,
    fallback_dir: Any = None,
) -> Path | None:
    artifact_dir = harbor_artifact_dir(context, fallback_dir)
    if artifact_dir is None:
        return None
    return write_result(result, artifact_dir)


def resolve_codex_timeout_sec() -> float:
    configured = parse_positive_float(os.environ.get("KESTREL_TBENCH_CODEX_TIMEOUT_SEC"))
    if configured is not None:
        return configured
    configured = parse_positive_float(os.environ.get("KESTREL_TBENCH_AGENT_TIMEOUT_SEC"))
    if configured is not None:
        return configured
    configured = parse_positive_float(os.environ.get("KESTREL_TBENCH_RUN_TIMEOUT_SEC"))
    if configured is not None:
        return configured
    return 1800.0


def codex_install_timeout_sec() -> float:
    configured = parse_positive_float(os.environ.get("KESTREL_TBENCH_CODEX_INSTALL_TIMEOUT_SEC"))
    if configured is not None:
        return configured
    return 900.0


def codex_install_command() -> str:
    return (
        "chmod a+r /installed-agent/codex_cli_agent_runner.py && "
        "if ! command -v codex >/dev/null 2>&1; then "
        "  if ! command -v npm >/dev/null 2>&1; then "
        "    if command -v apt-get >/dev/null 2>&1; then "
        "      export DEBIAN_FRONTEND=noninteractive; "
        "      apt-get update && apt-get install -y nodejs npm; "
        "    elif command -v apk >/dev/null 2>&1; then "
        "      apk add --no-cache nodejs npm; "
        "    elif command -v dnf >/dev/null 2>&1; then "
        "      dnf install -y nodejs npm; "
        "    elif command -v yum >/dev/null 2>&1; then "
        "      yum install -y nodejs npm; "
        "    else "
        "      echo 'Codex CLI missing and no supported package manager is available to install npm' >&2; "
        "      exit 127; "
        "    fi; "
        "  fi; "
        "  npm install -g @openai/codex; "
        "fi && codex --version"
    )


def codex_cli_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for key in (
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_ORG_ID",
        "OPENAI_PROJECT_ID",
        "CODEX_HOME",
    ):
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env
