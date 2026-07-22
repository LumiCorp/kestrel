from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from io import StringIO
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from .cli_task_runner import (
    MODEL_CONTRACT_CANNOT_SATISFY_FAILURE_KIND,
    TERMINAL_BENCH_ENTRY_STEP_AGENT,
    TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND,
    bridge_process_traffic,
    build_job_input,
    build_profile,
    classify_cli_failure_kind,
    completion_attempt_packets_from_text,
    effective_runtime_deadline_ms,
    effective_runtime_timeout_sec,
    emit_progress,
    failure_details_payload,
    latest_process_failure,
    missing_required_output_paths,
    parse_benchmark_contract_failure,
    parse_event_log_identity,
    parse_event_log_terminal_status,
    parse_job_error,
    parse_job_terminal_status,
    resolve_workspace_root,
    runtime_identity_payload,
    result_adapter,
    result_dataset,
    result_status_and_failure_kind,
    write_debug_job_output,
)
from .job_input import (
    TERMINAL_BENCH_REQUIRED_PROFILE_TOOLS,
    assert_terminal_bench_job_input_contract,
    build_terminal_bench_profile,
    terminal_bench_job_input_contract_hash,
)
from .provider_config import (
    assert_benchmark_profile_mode,
    assert_benchmark_turn_mode,
    benchmark_guardrails,
    benchmark_provider_artifact_payload,
    benchmark_profile_mode,
    benchmark_turn_mode,
)


WRAPPER_PROMPT_PHRASES = (
    "Kestrel runner guidance",
    "current container",
    "task workspace root",
    "Use Kestrel tools",
    "KESTREL_MANAGED_ENTRYPOINTS_JSON",
    "managed task entrypoints",
    "kestrel_devshell.start",
    "finalize with a concise summary",
    "External harness deadline",
)


class CliTaskRunnerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.env_patch = mock.patch.dict("os.environ", {"OPENROUTER_API_KEY": "sk-test"}, clear=False)
        self.env_patch.start()

    def tearDown(self) -> None:
        self.env_patch.stop()

    def test_job_input_starts_at_live_agent_loop(self) -> None:
        job_input = build_job_input("Solve it.", "sample-task")

        self.assertEqual(TERMINAL_BENCH_ENTRY_STEP_AGENT, "agent.loop")
        self.assertEqual(job_input["turn"]["stepAgent"], "agent.loop")
        assert_terminal_bench_job_input_contract(job_input)

    def test_profile_uses_canonical_build_mode(self) -> None:
        profile = build_profile()

        self.assertEqual(profile["defaultInteractionMode"], benchmark_profile_mode()["defaultInteractionMode"])
        self.assertEqual(profile["defaultActSubmode"], benchmark_profile_mode()["defaultActSubmode"])
        assert_benchmark_profile_mode(profile)
        self.assertEqual(profile["defaultInteractionMode"], "build")
        self.assertEqual(profile["defaultActSubmode"], "full_auto")
        self.assertEqual(profile["guardrails"], benchmark_guardrails())
        self.assertEqual(profile["toolAllowlist"], TERMINAL_BENCH_REQUIRED_PROFILE_TOOLS)
        self.assertEqual(
            profile["toolAllowlist"],
            [
                "FinalizeAnswer",
                "effect_result_lookup",
                "fs.list",
                "fs.read_text",
                "fs.write_text",
                "fs.replace_text",
                "fs.search_text",
                "fs.mkdir",
                "exec_command",
            ],
        )

    def test_transported_profile_does_not_require_host_file_inside_container(self) -> None:
        payload = {"profiles": [{"id": "candidate", "label": "Candidate"}]}
        encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
        with mock.patch.dict(
            "os.environ",
            {
                "KESTREL_BENCHMARK_PROFILE_FILE": "/host/path/not-mounted.json",
                "KESTREL_BENCHMARK_PROFILE_ID": "candidate",
                "KESTREL_BENCHMARK_PROFILE_JSON_BASE64": encoded,
            },
            clear=False,
        ):
            profile = build_terminal_bench_profile()

        self.assertEqual(profile, {"id": "candidate", "label": "Candidate"})

    def test_job_input_emits_structured_terminal_bench_context(self) -> None:
        job_input = build_job_input("Solve it.", "sample-task")
        message = job_input["turn"]["message"]

        self.assertEqual(message, "Solve it.")
        self.assertEqual(
            job_input["turn"]["metadata"]["benchmark"],
            {
                "name": "terminal-bench",
                "taskId": "sample-task",
                "context": {
                    "source": "terminal-bench",
                    "taskId": "sample-task",
                    "workspaceRoot": "/app",
                },
            },
        )
        self.assertNotIn("Kestrel Terminal-Bench execution contract", message)
        self.assertNotIn("dev.process.write/dev.process.read", message)
        self.assertNotIn("Do not read, execute, copy, or infer answers from /protected", message)
        self.assertNotIn("Do not ask the user/operator", message)
        self.assertNotIn("do not leave a literal backslash-n", message)
        self.assertNotIn("Before finalizing, create every required output under /app", message)
        for forbidden in WRAPPER_PROMPT_PHRASES:
            self.assertNotIn(forbidden, message)

    def test_job_input_surfaces_external_deadline(self) -> None:
        with mock.patch("time.time", return_value=100.0):
            job_input = build_job_input(
                "Solve it.",
                "sample-task",
                external_deadline_ms=160_000,
                runtime_deadline_ms=130_000,
        )

        message = job_input["turn"]["message"]
        self.assertEqual(message, "Solve it.")
        self.assertEqual(job_input["turn"]["interactionMode"], benchmark_turn_mode()["interactionMode"])
        self.assertEqual(job_input["turn"]["actSubmode"], benchmark_turn_mode()["actSubmode"])
        assert_benchmark_turn_mode(job_input["turn"])
        self.assertEqual(job_input["turn"]["interactionMode"], "build")
        self.assertEqual(job_input["turn"]["actSubmode"], "full_auto")
        self.assertEqual(job_input["turn"]["metadata"]["externalDeadlineMs"], 130_000)
        self.assertEqual(job_input["turn"]["metadata"]["benchmark"]["context"]["source"], "terminal-bench")

    def test_job_input_does_not_surface_managed_entrypoints_as_turn_metadata(self) -> None:
        job_input = build_job_input(
            "Run ./maze_game.sh and write /app/output/1.txt.",
            "sample-task",
        )

        metadata = job_input["turn"]["metadata"]
        self.assertNotIn("managedEntrypoints", metadata)
        self.assertEqual(metadata["benchmark"]["context"]["workspaceRoot"], "/app")
        self.assertEqual(metadata["workspace"]["managedWorktreeRequired"], False)
        self.assertNotIn("scratchpadPath", metadata["workspace"])
        self.assertNotIn("KESTREL_MANAGED_ENTRYPOINTS_JSON", job_input["turn"]["message"])
        self.assertNotIn("kestrel_devshell.start", job_input["turn"]["message"])

    def test_job_input_uses_resolved_workspace_root(self) -> None:
        job_input = build_job_input("Solve it.", "sample-task", workspace_root="/workspace")

        self.assertEqual(job_input["turn"]["metadata"]["workspace"]["workspaceRoot"], "/workspace")
        self.assertEqual(job_input["turn"]["metadata"]["benchmark"]["context"]["workspaceRoot"], "/workspace")
        self.assertEqual(len(terminal_bench_job_input_contract_hash(job_input)), 64)

    def test_workspace_root_prefers_existing_app_directory(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            with mock.patch("benchmarks.terminal_bench.cli_task_runner.Path.is_dir", return_value=True):
                self.assertEqual(resolve_workspace_root(), "/app")

    def test_workspace_root_falls_back_to_current_workdir_when_app_is_missing(self) -> None:
        def fake_is_dir(path: Path) -> bool:
            return str(path) == "/workspace"

        with mock.patch.dict("os.environ", {}, clear=True):
            with mock.patch("benchmarks.terminal_bench.cli_task_runner.Path.cwd", return_value=Path("/workspace")):
                with mock.patch("benchmarks.terminal_bench.cli_task_runner.Path.is_dir", fake_is_dir):
                    self.assertEqual(resolve_workspace_root(), "/workspace")

    def test_workspace_root_uses_existing_env_override(self) -> None:
        def fake_is_dir(path: Path) -> bool:
            return str(path) == "/work"

        with mock.patch.dict("os.environ", {"KESTREL_TBENCH_WORKSPACE_ROOT": "/work"}, clear=True):
            with mock.patch("benchmarks.terminal_bench.cli_task_runner.Path.is_dir", fake_is_dir):
                self.assertEqual(resolve_workspace_root(), "/work")

    def test_result_labels_can_be_overridden_for_harbor_lane(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                "KESTREL_TBENCH_RESULT_ADAPTER": "harbor-cli",
                "KESTREL_TBENCH_RESULT_DATASET": "terminal-bench@2.0",
            },
            clear=True,
        ):
            self.assertEqual(result_adapter(), "harbor-cli")
            self.assertEqual(result_dataset(), "terminal-bench@2.0")

    def test_result_adapter_defaults_to_canonical_job_run(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(result_adapter(), "kestrel-terminal-bench")

    def test_runtime_timeout_uses_external_deadline_reserve(self) -> None:
        with mock.patch.dict("os.environ", {"KESTREL_TBENCH_RUN_TIMEOUT_SEC": "7200"}, clear=True):
            with mock.patch("time.time", return_value=100.0):
                self.assertEqual(effective_runtime_timeout_sec(160_000), 30.0)

    def test_runtime_deadline_uses_external_deadline_reserve(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            with mock.patch("time.time", return_value=100.0):
                self.assertEqual(effective_runtime_deadline_ms(160_000), 130_000)

    def test_profile_uses_openrouter_model_for_all_stage_defaults(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {"OPENROUTER_API_KEY": "sk-test", "OPENROUTER_MODEL": "openai/gpt-5.4-mini"},
            clear=True,
        ):
            profile = build_profile()

        model_by_stage = profile["agentStageConfig"]["modelByStage"]
        self.assertEqual(profile["modelProvider"], "openrouter")
        self.assertEqual(profile["model"], "openai/gpt-5.4-mini")
        self.assertEqual(model_by_stage["agent.loop"], "openai/gpt-5.4-mini")
        self.assertNotIn("react.extractor", model_by_stage)

    def test_profile_prefers_runner_normalized_benchmark_model(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                "OPENROUTER_API_KEY": "sk-test",
                "OPENROUTER_MODEL": "outer/model",
                "KESTREL_BENCHMARK_MODEL_PROVIDER": "openrouter",
                "KESTREL_BENCHMARK_MODEL": "runner/model",
            },
            clear=True,
        ):
            profile = build_profile()
            artifact_payload = benchmark_provider_artifact_payload()

        model_by_stage = profile["agentStageConfig"]["modelByStage"]
        self.assertEqual(profile["modelProvider"], "openrouter")
        self.assertEqual(profile["model"], "runner/model")
        self.assertEqual(model_by_stage["agent.loop"], "runner/model")
        self.assertEqual(artifact_payload["model"], "runner/model")

    def test_profile_defaults_to_openrouter_model_without_model_override(self) -> None:
        with mock.patch.dict("os.environ", {"OPENROUTER_API_KEY": "sk-test"}, clear=True):
            profile = build_profile()

        model_by_stage = profile["agentStageConfig"]["modelByStage"]
        self.assertEqual(profile["modelProvider"], "openrouter")
        self.assertEqual(profile["model"], "z-ai/glm-5.2")
        self.assertEqual(model_by_stage["agent.loop"], "z-ai/glm-5.2")

    def test_profile_rejects_deprecated_tbench_model_alias(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                "OPENROUTER_API_KEY": "sk-test",
                "KESTREL_TBENCH_MODEL": "gpt-4.1-mini",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "Deprecated benchmark env KESTREL_TBENCH_MODEL"):
                build_profile()

    def test_profile_exposes_filesystem_tools_for_source_authoring(self) -> None:
        profile = build_profile()

        allowlist = profile["toolAllowlist"]
        self.assertIn("fs.write_text", allowlist)
        self.assertIn("fs.read_text", allowlist)
        self.assertIn("fs.replace_text", allowlist)
        self.assertIn("exec_command", allowlist)
        self.assertNotIn("dev.shell.run", allowlist)
        self.assertNotIn("dev.process.start", allowlist)
        self.assertNotIn("dev.process.write", allowlist)
        self.assertNotIn("dev.process.read", allowlist)
        self.assertNotIn("dev.process.stop", allowlist)

    def test_profile_requires_openrouter_key(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "OPENROUTER_API_KEY"):
                build_profile()

    def test_profile_rejects_deprecated_provider_alias(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                "OPENROUTER_API_KEY": "sk-test",
                "KESTREL_TBENCH_MODEL_PROVIDER": "openrouter",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "Deprecated benchmark env KESTREL_TBENCH_MODEL_PROVIDER"):
                build_profile()

    def test_profile_rejects_non_openrouter_runner_model_provider(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {
                "OPENROUTER_API_KEY": "sk-test",
                "KESTREL_BENCHMARK_MODEL_PROVIDER": "anthropic",
                "KESTREL_BENCHMARK_MODEL": "anthropic/claude",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "KESTREL_BENCHMARK_MODEL_PROVIDER=anthropic"):
                build_profile()

    def test_emit_progress_writes_visible_wrapper_marker(self) -> None:
        output = StringIO()

        emit_progress("launching Kestrel runtime", stdout=output)

        self.assertEqual(output.getvalue(), "KESTREL_TBENCH_PROGRESS: launching Kestrel runtime\n")

    def test_parse_event_log_identity_reads_single_runtime_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            event_log = Path(tmp) / "events.jsonl"
            event_log.write_text(
                "\n".join(
                    [
                        json_line(
                            {
                                "runId": "run-1",
                                "sessionId": "session-1",
                                "threadId": "thread-1",
                                "payload": {
                                    "update": {
                                        "runId": "run-1",
                                        "sessionId": "session-1",
                                    }
                                },
                            }
                        ),
                        json_line(
                            {
                                "payload": {
                                    "entry": {
                                        "runId": "run-1",
                                        "sessionId": "session-1",
                                    }
                                }
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                parse_event_log_identity(event_log),
                {
                    "kestrel_run_id": "run-1",
                    "kestrel_session_id": "session-1",
                    "kestrel_thread_id": "thread-1",
                },
            )

    def test_runtime_identity_payload_falls_back_to_event_log_on_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            missing_job_output = tmp_path / "job-output.json"
            event_log = tmp_path / "events.jsonl"
            event_log.write_text(
                json_line({"runId": "run-timeout", "sessionId": "session-timeout"}) + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runtime_identity_payload(missing_job_output, event_log),
                {
                    "kestrel_run_id": "run-timeout",
                    "kestrel_session_id": "session-timeout",
                },
            )

    def test_parse_job_error_reads_runtime_error_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job_output = Path(tmp) / "job-output.json"
            job_output.write_text(
                json_line(
                    {
                        "version": "job_output_v1",
                        "job": {
                            "error": {
                                "code": "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED",
                                "message": "deadline exhausted",
                                "details": {"remainingMs": 11456},
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                parse_job_error(job_output),
                {
                    "code": "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED",
                    "message": "deadline exhausted",
                    "details": {"remainingMs": 11456},
                },
            )

    def test_parse_job_terminal_status_reads_waiting_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job_output = Path(tmp) / "job-output.json"
            job_output.write_text(
                json_line(
                    {
                        "version": "job_output_v1",
                        "job": {
                            "status": "WAITING",
                            "waitFor": {
                                "eventType": "user.reply",
                                "metadata": {"reason": "max_model_calls_continuation"},
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                parse_job_terminal_status(job_output),
                {
                    "status": "WAITING",
                    "wait_event_type": "user.reply",
                    "wait_reason": "max_model_calls_continuation",
                },
            )

    def test_write_debug_job_output_copies_existing_job_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            job_output = Path(tmp) / "job-output.json"
            destination = Path(tmp) / "kestrel-cli-job-output.json"
            job_output.write_text('{"version":"job_output_v1"}\n', encoding="utf-8")

            write_debug_job_output(job_output, destination)

            self.assertEqual(destination.read_text(encoding="utf-8"), '{"version":"job_output_v1"}\n')

    def test_parse_event_log_terminal_status_reads_waiting_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            event_log = Path(tmp) / "events.jsonl"
            event_log.write_text(
                json_line(
                    {
                        "type": "run.progress",
                        "payload": {
                            "update": {
                                "code": "WAITING_FOR_EVENT",
                                "waitFor": {"eventType": "user.reply"},
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                parse_event_log_terminal_status(event_log),
                {"status": "WAITING", "waitForEventType": "user.reply"},
            )

    def test_completion_attempt_packet_extracts_missing_required_outputs(self) -> None:
        text = "\n".join(
            [
                "noise",
                "COMPLETION_ATTEMPT_PACKET_START",
                json_line(
                    {
                        "required_output_paths": ["/app/output/1.txt", "/app/output/2.txt"],
                        "artifacts_written": ["/app/output/1.txt"],
                        "producer_status": "failure",
                    }
                ),
                "COMPLETION_ATTEMPT_PACKET_END",
            ]
        )

        packets = completion_attempt_packets_from_text(text)

        self.assertEqual(len(packets), 1)
        self.assertEqual(missing_required_output_paths(packets[0]), ["/app/output/2.txt"])
        self.assertEqual(classify_cli_failure_kind({"completion_attempt": packets[0]}), "task_producer_failed")

    def test_failure_details_reports_missing_required_artifact_without_instruction_parsing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            event_log = root / "events.jsonl"
            bridge_log = root / "bridge.jsonl"
            event_log.write_text(
                json_line(
                    {
                        "type": "run.log",
                        "payload": {
                            "entry": {
                                "eventName": "decision_executed",
                                "stepIndex": 12,
                                "metadata": {
                                    "toolName": "exec_command",
                                },
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            bridge_log.write_text(
                json_line(
                    {
                        "event": "response",
                        "ts": "2026-07-08T18:18:37.000Z",
                        "payload": {
                            "status": "COMPLETED",
                            "command": "python /tmp/probe.py",
                            "changedFiles": [],
                        },
                    }
                ),
                encoding="utf-8",
            )

            details = failure_details_payload(
                root / "job-output.json",
                event_log,
                bridge_log,
                "",
                filesystem_root=root,
                required_artifacts=["/app/program.py"],
            )

            self.assertEqual(classify_cli_failure_kind(details), "task_producer_failed")
            self.assertEqual(
                details["attempt_summary"]["required_artifacts_present"],
                {"/app/program.py": False},
            )
            self.assertEqual(details["attempt_summary"]["required_artifact_writes"], [])
            self.assertEqual(details["attempt_summary"]["last_model_tool"], {"tool": "exec_command", "step_index": 12})
            self.assertEqual(details["attempt_summary"]["last_bridge_command_status"]["status"], "COMPLETED")

    def test_failed_completion_packet_marks_clean_runtime_exit_failed(self) -> None:
        self.assertEqual(
            result_status_and_failure_kind(
                0,
                {
                    "completion_attempt": {
                        "producer_status": "failure",
                        "blockers": ["internal deadline exceeded"],
                    }
                },
            ),
            ("failed", "task_producer_failed"),
        )
        self.assertEqual(
            result_status_and_failure_kind(
                0,
                {
                    "completion_attempt": {
                        "producer_status": "success",
                        "artifacts_written": ["/app/output/1.txt", "/app/output/2.txt"],
                        "required_output_paths": [
                            "/app/output/1.txt",
                            "/app/output/2.txt",
                            "/app/output/3.txt",
                        ],
                    },
                    "missing_required_output_paths": ["/app/output/3.txt"],
                },
            ),
            ("failed", "task_producer_failed"),
        )
        self.assertEqual(
            result_status_and_failure_kind(
                0,
                {"runtime_terminal_status": {"status": "WAITING", "waitForEventType": "user.reply"}},
            ),
            ("failed", "runtime_waiting_for_user"),
        )
        self.assertEqual(
            result_status_and_failure_kind(
                0,
                {"interactive_process_traffic": {"movement_write_count": 3}},
            ),
            ("completed", "none"),
        )
        self.assertEqual(result_status_and_failure_kind(1, {}), ("failed", "kestrel_run_failed"))

    def test_provider_rate_limit_is_external_failure_kind(self) -> None:
        self.assertEqual(
            result_status_and_failure_kind(
                1,
                {
                    "runtime_error": {
                        "code": "MODEL_RATE_LIMITED",
                        "message": "insufficient quota",
                    }
                },
            ),
            ("failed", "provider_rate_limited"),
        )

    def test_benchmark_contract_failure_marks_cli_result_failed(self) -> None:
        self.assertEqual(
            result_status_and_failure_kind(
                0,
                {
                    "benchmark_contract_failure": {
                        "kind": TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND,
                        "source": "event_log",
                    }
                },
            ),
            ("failed", TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND),
        )
        self.assertEqual(
            result_status_and_failure_kind(
                0,
                {
                    "benchmark_contract_failure": {
                        "kind": MODEL_CONTRACT_CANNOT_SATISFY_FAILURE_KIND,
                        "source": "event_log",
                    }
                },
            ),
            ("failed", MODEL_CONTRACT_CANNOT_SATISFY_FAILURE_KIND),
        )

    def test_benchmark_contract_failure_takes_priority_over_later_runtime_error(self) -> None:
        self.assertEqual(
            result_status_and_failure_kind(
                1,
                {
                    "benchmark_contract_failure": {
                        "kind": TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND,
                        "source": "event_log",
                    },
                    "runtime_error": {
                        "code": "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED",
                        "message": "deadline exhausted",
                    },
                },
            ),
            ("failed", TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND),
        )

    def test_parse_benchmark_contract_failure_ignores_protected_path_in_file_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            event_log = tmp_path / "events.jsonl"
            bridge_log = tmp_path / "bridge.jsonl"
            event_log.write_text(
                json_line(
                    {
                        "payload": {
                            "update": {
                                "toolName": "fs.write_text",
                                "input": {
                                    "path": "/app/generate_maze_map.py",
                                    "content": "subprocess.run(['python3', '/protected/maze_helper.py'])",
                                },
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            bridge_log.write_text("", encoding="utf-8")

            self.assertEqual(
                parse_benchmark_contract_failure(event_log, bridge_log),
                {},
            )

    def test_parse_benchmark_contract_failure_classifies_direct_protected_path_tool_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            event_log = tmp_path / "events.jsonl"
            bridge_log = tmp_path / "bridge.jsonl"
            event_log.write_text(
                json_line(
                    {
                        "payload": {
                            "update": {
                                "toolName": "exec_command",
                                "input": {
                                    "command": "python3 /protected/maze_helper.py",
                                },
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            bridge_log.write_text("", encoding="utf-8")

            self.assertEqual(
                parse_benchmark_contract_failure(event_log, bridge_log),
                {
                    "kind": TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND,
                    "source": "event_log",
                },
            )

    def test_parse_benchmark_contract_failure_classifies_direct_protected_path_file_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            event_log = tmp_path / "events.jsonl"
            bridge_log = tmp_path / "bridge.jsonl"
            event_log.write_text(
                json_line(
                    {
                        "payload": {
                            "update": {
                                "toolName": "fs.read_text",
                                "input": {
                                    "path": "/protected/maze_helper.py",
                                },
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            bridge_log.write_text("", encoding="utf-8")

            self.assertEqual(
                parse_benchmark_contract_failure(event_log, bridge_log),
                {
                    "kind": TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND,
                    "source": "event_log",
                },
            )

    def test_parse_benchmark_contract_failure_ignores_final_message_protected_path_mention(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            event_log = tmp_path / "events.jsonl"
            bridge_log = tmp_path / "bridge.jsonl"
            event_log.write_text(
                json_line(
                    {
                        "payload": {
                            "update": {
                                "toolName": "FinalizeAnswer",
                                "input": {
                                    "message": "The public test could not use /protected/maze_helper.py.",
                                },
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            bridge_log.write_text("", encoding="utf-8")

            self.assertEqual(parse_benchmark_contract_failure(event_log, bridge_log), {})

    def test_parse_benchmark_contract_failure_classifies_blocked_protected_path_bridge_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            event_log = tmp_path / "events.jsonl"
            bridge_log = tmp_path / "bridge.jsonl"
            event_log.write_text("", encoding="utf-8")
            bridge_log.write_text(
                json_line(
                    {
                        "event": "response",
                        "payload": {
                            "securityMode": "blocked_protected_path",
                            "text": "Terminal-Bench protected path is not available to agent shell commands\n",
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                parse_benchmark_contract_failure(event_log, bridge_log),
                {
                    "kind": TERMINAL_BENCH_PROTECTED_PATH_FAILURE_KIND,
                    "source": "bridge_log",
                },
            )

    def test_public_test_protected_denial_is_diagnostic_not_contract_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            job_output = tmp_path / "job-output.json"
            event_log = tmp_path / "events.jsonl"
            bridge_log = tmp_path / "bridge.jsonl"
            event_log.write_text("", encoding="utf-8")
            bridge_log.write_text(
                json_line(
                    {
                        "event": "response",
                        "payload": {
                            "command": "cd /app && TEST_DIR=tests uv run pytest tests/test_outputs.py -rA",
                            "status": "COMPLETED",
                            "exitCode": 0,
                            "stdout": "python3: can't open file '/protected/maze_helper.py': Permission denied\n",
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(parse_benchmark_contract_failure(event_log, bridge_log), {})
            details = failure_details_payload(job_output, event_log, bridge_log, "")
            self.assertNotIn("benchmark_contract_failure", details)
            self.assertEqual(
                details.get("protected_path_denial_observed_in_output"),
                {
                    "kind": "protected_path_denial_observed_in_output",
                    "source": "bridge_log",
                },
            )
            self.assertEqual(result_status_and_failure_kind(0, details), ("completed", "none"))

    def test_parse_benchmark_contract_failure_classifies_cannot_satisfy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            event_log = tmp_path / "events.jsonl"
            bridge_log = tmp_path / "bridge.jsonl"
            event_log.write_text(
                json_line(
                    {
                        "payload": {
                            "entry": {
                                "metadata": {
                                    "decisionCode": "cannot_satisfy",
                                    "next": {
                                        "nextAction": {
                                            "kind": "cannot_satisfy",
                                        },
                                    },
                                },
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            bridge_log.write_text("", encoding="utf-8")

            self.assertEqual(
                parse_benchmark_contract_failure(event_log, bridge_log),
                {
                    "kind": MODEL_CONTRACT_CANNOT_SATISFY_FAILURE_KIND,
                    "source": "event_log",
                },
            )

    def test_failure_details_payload_combines_runtime_error_and_completion_packet(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            job_output = tmp_path / "job-output.json"
            event_log = tmp_path / "events.jsonl"
            bridge_log = tmp_path / "bridge.jsonl"
            job_output.write_text(
                json_line(
                    {
                        "version": "job_output_v1",
                        "job": {
                            "error": {
                                "code": "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED",
                                "message": "deadline exhausted",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            event_log.write_text("", encoding="utf-8")
            (tmp_path / "app" / "output").mkdir(parents=True)
            (tmp_path / "app" / "output" / "1.txt").write_text("ok\n", encoding="utf-8")
            bridge_log.write_text(
                json_line(
                    {
                        "event": "response",
                        "payload": {
                            "stdout": "\n".join(
                                [
                                    "COMPLETION_ATTEMPT_PACKET_START",
                                    json_line(
                                        {
                                            "required_output_paths": ["/app/output/1.txt", "/app/output/2.txt"],
                                            "artifacts_written": ["/app/output/1.txt"],
                                            "producer_status": "failure",
                                            "blockers": ["maze 2: internal deadline exceeded"],
                                        }
                                    ),
                                    "COMPLETION_ATTEMPT_PACKET_END",
                                ]
                            )
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            details = failure_details_payload(job_output, event_log, bridge_log, "", filesystem_root=tmp_path)

            self.assertEqual(classify_cli_failure_kind(details), "runtime_external_deadline_exhausted")
            self.assertEqual(details["runtime_error"]["code"], "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED")
            self.assertEqual(details["missing_required_output_paths"], ["/app/output/2.txt"])
            self.assertEqual(details["completion_attempt"]["blockers"], ["maze 2: internal deadline exceeded"])

    def test_bridge_process_traffic_counts_interactive_round_trips(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge_log = Path(tmp) / "bridge.jsonl"
            bridge_log.write_text(
                "\n".join(
                    [
                        json_line(
                            {
                                "event": "response",
                                "payload": {
                                    "processId": "proc-1",
                                    "command": "./maze_game.sh 1",
                                    "startedAt": "2026-06-11T23:30:40.000Z",
                                },
                            }
                        ),
                        json_line(
                            {
                                "event": "request",
                                "path": "/processes/proc-1/write",
                                "body": {"data": "move N\n"},
                            }
                        ),
                        json_line(
                            {
                                "event": "request",
                                "path": "/processes/proc-1/read",
                                "body": {},
                            }
                        ),
                        json_line(
                            {
                                "event": "response",
                                "payload": {
                                    "processId": "proc-2",
                                    "command": "./maze_game.sh 2",
                                    "startedAt": "2026-06-11T23:31:00.000Z",
                                },
                            }
                        ),
                        json_line(
                            {
                                "event": "request",
                                "path": "/processes/proc-2/write",
                                "body": {"data": "move N & E\n"},
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            traffic = bridge_process_traffic(bridge_log)

            self.assertEqual(traffic["process_count"], 2)
            self.assertEqual(traffic["write_count"], 2)
            self.assertEqual(traffic["read_count"], 1)
            self.assertEqual(traffic["movement_write_count"], 2)
            self.assertEqual(traffic["single_step_movement_write_count"], 1)
            self.assertEqual(traffic["batch_movement_write_count"], 1)
            self.assertEqual(
                traffic["processes"],
                [
                    {
                        "process_id": "proc-1",
                        "command": "./maze_game.sh 1",
                        "started_at": "2026-06-11T23:30:40.000Z",
                        "write_count": 1,
                        "read_count": 1,
                        "movement_write_count": 1,
                        "single_step_movement_write_count": 1,
                    },
                    {
                        "process_id": "proc-2",
                        "command": "./maze_game.sh 2",
                        "started_at": "2026-06-11T23:31:00.000Z",
                        "write_count": 1,
                        "movement_write_count": 1,
                        "batch_movement_write_count": 1,
                    },
                ],
            )

    def test_missing_required_outputs_prefers_filesystem_state_over_stale_packet(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output_dir = root / "app" / "output"
            output_dir.mkdir(parents=True)
            (output_dir / "1.txt").write_text("ok\n", encoding="utf-8")
            (output_dir / "2.txt").write_text("ok\n", encoding="utf-8")
            packet = {
                "required_output_paths": [
                    "/app/output/1.txt",
                    "/app/output/2.txt",
                    "/app/output/3.txt",
                ],
                "artifacts_written": ["/app/output/1.txt"],
                "producer_status": "failure",
            }

            self.assertEqual(
                missing_required_output_paths(packet, filesystem_root=root),
                ["/app/output/3.txt"],
            )

    def test_latest_process_failure_reads_final_bridge_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge_log = Path(tmp) / "bridge.jsonl"
            bridge_log.write_text(
                "\n".join(
                    [
                        json_line(
                            {
                                "event": "response",
                                "payload": {
                                    "command": "python3 /app/maze_solver.py",
                                    "status": "FAILED",
                                    "exitCode": 1,
                                    "failureReason": "first failure",
                                    "completedAt": "2026-06-11T22:10:35.000Z",
                                },
                            }
                        ),
                        json_line(
                            {
                                "event": "response",
                                "payload": {
                                    "command": "python3 /app/maze_solver.py",
                                    "status": "FAILED",
                                    "exitCode": 124,
                                    "failureReason": "dev.shell.run timed out after 309244 ms and killed the process.",
                                    "startedAt": "2026-06-11T22:11:15.000Z",
                                    "completedAt": "2026-06-11T22:16:25.000Z",
                                },
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                latest_process_failure("", bridge_log),
                {
                    "command": "python3 /app/maze_solver.py",
                    "status": "FAILED",
                    "exit_code": 124,
                    "failure_reason": "dev.shell.run timed out after 309244 ms and killed the process.",
                    "started_at": "2026-06-11T22:11:15.000Z",
                    "completed_at": "2026-06-11T22:16:25.000Z",
                },
            )


def json_line(record: dict) -> str:
    import json

    return json.dumps(record, sort_keys=True)


if __name__ == "__main__":
    unittest.main()
