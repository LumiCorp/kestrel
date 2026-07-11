from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

base_agent = types.ModuleType("terminal_bench.agents.base_agent")
base_agent.AgentResult = object
base_agent.BaseAgent = object
failure_mode = types.ModuleType("terminal_bench.agents.failure_mode")
failure_mode.FailureMode = SimpleNamespace(
    NONE="none",
    UNKNOWN_AGENT_ERROR="unknown_agent_error",
    AGENT_TIMEOUT="agent_timeout",
    AGENT_INSTALLATION_FAILED="agent_installation_failed",
)
abstract_installed_agent = types.ModuleType("terminal_bench.agents.installed_agents.abstract_installed_agent")
abstract_installed_agent.AbstractInstalledAgent = object
terminal_models = types.ModuleType("terminal_bench.terminal.models")
terminal_models.TerminalCommand = object
tmux_session = types.ModuleType("terminal_bench.terminal.tmux_session")
tmux_session.TmuxSession = object
sys.modules.setdefault("terminal_bench.agents.base_agent", base_agent)
sys.modules.setdefault("terminal_bench.agents.failure_mode", failure_mode)
sys.modules.setdefault("terminal_bench.agents.installed_agents.abstract_installed_agent", abstract_installed_agent)
sys.modules.setdefault("terminal_bench.terminal.models", terminal_models)
sys.modules.setdefault("terminal_bench.terminal.tmux_session", tmux_session)

from .codex_harbor_agent import (  # noqa: E402
    CODEX_HARBOR_ADAPTER,
    CODEX_HARBOR_DATASET,
    CodexHarborCliInstalledAgent,
    BenchmarkResult,
    codex_install_command,
    persist_codex_debug_artifacts,
    write_codex_harbor_result_artifact,
)
from .codex_cli_agent_runner import build_codex_command  # noqa: E402


class FakeHarborEnvironment:
    def __init__(self) -> None:
        self.uploads: list[tuple[str, str]] = []
        self.downloads: list[tuple[str, str]] = []

    def copy_to(self, source: Path | str, destination: str | Path) -> None:
        self.uploads.append((str(source), str(destination)))

    def download_file(self, source: str, destination: Path | str) -> None:
        self.downloads.append((source, str(destination)))
        Path(destination).write_text(f"downloaded {source}\n", encoding="utf-8")


class FakeCodexHarborAgent(CodexHarborCliInstalledAgent):
    def __init__(self, stdout: str = "") -> None:
        self.root_commands: list[str] = []
        self.agent_commands: list[str] = []
        self.agent_command_kwargs: list[dict] = []
        self.stdout = stdout

    async def exec_as_root(self, environment, command: str, **kwargs):
        self.root_commands.append(command)
        return SimpleNamespace(stdout="")

    async def exec_as_agent(self, environment, command: str, **kwargs):
        self.agent_commands.append(command)
        self.agent_command_kwargs.append(kwargs)
        return SimpleNamespace(stdout=self.stdout)


class CodexHarborAgentTest(unittest.TestCase):
    def test_install_uploads_runner_and_checks_codex_cli(self) -> None:
        agent = FakeCodexHarborAgent()
        environment = FakeHarborEnvironment()

        asyncio.run(agent.install(environment))

        destinations = {destination for _, destination in environment.uploads}
        self.assertIn("/installed-agent/codex_cli_agent_runner.py", destinations)
        self.assertTrue(any("codex --version" in command for command in agent.root_commands))
        self.assertTrue(any("@openai/codex" in command for command in agent.root_commands))

    def test_install_command_can_bootstrap_npm_when_missing(self) -> None:
        command = codex_install_command()

        self.assertIn("apt-get install -y nodejs npm", command)
        self.assertIn("apk add --no-cache nodejs npm", command)
        self.assertIn("npm install -g @openai/codex", command)

    def test_codex_runner_skips_git_repo_check_for_benchmark_workspace(self) -> None:
        command = build_codex_command("gpt-5.4")

        self.assertIn("--skip-git-repo-check", command)
        self.assertEqual(command[-2:], ["/app", "-"])

    def test_result_artifact_uses_codex_adapter_name(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            result = BenchmarkResult(
                adapter=CODEX_HARBOR_ADAPTER,
                dataset=CODEX_HARBOR_DATASET,
                task_id="overfull-hbox",
                status="completed",
                duration_ms=1,
                failure_kind="none",
            )

            path = write_codex_harbor_result_artifact(SimpleNamespace(), result, raw_dir)

            self.assertEqual(path, Path(raw_dir) / "kestrel-codex-harbor-cli-overfull-hbox.json")
            self.assertTrue(path.exists())

    def test_persists_codex_debug_artifacts_to_harbor_logs_dir(self) -> None:
        environment = FakeHarborEnvironment()
        with tempfile.TemporaryDirectory() as raw_dir:
            copied = asyncio.run(persist_codex_debug_artifacts(environment, raw_dir))

            self.assertEqual(
                environment.downloads,
                [
                    ("/installed-agent/codex-cli-result.json", str(Path(raw_dir) / "codex-cli-result.json")),
                    ("/installed-agent/codex-cli-stdout.txt", str(Path(raw_dir) / "codex-cli-stdout.txt")),
                    ("/installed-agent/codex-cli-stderr.txt", str(Path(raw_dir) / "codex-cli-stderr.txt")),
                ],
            )
            self.assertEqual(
                copied,
                [
                    Path(raw_dir) / "codex-cli-result.json",
                    Path(raw_dir) / "codex-cli-stdout.txt",
                    Path(raw_dir) / "codex-cli-stderr.txt",
                ],
            )

    def test_run_passes_instruction_to_codex_runner_unchanged(self) -> None:
        instruction = "Ensure that main.tex compiles.\nDo not rewrite this instruction."
        result = {
            "adapter": CODEX_HARBOR_ADAPTER,
            "dataset": CODEX_HARBOR_DATASET,
            "task_id": "overfull-hbox",
            "status": "completed",
            "duration_ms": 10,
            "failure_kind": "none",
        }
        marker = "CODEX_TBENCH_RESULT_JSON_BASE64:" + base64.b64encode(
            json.dumps(result).encode("utf-8")
        ).decode("ascii")
        agent = FakeCodexHarborAgent(stdout=marker)

        with tempfile.TemporaryDirectory() as raw_dir:
            context = SimpleNamespace(task_id="overfull-hbox", agent_logs_dir=raw_dir)
            with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False):
                asyncio.run(agent.run(instruction, FakeHarborEnvironment(), context))

            command = agent.agent_commands[-1]
            encoded = command.split("--instruction-base64 ", 1)[1].split(" ", 1)[0]
            self.assertEqual(base64.b64decode(encoded).decode("utf-8"), instruction)
            self.assertIn("codex_cli_agent_runner.py", command)
            self.assertNotIn("test-key", command)
            self.assertEqual(agent.agent_command_kwargs[-1]["env"]["OPENAI_API_KEY"], "test-key")
            self.assertNotIn("Kestrel runner guidance", command)
            artifact = Path(raw_dir) / "kestrel-codex-harbor-cli-overfull-hbox.json"
            payload = json.loads(artifact.read_text(encoding="utf-8"))
            self.assertEqual(payload["adapter"], "codex-harbor-cli")
            self.assertEqual(payload["dataset"], "terminal-bench@2.0")


if __name__ == "__main__":
    unittest.main()
