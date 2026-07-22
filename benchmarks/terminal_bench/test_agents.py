from __future__ import annotations

import unittest
import unittest.mock
import sys
import tarfile
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace

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

from .agents import (
    KestrelTerminalBenchAgent,
    build_deadline_env_prefix,
    compute_external_deadline_ms,
    copy_cli_job_artifacts,
    copy_cli_prompt_dumps,
    effective_wait_timeout_sec,
    ensure_installed_agent_helpers_readable,
    parse_cli_result,
    read_installed_agent_file,
    resolve_agent_timeout_sec,
    wait_for_cli_result_marker,
)


class FakeContainer:
    def __init__(self, exit_code: int, output: bytes):
        self.exit_code = exit_code
        self.output = output
        self.commands: list[list[str]] = []

    def exec_run(self, command: list[str]):
        self.commands.append(command)
        return SimpleNamespace(exit_code=self.exit_code, output=self.output)


class FakeSession:
    def __init__(self, container: FakeContainer):
        self.container = container

    def capture_pane(self, capture_entire: bool = False):
        return ""


class FileBackedContainer:
    def __init__(self, files: dict[str, str]):
        self.files = files
        self.commands: list[list[str]] = []

    def exec_run(self, command: list[str]):
        self.commands.append(command)
        script = command[-1]
        for path, content in self.files.items():
            if path in script:
                return SimpleNamespace(exit_code=0, output=content.encode("utf-8"))
        return SimpleNamespace(exit_code=0, output=b"")


class PromptDumpContainer:
    def __init__(self, archive: bytes):
        self.archive = archive
        self.commands: list[list[str]] = []

    def exec_run(self, command: list[str]):
        self.commands.append(command)
        return SimpleNamespace(exit_code=0, output=self.archive)


class AgentHelpersTest(unittest.TestCase):
    def test_installed_agent_passes_prompt_dump_env(self) -> None:
        with unittest.mock.patch.dict(
            "os.environ",
            {
                "OPENROUTER_API_KEY": "openrouter-key",
                "KESTREL_MODEL_PROMPT_DUMP": "1",
                "KESTREL_MODEL_PROMPT_DUMP_DIR": "/host/path/should-not-pass",
            },
            clear=True,
        ):
            env = KestrelTerminalBenchAgent()._env

        self.assertEqual(env["OPENROUTER_API_KEY"], "openrouter-key")
        self.assertEqual(env["KESTREL_MODEL_PROMPT_DUMP"], "1")
        self.assertNotIn("KESTREL_MODEL_PROMPT_DUMP_DIR", env)

    def test_installed_agent_forwards_runner_benchmark_model_env(self) -> None:
        with unittest.mock.patch.dict(
            "os.environ",
            {
                "OPENROUTER_API_KEY": "openrouter-key",
                "OPENROUTER_MODEL": "outer/model",
                "KESTREL_BENCHMARK_MODEL_PROVIDER": "openrouter",
                "KESTREL_BENCHMARK_MODEL": "runner/model",
                "KESTREL_BENCHMARK_CREDENTIAL_ENV": "OPENROUTER_API_KEY",
                "KESTREL_BENCHMARK_CREDENTIAL_FINGERPRINT": "abc123",
            },
            clear=True,
        ):
            env = KestrelTerminalBenchAgent()._env

        self.assertEqual(env["OPENROUTER_MODEL"], "outer/model")
        self.assertEqual(env["KESTREL_BENCHMARK_MODEL_PROVIDER"], "openrouter")
        self.assertEqual(env["KESTREL_BENCHMARK_MODEL"], "runner/model")
        self.assertEqual(env["KESTREL_BENCHMARK_CREDENTIAL_ENV"], "OPENROUTER_API_KEY")
        self.assertEqual(env["KESTREL_BENCHMARK_CREDENTIAL_FINGERPRINT"], "abc123")

    def test_setup_script_validates_cli_runtime_dependencies(self) -> None:
        setup_script = (Path(__file__).parent / "setup.sh").read_text(encoding="utf-8")

        self.assertIn("nodejs npm", setup_script)
        self.assertIn("python3-pytest", setup_script)
        self.assertIn("npm install -g node@22.23.1 pnpm@9.12.2", setup_script)
        self.assertIn('node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)\'', setup_script)
        self.assertIn("CI=true pnpm install --frozen-lockfile --prod=false", setup_script)
        self.assertIn("pnpm --filter @kestrel-agents/protocol run build:self", setup_script)
        self.assertIn('node -e \'require.resolve("tsx")\'', setup_script)
        self.assertIn('node -e \'require.resolve("@kestrel-agents/protocol")\'', setup_script)

    def test_setup_script_provides_pytest_uv_fallback_for_task_verifiers(self) -> None:
        setup_script = (Path(__file__).parent / "setup.sh").read_text(encoding="utf-8")

        self.assertIn("cat >/usr/local/bin/uv <<'UV_SHIM'", setup_script)
        self.assertIn('PYTHON_BIN="${UV_SHIM_PYTHON:-/usr/bin/python3}"', setup_script)
        self.assertIn('"${PYTHON_BIN}" -m pytest', setup_script)
        self.assertIn("uv compatibility shim supports: init, add, run", setup_script)

    def test_setup_script_avoids_nodesource_for_verifier_stability(self) -> None:
        setup_script = (Path(__file__).parent / "setup.sh").read_text(encoding="utf-8")

        self.assertNotIn("deb.nodesource.com", setup_script)
        self.assertNotIn("nodesource.list", setup_script)
        self.assertNotIn("nodesource.sources", setup_script)

    def test_installed_agent_executes_setup_script_without_sourcing(self) -> None:
        agent_source = (Path(__file__).parent / "agents.py").read_text(encoding="utf-8")

        self.assertIn("bash /installed-agent/install-agent.sh || echo 'INSTALL_FAIL_STATUS'", agent_source)
        self.assertNotIn("source /installed-agent/install-agent.sh || echo 'INSTALL_FAIL_STATUS'", agent_source)

    def test_read_installed_agent_file_ignores_failed_exec_output(self) -> None:
        session = FakeSession(FakeContainer(1, b"exec /usr/bin/bash: input/output error\n"))

        self.assertEqual(read_installed_agent_file(session, "/installed-agent/kestrel-cli-result.json"), "")

    def test_read_installed_agent_file_returns_successful_output(self) -> None:
        session = FakeSession(FakeContainer(0, b'{"status":"completed"}\n'))

        self.assertEqual(
            read_installed_agent_file(session, "/installed-agent/kestrel-cli-result.json"),
            '{"status":"completed"}\n',
        )

    def test_parse_cli_result_returns_none_for_invalid_marker_payload(self) -> None:
        self.assertIsNone(parse_cli_result("KESTREL_TBENCH_RESULT_JSON_BASE64:bm90LWpzb24="))

    def test_deadline_helpers_use_terminal_bench_timeout(self) -> None:
        with unittest.mock.patch("time.monotonic", return_value=12.0):
            with unittest.mock.patch("time.time", return_value=100.0):
                self.assertEqual(compute_external_deadline_ms(started_at=10.0, timeout_sec=60.0), 158_000)

        with unittest.mock.patch.dict("os.environ", {"KESTREL_TBENCH_CLI_COMMAND_TIMEOUT_SEC": "7200"}, clear=True):
            with unittest.mock.patch("time.monotonic", return_value=12.0):
                self.assertEqual(effective_wait_timeout_sec(started_at=10.0, timeout_sec=60.0), 58.0)

        prefix = build_deadline_env_prefix(60.0, 158_000)
        self.assertIn("KESTREL_TBENCH_AGENT_TIMEOUT_SEC=60.0", prefix)
        self.assertIn("KESTREL_EXTERNAL_DEADLINE_MS=158000", prefix)

    def test_deadline_helpers_read_cached_task_timeout_when_terminal_bench_omits_it(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task_dir = Path(raw_dir) / "terminal-bench-core" / "0.1.1" / "build-initramfs-qemu"
            task_dir.mkdir(parents=True)
            (task_dir / "task.yaml").write_text("max_agent_timeout_sec: 360.0\n", encoding="utf-8")

            with unittest.mock.patch.dict("os.environ", {"KESTREL_TBENCH_CACHE_ROOT": raw_dir}, clear=True):
                self.assertEqual(resolve_agent_timeout_sec("build-initramfs-qemu"), 360.0)
                self.assertEqual(resolve_agent_timeout_sec("build-initramfs-qemu", 90.0), 90.0)

    def test_installed_agent_helpers_are_made_readable_for_unprivileged_processes(self) -> None:
        session = FakeSession(FakeContainer(0, b""))

        ensure_installed_agent_helpers_readable(session)

        command = session.container.commands[-1]
        self.assertEqual(command[:2], ["sh", "-c"])
        self.assertIn("chmod a+r", command[2])
        self.assertIn("/installed-agent/cli_task_runner.py", command[2])
        self.assertIn("/installed-agent/container_devshell_bridge.py", command[2])
        self.assertIn("/installed-agent/job_input.py", command[2])
        self.assertIn("/installed-agent/kestrel_devshell.py", command[2])

    def test_wait_for_cli_result_marker_syncs_runtime_logs_before_returning(self) -> None:
        session = FakeSession(
            FileBackedContainer(
                {
                    "/logs/agent.log": "",
                    "/installed-agent/kestrel-cli-result.json": '{"status":"failed"}\n',
                    "/installed-agent/kestrel-cli-events.jsonl": '{"type":"run.progress"}\n',
                    "/installed-agent/kestrel-cli-bridge.jsonl": '{"event":"request"}\n',
                }
            )
        )

        with tempfile.TemporaryDirectory() as raw_dir:
            logging_dir = Path(raw_dir)
            captured = wait_for_cli_result_marker(
                session,
                timeout_sec=1,
                logging_dir=logging_dir,
                task_id="blind-maze-explorer-5x5",
                copy_interval_sec=0,
            )

            self.assertIn("KESTREL_TBENCH_RESULT_JSON_BASE64:", captured)
            self.assertEqual(
                (logging_dir / "kestrel-cli-blind-maze-explorer-5x5.events.jsonl").read_text(
                    encoding="utf-8"
                ),
                '{"type":"run.progress"}\n',
            )
            self.assertEqual(
                (logging_dir / "kestrel-cli-blind-maze-explorer-5x5.bridge.jsonl").read_text(
                    encoding="utf-8"
                ),
                '{"event":"request"}\n',
            )

    def test_copy_cli_job_artifacts_records_host_paths(self) -> None:
        session = FakeSession(
            FileBackedContainer(
                {
                    "/tmp/kestrel-home/job-input.json": '{"version":"job_input_v1"}\n',
                    "/tmp/kestrel-home/job-output.json": '{"version":"job_output_v1"}\n',
                }
            )
        )

        with tempfile.TemporaryDirectory() as raw_dir:
            logging_dir = Path(raw_dir)
            result = {
                "job_input_path": "/tmp/kestrel-home/job-input.json",
                "job_output_path": "/tmp/kestrel-home/job-output.json",
            }

            copy_cli_job_artifacts(session, logging_dir, "hello-world", result)

            job_input_path = logging_dir / "kestrel-terminal-bench-hello-world.job-input.json"
            job_output_path = logging_dir / "kestrel-terminal-bench-hello-world.job-output.json"
            self.assertEqual(job_input_path.read_text(encoding="utf-8"), '{"version":"job_input_v1"}\n')
            self.assertEqual(job_output_path.read_text(encoding="utf-8"), '{"version":"job_output_v1"}\n')
            self.assertEqual(result["job_input_path"], str(job_input_path))
            self.assertEqual(result["job_output_path"], str(job_output_path))

    def test_copy_cli_prompt_dumps_extracts_prompt_archive(self) -> None:
        with tempfile.TemporaryDirectory() as source_dir:
            source = Path(source_dir)
            (source / "session-1" / "run-1").mkdir(parents=True)
            (source / "session-1" / "run-1" / "step-00001-call-abc.json").write_text(
                '{"request":{"messages":[]}}\n',
                encoding="utf-8",
            )
            archive_path = source / "prompts.tar.gz"
            with tarfile.open(archive_path, "w:gz") as tar:
                tar.add(source / "session-1", arcname="session-1")
            archive = archive_path.read_bytes()

        session = FakeSession(PromptDumpContainer(archive))
        with tempfile.TemporaryDirectory() as raw_dir:
            copied = copy_cli_prompt_dumps(session, Path(raw_dir))

            self.assertEqual(copied, Path(raw_dir) / "kestrel-model-prompts")
            self.assertTrue(
                (Path(raw_dir) / "kestrel-model-prompts" / "session-1" / "run-1" / "step-00001-call-abc.json").exists()
            )


if __name__ == "__main__":
    unittest.main()
