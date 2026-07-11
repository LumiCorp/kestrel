from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from .results import (
    DATASET,
    BenchmarkResult,
    failure_kind_for_exception,
    normalize_status,
    task_id_from_logging_dir,
    write_result,
)


class ResultsTest(unittest.TestCase):
    def test_normalize_status(self) -> None:
        self.assertEqual(normalize_status(True), "completed")
        self.assertEqual(normalize_status(False), "failed")
        self.assertEqual(normalize_status(False, timed_out=True), "timeout")

    def test_failure_kind_for_exception(self) -> None:
        self.assertEqual(failure_kind_for_exception("runtime", TimeoutError("expired")), "timeout")
        self.assertEqual(failure_kind_for_exception("runtime", RuntimeError("dev shell bridge failed")), "bridge_failed")
        self.assertEqual(failure_kind_for_exception("cli", RuntimeError("install failed")), "cli_install_failed")
        self.assertEqual(failure_kind_for_exception("cli", RuntimeError("command failed")), "cli_command_failed")

    def test_write_result_omits_nulls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = write_result(
                BenchmarkResult(
                    adapter="runtime",
                    dataset=DATASET,
                    task_id="hello-world",
                    status="completed",
                    duration_ms=12,
                    failure_kind="none",
                    kestrel_run_id="run-1",
                ),
                Path(tmp),
            )
            raw = path.read_text(encoding="utf-8")
            self.assertIn('"kestrel_run_id": "run-1"', raw)
            self.assertNotIn("kestrel_thread_id", raw)

    def test_write_result_accepts_artifact_passed_agent_failed_kind(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = write_result(
                BenchmarkResult(
                    adapter="cli",
                    dataset=DATASET,
                    task_id="hello-world",
                    status="failed",
                    duration_ms=12,
                    failure_kind="artifact_passed_but_agent_failed",
                ),
                Path(tmp),
            )
            raw = path.read_text(encoding="utf-8")
            self.assertIn('"failure_kind": "artifact_passed_but_agent_failed"', raw)

    def test_write_result_accepts_benchmark_contract_failure_kinds(self) -> None:
        for failure_kind in (
            "terminal_bench_protected_path_misuse",
            "model_contract_cannot_satisfy",
        ):
            with self.subTest(failure_kind=failure_kind):
                with tempfile.TemporaryDirectory() as tmp:
                    path = write_result(
                        BenchmarkResult(
                            adapter="cli",
                            dataset=DATASET,
                            task_id="blind-maze",
                            status="failed",
                            duration_ms=12,
                            failure_kind=failure_kind,
                        ),
                        Path(tmp),
                    )
                    raw = path.read_text(encoding="utf-8")
                    self.assertIn(f'"failure_kind": "{failure_kind}"', raw)

    def test_write_result_preserves_failure_details(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = write_result(
                BenchmarkResult(
                    adapter="cli",
                    dataset=DATASET,
                    task_id="blind-maze",
                    status="failed",
                    duration_ms=12,
                    failure_kind="runtime_external_deadline_exhausted",
                    failure_details={
                        "runtime_error": {"code": "RUNTIME_EXTERNAL_DEADLINE_EXHAUSTED"},
                        "missing_required_output_paths": ["/app/output/4.txt"],
                    },
                ),
                Path(tmp),
            )
            raw = path.read_text(encoding="utf-8")
            self.assertIn('"failure_kind": "runtime_external_deadline_exhausted"', raw)
            self.assertIn('"missing_required_output_paths"', raw)

    def test_write_result_preserves_provider_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = write_result(
                BenchmarkResult(
                    adapter="runtime",
                    dataset=DATASET,
                    task_id="hello-world",
                    status="completed",
                    duration_ms=12,
                    failure_kind="none",
                    model_provider="openrouter",
                    model="openai/gpt-5.4",
                    credential_env="OPENROUTER_API_KEY",
                    credential_fingerprint="abc123def456",
                ),
                Path(tmp),
            )
            raw = path.read_text(encoding="utf-8")
            self.assertIn('"model_provider": "openrouter"', raw)
            self.assertIn('"credential_env": "OPENROUTER_API_KEY"', raw)
            self.assertIn('"credential_fingerprint": "abc123def456"', raw)

    def test_task_id_from_logging_dir(self) -> None:
        self.assertEqual(task_id_from_logging_dir(Path("/tmp/hello-world")), "hello-world")
        self.assertEqual(
            task_id_from_logging_dir(
                Path("/tmp/run/hello-world/hello-world.1-of-1.kestrel-cli-20260427/agent-logs")
            ),
            "hello-world",
        )
        self.assertEqual(task_id_from_logging_dir(None), "unknown")


if __name__ == "__main__":
    unittest.main()
