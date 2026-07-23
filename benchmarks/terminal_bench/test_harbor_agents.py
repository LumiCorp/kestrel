from __future__ import annotations

import asyncio
import base64
import json
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

from .harbor_agents import (
    HARBOR_ADAPTER,
    HARBOR_DATASET,
    KestrelHarborCliInstalledAgent,
    BenchmarkResult,
    build_run_env_prefix,
    harbor_env_setup_script,
    harbor_required_artifacts,
    harbor_task_id,
    persist_kestrel_debug_artifacts,
    write_command_result_artifact,
    write_harbor_result_artifact,
)


class FakeHarborEnvironment:
    def __init__(self) -> None:
        self.uploads: list[tuple[str, str]] = []
        self.downloads: list[tuple[str, str]] = []

    def copy_to(self, source: Path | str, destination: str | Path) -> None:
        self.uploads.append((str(source), str(destination)))

    def download_file(self, source: str, destination: Path | str) -> None:
        self.downloads.append((source, str(destination)))
        Path(destination).write_text(f"downloaded {source}\n", encoding="utf-8")


class FakeHarborAgent(KestrelHarborCliInstalledAgent):
    def __init__(self, stdout: str = "") -> None:
        self.root_commands: list[str] = []
        self.root_kwargs: list[dict[str, object]] = []
        self.agent_commands: list[str] = []
        self.stdout = stdout

    async def exec_as_root(self, environment, command: str, **kwargs):
        self.root_commands.append(command)
        self.root_kwargs.append(dict(kwargs))
        if "cli_task_runner.py" in command:
            return SimpleNamespace(stdout=self.stdout)
        return SimpleNamespace(stdout="")

    async def exec_as_agent(self, environment, command: str, **kwargs):
        self.agent_commands.append(command)
        return SimpleNamespace(stdout=self.stdout)


class HarborAgentsTest(unittest.TestCase):
    def test_env_setup_labels_harbor_results_without_prompt_guidance(self) -> None:
        script = harbor_env_setup_script()

        self.assertIn("KESTREL_TBENCH_RESULT_ADAPTER=harbor-cli", script)
        self.assertIn("KESTREL_TBENCH_RESULT_DATASET=terminal-bench@2.0", script)
        self.assertNotIn("OPENROUTER_API_KEY", script)
        self.assertNotIn("OPENAI_API_KEY", script)
        self.assertNotIn("ANTHROPIC_API_KEY", script)
        self.assertNotIn("Kestrel runner guidance", script)
        self.assertNotIn("managed task entrypoints", script)

    def test_task_id_falls_back_to_harbor_trial_path(self) -> None:
        task_id = harbor_task_id(
            SimpleNamespace(),
            Path("/tmp/jobs/2026-06-15__09-42-58/cobol-modernization__bo5VUBJ/agent"),
        )

        self.assertEqual(task_id, "cobol-modernization")

    def test_required_artifacts_fall_back_to_trial_config_path(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            trial_dir = Path(raw_dir) / "cobol-modernization__trial"
            agent_dir = trial_dir / "agent"
            agent_dir.mkdir(parents=True)
            (trial_dir / "config.json").write_text(
                json.dumps({"artifacts": ["/app/program.py"]}),
                encoding="utf-8",
            )

            self.assertEqual(
                harbor_required_artifacts(SimpleNamespace(agent_logs_dir=agent_dir)),
                ["/app/program.py"],
            )

    def test_result_artifact_uses_fallback_logs_dir(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            result = BenchmarkResult(
                adapter=HARBOR_ADAPTER,
                dataset=HARBOR_DATASET,
                task_id="cobol-modernization",
                status="completed",
                duration_ms=1,
                failure_kind="none",
            )

            path = write_harbor_result_artifact(SimpleNamespace(), result, raw_dir)

            self.assertEqual(path, Path(raw_dir) / "kestrel-harbor-cli-cobol-modernization.json")
            self.assertTrue(path.exists())

    def test_command_result_artifact_preserves_early_cli_output(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            path = write_command_result_artifact(
                SimpleNamespace(),
                SimpleNamespace(stdout="before marker\n", stderr="boom\n", returncode=2),
                raw_dir,
            )

            self.assertEqual(path, Path(raw_dir) / "kestrel-cli-command-result.json")
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["stdout"], "before marker\n")
            self.assertEqual(payload["stderr"], "boom\n")
            self.assertEqual(payload["returncode"], 2)

    def test_persists_kestrel_debug_artifacts_to_harbor_logs_dir(self) -> None:
        environment = FakeHarborEnvironment()
        with tempfile.TemporaryDirectory() as raw_dir:
            copied = asyncio.run(persist_kestrel_debug_artifacts(environment, raw_dir))

            self.assertEqual(
                environment.downloads,
                [
                    ("/installed-agent/kestrel-cli-job-input.json", str(Path(raw_dir) / "kestrel-cli-job-input.json")),
                    ("/installed-agent/kestrel-cli-job-output.json", str(Path(raw_dir) / "kestrel-cli-job-output.json")),
                    (
                        "/installed-agent/kestrel-cli-runtime-replay-bundle.json",
                        str(Path(raw_dir) / "kestrel-cli-runtime-replay-bundle.json"),
                    ),
                    ("/installed-agent/kestrel-cli-result.json", str(Path(raw_dir) / "kestrel-cli-result.json")),
                    ("/installed-agent/kestrel-cli-events.jsonl", str(Path(raw_dir) / "kestrel-cli-events.jsonl")),
                    ("/installed-agent/kestrel-cli-bridge.jsonl", str(Path(raw_dir) / "kestrel-cli-bridge.jsonl")),
                ],
            )
            self.assertEqual(
                copied,
                [
                    Path(raw_dir) / "kestrel-cli-job-input.json",
                    Path(raw_dir) / "kestrel-cli-job-output.json",
                    Path(raw_dir) / "kestrel-cli-runtime-replay-bundle.json",
                    Path(raw_dir) / "kestrel-cli-result.json",
                    Path(raw_dir) / "kestrel-cli-events.jsonl",
                    Path(raw_dir) / "kestrel-cli-bridge.jsonl",
                ],
            )

    def test_run_passes_instruction_to_cli_runner_unchanged(self) -> None:
        instruction = "Solve this exact benchmark task.\nDo not rewrite me."
        result = {
            "adapter": HARBOR_ADAPTER,
            "dataset": HARBOR_DATASET,
            "task_id": "cobol-modernization",
            "status": "completed",
            "duration_ms": 10,
            "failure_kind": "none",
            "job_input_sha256": "a" * 64,
        }
        marker = "KESTREL_TBENCH_RESULT_JSON_BASE64:" + base64.b64encode(
            json.dumps(result).encode("utf-8")
        ).decode("ascii")
        agent = FakeHarborAgent(stdout=marker)

        with tempfile.TemporaryDirectory() as raw_dir:
            context = SimpleNamespace(
                task_id="cobol-modernization",
                agent_logs_dir=raw_dir,
                config={"artifacts": ["/app/program.py"]},
            )
            asyncio.run(agent.run(instruction, FakeHarborEnvironment(), context))

            self.assertEqual(agent.agent_commands, [])
            command = agent.root_commands[-1]
            encoded = command.split("--instruction-base64 ", 1)[1].split(" ", 1)[0]
            self.assertEqual(base64.b64decode(encoded).decode("utf-8"), instruction)
            self.assertIn("KESTREL_TBENCH_AGENT_USER=root", command)
            self.assertIn("KESTREL_TBENCH_AGENT_TIMEOUT_SEC=900.0", command)
            self.assertIn("KESTREL_EXTERNAL_DEADLINE_MS=", command)
            self.assertIn("--required-artifact /app/program.py", command)
            self.assertEqual(agent.root_kwargs[-1].get("timeout_sec"), 900.0)
            self.assertNotIn("Kestrel runner guidance", command)
            artifact = Path(raw_dir) / "kestrel-harbor-cli-cobol-modernization.json"
            payload = json.loads(artifact.read_text(encoding="utf-8"))
            self.assertEqual(payload["adapter"], "harbor-cli")
            self.assertEqual(payload["dataset"], "terminal-bench@2.0")
            self.assertEqual(payload["job_input_path"], str(Path(raw_dir) / "kestrel-cli-job-input.json"))
            self.assertEqual(payload["job_output_path"], str(Path(raw_dir) / "kestrel-cli-job-output.json"))
            self.assertEqual(
                payload["runtime_replay_bundle_path"],
                str(Path(raw_dir) / "kestrel-cli-runtime-replay-bundle.json"),
            )
            self.assertEqual(payload["job_input_sha256"], "a" * 64)

    def test_run_preserves_structured_kestrel_failure_without_adapter_exception(self) -> None:
        result = {
            "adapter": HARBOR_ADAPTER,
            "dataset": HARBOR_DATASET,
            "task_id": "overfull-hbox",
            "status": "failed",
            "duration_ms": 10,
            "failure_kind": "kestrel_run_failed",
            "failure_details": {
                "runtime_error": {
                    "code": "MAX_TOOL_CALLS_EXCEEDED",
                },
            },
        }
        marker = "KESTREL_TBENCH_RESULT_JSON_BASE64:" + base64.b64encode(
            json.dumps(result).encode("utf-8")
        ).decode("ascii")
        agent = FakeHarborAgent(stdout=marker)

        with tempfile.TemporaryDirectory() as raw_dir:
            context = SimpleNamespace(task_id="overfull-hbox", agent_logs_dir=raw_dir)
            asyncio.run(agent.run("Fix the benchmark task.", FakeHarborEnvironment(), context))

            command = agent.root_commands[-1]
            self.assertIn("KESTREL_TBENCH_AGENT_EXIT_CODE", command)
            self.assertTrue(command.rstrip().endswith("exit 0"))
            artifact = Path(raw_dir) / "kestrel-harbor-cli-overfull-hbox.json"
            payload = json.loads(artifact.read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "failed")
            self.assertEqual(payload["failure_kind"], "kestrel_run_failed")
            self.assertEqual(payload["failure_details"]["runtime_error"]["code"], "MAX_TOOL_CALLS_EXCEEDED")

    def test_run_env_prefix_defaults_tb2_agent_user_to_root(self) -> None:
        self.assertIn("KESTREL_TBENCH_AGENT_USER=root", build_run_env_prefix(None, None))

    def test_install_uploads_repo_helpers_and_install_script(self) -> None:
        agent = FakeHarborAgent()
        environment = FakeHarborEnvironment()

        with tempfile.NamedTemporaryFile(suffix=".tar.gz") as raw_tarball:
            tarball = Path(raw_tarball.name)
            with mock.patch("benchmarks.terminal_bench.harbor_agents.create_repo_tarball", return_value=tarball):
                asyncio.run(agent.install(environment))

        destinations = {destination for _, destination in environment.uploads}
        self.assertIn("/installed-agent/kestrel.tar.gz", destinations)
        self.assertIn("/installed-agent/cli_task_runner.py", destinations)
        self.assertIn("/installed-agent/container_devshell_bridge.py", destinations)
        self.assertIn("/installed-agent/job_input.py", destinations)
        self.assertIn("/installed-agent/kestrel_devshell.py", destinations)
        self.assertIn("/installed-agent/install-agent.sh", destinations)
        self.assertTrue(any("/installed-agent/install-agent.sh" in command for command in agent.root_commands))
        self.assertFalse(any("python3 - <<'PY'" in command for command in agent.root_commands))
        self.assertTrue(any("printf %s" in command and "/installed-agent/setup-env.sh" in command for command in agent.root_commands))


if __name__ == "__main__":
    unittest.main()
