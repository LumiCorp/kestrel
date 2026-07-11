from __future__ import annotations

import os
import shlex
import stat
import tempfile
import time
import unittest
import json
from urllib import request
from pathlib import Path

from . import container_devshell_bridge as bridge_module
from .container_devshell_bridge import (
    ContainerDevShellBridge,
    discover_protected_entrypoints,
    match_unmodified_protected_entrypoint,
    parse_protected_entrypoint_command_reference,
    prepare_agent_workspace_permissions,
)


class ContainerDevShellBridgeTest(unittest.TestCase):
    def test_workspace_permission_prep_makes_nested_git_refs_owner_writable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            refs = Path(tmp) / "personal-site" / ".git" / "refs" / "heads"
            refs.mkdir(parents=True)
            ref = refs / "master"
            ref.write_text("d7d3e4b\n", encoding="utf-8")
            script = Path(tmp) / "run.sh"
            script.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            refs.chmod(0o500)
            ref.chmod(0o400)
            script.chmod(0o500)

            prepare_agent_workspace_permissions(tmp, uid=os.getuid(), gid=os.getgid())

            self.assertTrue(refs.stat().st_mode & stat.S_IWUSR)
            self.assertTrue(refs.stat().st_mode & stat.S_IXUSR)
            self.assertTrue(ref.stat().st_mode & stat.S_IWUSR)
            self.assertTrue(script.stat().st_mode & stat.S_IXUSR)

    def test_workspace_permission_prep_does_not_traverse_symlinks_outside_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            outside_file = Path(outside) / "secret.txt"
            outside_file.write_text("secret", encoding="utf-8")
            outside_file.chmod(0o400)
            os.symlink(outside, Path(tmp) / "outside-link")

            prepare_agent_workspace_permissions(tmp, uid=os.getuid(), gid=os.getgid())

            self.assertFalse(outside_file.stat().st_mode & stat.S_IWUSR)

    def test_workspace_permission_prep_excludes_managed_entrypoint_private_roots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            private_root = Path(tmp) / ".kestrel-managed-entrypoints"
            private_root.mkdir()
            private_file = private_root / "maze_game.sh"
            private_file.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            private_file.chmod(0o400)
            work_file = Path(tmp) / "notes.txt"
            work_file.write_text("editable", encoding="utf-8")
            work_file.chmod(0o400)

            prepare_agent_workspace_permissions(
                tmp,
                uid=os.getuid(),
                gid=os.getgid(),
                excluded_roots=(str(private_root),),
            )

            self.assertFalse(private_file.stat().st_mode & stat.S_IWUSR)
            self.assertTrue(work_file.stat().st_mode & stat.S_IWUSR)

    def test_shell_run_reports_changed_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "input.tex"
            target.write_text("before\n", encoding="utf-8")
            bridge = ContainerDevShellBridge(tmp)
            try:
                result = bridge._run({
                    "command": "python3 -c \"from pathlib import Path; Path('input.tex').write_text('after\\\\n')\"",
                    "cwd": tmp,
                })

                self.assertEqual(result["status"], "COMPLETED")
                self.assertEqual(result.get("changedFiles"), ["input.tex"])
            finally:
                bridge.close()

    def test_shell_run_omits_changed_files_for_noop_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "input.tex"
            target.write_text("same\n", encoding="utf-8")
            bridge = ContainerDevShellBridge(tmp)
            try:
                result = bridge._run({"command": "printf ok", "cwd": tmp})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertNotIn("changedFiles", result)
            finally:
                bridge.close()

    def test_shell_run_changed_files_does_not_follow_symlinks_outside_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            outside_file = Path(outside) / "secret.txt"
            outside_file.write_text("before\n", encoding="utf-8")
            os.symlink(outside_file, Path(tmp) / "secret-link.txt")
            bridge = ContainerDevShellBridge(tmp)
            try:
                result = bridge._run({
                    "command": "python3 -c \"from pathlib import Path; Path('secret-link.txt').write_text('after\\\\n')\"",
                    "cwd": tmp,
                })

                self.assertEqual(result["status"], "COMPLETED")
                self.assertNotIn("changedFiles", result)
            finally:
                bridge.close()

    def test_shell_run_changed_files_excludes_managed_entrypoint_private_roots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            private_root = Path(tmp) / ".kestrel-managed-entrypoints"
            private_root.mkdir()
            private_file = private_root / "entry.sh"
            private_file.write_text("before\n", encoding="utf-8")
            work_file = Path(tmp) / "work.txt"
            work_file.write_text("before\n", encoding="utf-8")
            bridge = ContainerDevShellBridge(tmp, managed_entrypoint_root=str(private_root))
            bridge._managed_entrypoint_private_roots.add(str(private_root))
            try:
                result = bridge._run({
                    "command": (
                        "python3 -c \"from pathlib import Path; "
                        "Path('.kestrel-managed-entrypoints/entry.sh').write_text('after\\\\n'); "
                        "Path('work.txt').write_text('after\\\\n')\""
                    ),
                    "cwd": tmp,
                })

                self.assertEqual(result["status"], "COMPLETED")
                self.assertEqual(result.get("changedFiles"), ["work.txt"])
            finally:
                bridge.close()

    def test_bridge_start_installs_shims_before_workspace_permission_prep(self) -> None:
        calls: list[str] = []
        original_install = ContainerDevShellBridge._install_protected_entrypoint_shims
        original_prepare = bridge_module.prepare_agent_filesystem_boundary

        def recording_install(self: ContainerDevShellBridge, workspace_root: str) -> None:
            calls.append("install")
            original_install(self, workspace_root)

        def recording_prepare(
            workspace_root: str,
            *,
            excluded_roots: list[str] | tuple[str, ...] | None = None,
        ) -> None:
            calls.append("prepare")

        ContainerDevShellBridge._install_protected_entrypoint_shims = recording_install
        bridge_module.prepare_agent_filesystem_boundary = recording_prepare
        try:
            with tempfile.TemporaryDirectory() as tmp:
                entrypoint = Path(tmp) / "maze_game.sh"
                entrypoint.write_text(
                    "#!/usr/bin/env bash\npython3 /protected/maze_server.py\n",
                    encoding="utf-8",
                )
                entrypoint.chmod(0o755)
                bridge = ContainerDevShellBridge(tmp)
                try:
                    bridge.start()
                finally:
                    bridge.close()

            self.assertEqual(calls[:2], ["install", "prepare"])
        finally:
            ContainerDevShellBridge._install_protected_entrypoint_shims = original_install
            bridge_module.prepare_agent_filesystem_boundary = original_prepare

    def test_write_sends_chars_to_active_process(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                first = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import sys; "
                            "print('ready', flush=True); "
                            "line=sys.stdin.readline(); "
                            "print('input=' + line.strip(), flush=True)\""
                        )
                    }
                )
                self.assertEqual(first["status"], "RUNNING")
                self.assertTrue(wait_for_output(bridge, "ready"))

                process_id = first["processId"]
                second = bridge._write(process_id, {"data": "move N\n"})

                self.assertEqual(second["processId"], process_id)
                self.assertTrue(wait_for_output(bridge, "input=move N"))
                self.assertTrue(wait_for_completion(bridge, process_id))
            finally:
                bridge.close()

    def test_legacy_process_write_endpoint_uses_body_process_id_and_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                bridge.start()
                first = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import sys; "
                            "print('ready', flush=True); "
                            "line=sys.stdin.readline(); "
                            "print('input=' + line.strip(), flush=True)\""
                        )
                    }
                )
                self.assertEqual(first["status"], "RUNNING")
                self.assertTrue(wait_for_output(bridge, "ready"))

                body = json.dumps({"processId": first["processId"], "input": "move N\n"}).encode("utf-8")
                req = request.Request(
                    bridge.url + "/processes/write",
                    data=body,
                    headers={"content-type": "application/json"},
                    method="POST",
                )
                with request.urlopen(req, timeout=5) as response:
                    payload = json.loads(response.read().decode("utf-8"))

                self.assertEqual(payload["processId"], first["processId"])
                self.assertEqual(payload["status"], "ACCEPTED")
                self.assertTrue(wait_for_output(bridge, "input=move N"))
            finally:
                bridge.close()

    def test_write_and_read_returns_output_after_write_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                first = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import sys, time; "
                            "print('ready', flush=True); "
                            "line=sys.stdin.readline(); "
                            "print('input=' + line.strip(), flush=True); "
                            "time.sleep(5)\""
                        ),
                        "yieldTimeMs": 200,
                    }
                )
                self.assertEqual(first["status"], "RUNNING")
                self.assertIn("ready", first["text"])

                process_id = first["processId"]
                result = bridge._write_and_read(process_id, {"data": "move E\n", "yieldTimeMs": 200})

                self.assertEqual(result["processId"], process_id)
                self.assertEqual(result["bytesWritten"], 7)
                self.assertIn("input=move E", result["text"])
                self.assertNotIn("ready", result["text"])
                self.assertGreaterEqual(result["cursor"], first["nextCursor"])
            finally:
                bridge.close()

    def test_exec_starts_helper_process_while_interactive_process_is_running(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                first = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import sys; "
                            "print('ready', flush=True); "
                            "line=sys.stdin.readline(); "
                            "print('input=' + line.strip(), flush=True)\""
                        )
                    }
                )
                self.assertEqual(first["status"], "RUNNING")
                self.assertTrue(wait_for_output(bridge, "ready"))
                interactive_process_id = first["processId"]

                result = bridge._start({"command": "echo later", "yieldTimeMs": 100})
                helper_process_id = result.get("processId")
                if isinstance(helper_process_id, str):
                    self.assertNotEqual(helper_process_id, interactive_process_id)
                    self.assertTrue(wait_for_completion(bridge, helper_process_id))
                    result = bridge._read(helper_process_id, {})
                self.assertEqual(result["status"], "COMPLETED")
                self.assertIn("later", result["text"])

                bridge._write(interactive_process_id, {"data": "move S\n"})
                self.assertTrue(wait_for_output(bridge, "input=move S", interactive_process_id))
            finally:
                bridge.close()

    def test_process_output_is_isolated_by_process_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                first = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import sys; "
                            "print('first-ready', flush=True); "
                            "line=sys.stdin.readline(); "
                            "print('first=' + line.strip(), flush=True)\""
                        )
                    }
                )
                second = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import sys; "
                            "print('second-ready', flush=True); "
                            "line=sys.stdin.readline(); "
                            "print('second=' + line.strip(), flush=True)\""
                        )
                    }
                )
                first_id = first["processId"]
                second_id = second["processId"]
                self.assertNotEqual(first_id, second_id)
                self.assertTrue(wait_for_output(bridge, "first-ready", first_id))
                self.assertTrue(wait_for_output(bridge, "second-ready", second_id))

                bridge._write(first_id, {"data": "alpha\n"})
                bridge._write(second_id, {"data": "beta\n"})

                self.assertTrue(wait_for_output(bridge, "first=alpha", first_id))
                self.assertTrue(wait_for_output(bridge, "second=beta", second_id))
            finally:
                bridge.close()

    def test_stop_one_process_does_not_stop_another(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                first = bridge._start({"command": "python3 -c \"import time; print('one', flush=True); time.sleep(30)\""})
                second = bridge._start({"command": "python3 -c \"import time; print('two', flush=True); time.sleep(30)\""})
                first_id = first["processId"]
                second_id = second["processId"]

                stopped = bridge._stop(first_id, {})
                self.assertEqual(stopped["status"], "STOPPED")
                self.assertEqual(stopped["processId"], first_id)

                still_running = bridge._read(second_id, {})
                self.assertEqual(still_running["status"], "RUNNING")
                self.assertEqual(still_running["processId"], second_id)
            finally:
                bridge.close()

    def test_unknown_process_id_fails_clearly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                with self.assertRaisesRegex(RuntimeError, "Unknown dev process"):
                    bridge._read("missing-proc", {})
            finally:
                bridge.close()

    def test_short_completed_exec_returns_no_live_process_id_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                result = bridge._start({"command": "printf quick"})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertNotIn("processId", result)
                self.assertIn("quick", result["text"])
                self.assertEqual(result["exitCode"], 0)
            finally:
                bridge.close()

    def test_run_timeout_returns_failed_result_with_output_and_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                result = bridge._run(
                    {
                        "command": "python3 -c \"import time; print('controller started', flush=True); time.sleep(5)\"",
                        "timeoutMs": 100,
                        "maxOutputBytes": 4096,
                    }
                )

                self.assertEqual(result["status"], "FAILED")
                self.assertEqual(result["exitCode"], 124)
                self.assertIn("controller started", result["text"])
                self.assertIn("timed out after 100 ms", result["failureReason"])
                self.assertNotIn("processId", result)
            finally:
                bridge.close()

    def test_exec_rejects_protected_path_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                for result in (
                    bridge._start({"command": "cat /protected/ground_truth_map.txt"}),
                    bridge._start({"command": "cat protected/ground_truth_map.txt", "cwd": "/"}),
                    bridge._start({"command": "cat ./protected/ground_truth_map.txt", "cwd": "/"}),
                ):
                    self.assertEqual(result["status"], "FAILED")
                    self.assertEqual(result["exitCode"], 126)
                    self.assertEqual(result["securityMode"], "blocked_protected_path")
                    self.assertNotIn("processId", result)
                    self.assertIn("protected path", result["text"])
            finally:
                bridge.close()

    def test_exec_rejects_protected_workspace_or_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                workspace_result = bridge._start({"command": "pwd", "workspaceRoot": "/protected"})
                self.assertEqual(workspace_result["status"], "FAILED")
                self.assertEqual(workspace_result["securityMode"], "blocked_protected_path")
                self.assertIn("workspaceRoot", workspace_result["text"])

                cwd_result = bridge._start({"command": "pwd", "cwd": "/protected"})
                self.assertEqual(cwd_result["status"], "FAILED")
                self.assertEqual(cwd_result["securityMode"], "blocked_protected_path")
                self.assertIn("cwd", cwd_result["text"])
            finally:
                bridge.close()

    def test_exec_can_still_write_and_read_app_artifact_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                result = bridge._start({"command": "printf map > maze_map.txt && cat maze_map.txt"})
                self.assertEqual(result["status"], "COMPLETED")
                self.assertIn("map", result["text"])
            finally:
                bridge.close()

    def test_task_entrypoint_with_protected_backend_is_allowlisted_only_while_unmodified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text("#!/usr/bin/env bash\npython3 /protected/maze_server.py\n", encoding="utf-8")
            entrypoint.chmod(0o755)

            entrypoints = discover_protected_entrypoints(tmp)
            matched = match_unmodified_protected_entrypoint(
                command="./maze_game.sh",
                cwd=tmp,
                workspace_root=tmp,
                entrypoints=entrypoints,
            )
            self.assertIsNotNone(matched)

            bash_matched = match_unmodified_protected_entrypoint(
                command="bash ./maze_game.sh",
                cwd=tmp,
                workspace_root=tmp,
                entrypoints=entrypoints,
            )
            self.assertIsNotNone(bash_matched)

            entrypoint.write_text("#!/usr/bin/env bash\ncat /protected/ground_truth_map.txt\n", encoding="utf-8")
            modified = match_unmodified_protected_entrypoint(
                command="./maze_game.sh",
                cwd=tmp,
                workspace_root=tmp,
                entrypoints=entrypoints,
            )
            self.assertIsNone(modified)

    def test_task_entrypoint_allowlist_rejects_shell_compound_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text("#!/usr/bin/env bash\npython3 /protected/maze_server.py\n", encoding="utf-8")
            entrypoint.chmod(0o755)
            entrypoints = discover_protected_entrypoints(tmp)

            matched = match_unmodified_protected_entrypoint(
                command="./maze_game.sh; echo after",
                cwd=tmp,
                workspace_root=tmp,
                entrypoints=entrypoints,
            )
            self.assertIsNone(matched)

            cd_matched = match_unmodified_protected_entrypoint(
                command=f"cd {shlex.quote(tmp)} && ./maze_game.sh",
                cwd="/",
                workspace_root=tmp,
                entrypoints=entrypoints,
            )
            self.assertIsNone(cd_matched)

    def test_bash_task_entrypoint_exec_uses_protected_entrypoint_security_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "printf 'ready\\n'\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            bridge = ContainerDevShellBridge(tmp)
            try:
                result = bridge._start({"command": "bash ./maze_game.sh", "cwd": tmp})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertEqual(result["securityMode"], "protected_entrypoint")
                self.assertIn("ready", result["text"])
            finally:
                bridge.close()

    def test_unprivileged_controller_can_drive_protected_entrypoint_through_core_client(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "python3 -c 'import sys; print(\"ready\", flush=True); "
                "line=sys.stdin.readline(); print(\"input=\" + line.strip(), flush=True)'\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            controller = Path(tmp) / "controller.py"
            controller.write_text(
                "from kestrel_devshell import start, write as shell_write, read as shell_read, stop as shell_stop\n"
                "process = start(command=['./maze_game.sh'], cwd='.', workspace_root='.', yield_time_ms=200, max_output_bytes=8000)\n"
                "first = process.start_result\n"
                "print('START_SECURITY=' + str(first.get('securityMode')))\n"
                "print(first.get('text', ''), end='')\n"
                "if process.process_id is None:\n"
                "    raise SystemExit('entrypoint did not stay running')\n"
                "result = shell_write(process, data='move N\\n')\n"
                "print('WRITE_STATUS=' + str(result.get('status')))\n"
                "while result.get('status') == 'RUNNING':\n"
                "    result = shell_read(process, wait_ms=100)\n"
                "    print(result.get('text', ''), end='')\n"
                "result = shell_read(process, wait_ms=500)\n"
                "print(result.get('text', ''), end='')\n"
                "shell_stop(process, signal='SIGTERM', wait_ms=100)\n"
                "print('FINAL_STATUS=' + str(result.get('status')))\n",
                encoding="utf-8",
            )

            bridge = ContainerDevShellBridge(tmp)
            try:
                bridge.start()
                result = bridge._start({"command": "python3 controller.py", "yieldTimeMs": 1000})
                process_id = result.get("processId") or next(
                    process_id
                    for process_id, running in bridge._processes.items()
                    if running.command == "python3 controller.py"
                )
                self.assertTrue(wait_for_completion(bridge, str(process_id)))
                output = result.get("text", "") + bridge._read(str(process_id), {})["text"]

                self.assertIn("START_SECURITY=protected_entrypoint", output)
                self.assertIn("WRITE_STATUS=ACCEPTED", output)
                self.assertIn("ready", output)
                self.assertIn("input=move N", output)
                self.assertRegex(output, r"FINAL_STATUS=(RUNNING|COMPLETED)")
                self.assertTrue(
                    any(
                        "maze_game.sh" in running.command
                        and running.security_mode == "protected_entrypoint"
                        for running in bridge._processes.values()
                    )
                )
            finally:
                bridge.close()

    def test_shim_allows_direct_protected_entrypoint_execution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "printf 'ready:%s\\n' \"$1\"\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            private_root = Path(tmp) / ".managed"
            bridge = ContainerDevShellBridge(tmp, managed_entrypoint_root=str(private_root))
            try:
                bridge.start()
                shim_text = entrypoint.read_text(encoding="utf-8")
                self.assertNotIn("/installed-agent/managed-entrypoints", shim_text)
                self.assertNotIn("/protected", shim_text)
                result = bridge._run({"command": "./maze_game.sh 1", "cwd": tmp, "timeoutMs": 2000})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertEqual(result["securityMode"], "protected_entrypoint")
                self.assertEqual(result["command"], "./maze_game.sh 1")
                self.assertIn("ready:1", result["text"])
                self.assertNotIn("Permission denied", result["text"])
                self.assertNotIn("/installed-agent/managed-entrypoints", result["text"])
            finally:
                bridge.close()

    def test_shim_allows_python_subprocess_to_drive_protected_entrypoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "python3 -c 'import sys; print(\"ready\", flush=True); "
                "line=sys.stdin.readline(); print(\"input=\" + line.strip(), flush=True)'\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            controller = Path(tmp) / "controller.py"
            controller.write_text(
                "import subprocess\n"
                "p = subprocess.Popen(['./maze_game.sh', '1'], cwd='.', stdin=subprocess.PIPE, "
                "stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)\n"
                "out, _ = p.communicate('move N\\n', timeout=5)\n"
                "print('RC=' + str(p.returncode))\n"
                "print(out, end='')\n",
                encoding="utf-8",
            )
            private_root = Path(tmp) / ".managed"
            bridge = ContainerDevShellBridge(tmp, managed_entrypoint_root=str(private_root))
            try:
                bridge.start()
                shim_text = entrypoint.read_text(encoding="utf-8")
                self.assertNotIn("/installed-agent/managed-entrypoints", shim_text)
                self.assertNotIn("/protected", shim_text)
                result = bridge._run({"command": "python3 controller.py", "cwd": tmp, "timeoutMs": 5000})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertIn("RC=0", result["text"])
                self.assertIn("ready", result["text"])
                self.assertIn("input=move N", result["text"])
                self.assertNotIn("/installed-agent/managed-entrypoints", result["text"])
                self.assertTrue(
                    any(
                        running.security_mode == "protected_entrypoint"
                        and "maze_game.sh" in running.command
                        for running in bridge._processes.values()
                    )
                )
            finally:
                bridge.close()

    def test_private_preserved_entrypoint_path_is_not_directly_allowlisted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "printf 'ready\\n'\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            private_root = Path(tmp) / ".managed"
            bridge = ContainerDevShellBridge(tmp, managed_entrypoint_root=str(private_root))
            try:
                bridge.start()
                managed = bridge._protected_entrypoints[str(entrypoint.resolve())]
                self.assertIsNotNone(managed.private_path)

                reference = parse_protected_entrypoint_command_reference(
                    command=str(managed.private_path),
                    cwd=tmp,
                    workspace_root=tmp,
                    entrypoints=bridge._protected_entrypoints,
                )

                self.assertIsNone(reference)
            finally:
                bridge.close()

    def test_shim_closes_protected_entrypoint_stdin_on_subprocess_eof(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "python3 -c 'import sys; print(\"ready\", flush=True); "
                "data=sys.stdin.read(); print(\"input=\" + data.strip(), flush=True); "
                "print(\"eof\", flush=True)'\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            controller = Path(tmp) / "controller.py"
            controller.write_text(
                "import subprocess\n"
                "p = subprocess.Popen(['./maze_game.sh', '1'], cwd='.', stdin=subprocess.PIPE, "
                "stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)\n"
                "out, _ = p.communicate('move N\\n', timeout=5)\n"
                "print('RC=' + str(p.returncode))\n"
                "print(out, end='')\n",
                encoding="utf-8",
            )
            private_root = Path(tmp) / ".managed"
            bridge = ContainerDevShellBridge(tmp, managed_entrypoint_root=str(private_root))
            try:
                bridge.start()
                result = bridge._run({"command": "python3 controller.py", "cwd": tmp, "timeoutMs": 5000})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertIn("RC=0", result["text"])
                self.assertIn("input=move N", result["text"])
                self.assertIn("eof", result["text"])
            finally:
                bridge.close()

    def test_shim_streams_prompt_without_newline_to_python_controller(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "python3 -c 'import sys; "
                "print(\"ready\", flush=True); "
                "print(\"> \", end=\"\", flush=True); "
                "line=sys.stdin.readline(); "
                "print(\"input=\" + line.strip(), flush=True)'\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            controller = Path(tmp) / "controller.py"
            controller.write_text(
                "import subprocess\n"
                "p = subprocess.Popen(['./maze_game.sh', '1'], cwd='.', stdin=subprocess.PIPE, "
                "stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)\n"
                "buf = ''\n"
                "while not buf.endswith('> '):\n"
                "    ch = p.stdout.read(1)\n"
                "    if ch == '':\n"
                "        break\n"
                "    buf += ch\n"
                "p.stdin.write('move N\\n')\n"
                "p.stdin.flush()\n"
                "rest = p.stdout.read()\n"
                "p.wait(timeout=5)\n"
                "print('PROMPT=' + buf.replace('\\n', '|'))\n"
                "print(rest, end='')\n",
                encoding="utf-8",
            )
            private_root = Path(tmp) / ".managed"
            bridge = ContainerDevShellBridge(tmp, managed_entrypoint_root=str(private_root))
            try:
                bridge.start()
                result = bridge._run({"command": "python3 controller.py", "cwd": tmp, "timeoutMs": 5000})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertIn("PROMPT=", result["text"])
                self.assertIn("> ", result["text"])
                self.assertIn("input=move N", result["text"])
            finally:
                bridge.close()

    def test_shim_preserves_protected_entrypoint_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "printf 'failing\\n'\n"
                "exit 7\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            private_root = Path(tmp) / ".managed"
            bridge = ContainerDevShellBridge(tmp, managed_entrypoint_root=str(private_root))
            try:
                bridge.start()
                result = bridge._run({"command": "python3 - <<'PY'\nimport subprocess\nr = subprocess.run(['./maze_game.sh'], cwd='.', capture_output=True, text=True)\nprint('RC', r.returncode)\nprint(r.stdout, end='')\nPY", "cwd": tmp, "timeoutMs": 5000})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertIn("RC 7", result["text"])
                self.assertIn("failing", result["text"])
            finally:
                bridge.close()

    def test_editing_public_shim_does_not_grant_protected_access(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "printf 'ready\\n'\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            private_root = Path(tmp) / ".managed"
            bridge = ContainerDevShellBridge(tmp, managed_entrypoint_root=str(private_root))
            try:
                bridge.start()
                entrypoint.write_text("#!/usr/bin/env bash\npython3 /protected/maze_server.py\n", encoding="utf-8")
                entrypoint.chmod(0o755)

                result = bridge._run({"command": "./maze_game.sh", "cwd": tmp, "timeoutMs": 2000})

                self.assertEqual(result["status"], "FAILED")
                self.assertEqual(result["securityMode"], "blocked_protected_path")
            finally:
                bridge.close()

    def test_agent_process_environment_exposes_core_client(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                bridge.start()
                result = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import os, kestrel_devshell; "
                            "print(os.environ.get('KESTREL_DEV_SHELL_BRIDGE_URL', 'missing')); "
                            "print(os.environ.get('KESTREL_DEV_SHELL_BRIDGE_URL', 'missing')); "
                            "print(kestrel_devshell.__name__)\""
                        )
                    }
                )

                self.assertEqual(result["status"], "COMPLETED")
                self.assertIn("http://127.0.0.1:", result["text"])
                self.assertIn("kestrel_devshell", result["text"])
            finally:
                bridge.close()

    def test_agent_process_environment_hides_managed_entrypoint_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "# protected backend marker: /protected/maze_server.py\n"
                "printf ready\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            bridge = ContainerDevShellBridge(tmp)
            try:
                result = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import os; "
                            "print(os.environ.get('KESTREL_MANAGED_ENTRYPOINTS_JSON', 'missing'))\""
                        ),
                        "cwd": tmp,
                    }
                )

                self.assertEqual(result["status"], "COMPLETED")
                self.assertIn("missing", result["text"])
            finally:
                bridge.close()

    def test_bridge_start_preloads_managed_entrypoint_registry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint = Path(tmp) / "maze_game.sh"
            entrypoint.write_text(
                "#!/usr/bin/env bash\n"
                "python3 /protected/maze_server.py \"$@\"\n",
                encoding="utf-8",
            )
            entrypoint.chmod(0o755)
            bridge = ContainerDevShellBridge(tmp)
            try:
                bridge.start()
                registry = bridge._protected_entrypoints
                self.assertIn(str(entrypoint.resolve()), registry)
                managed = registry[str(entrypoint.resolve())]
                self.assertEqual(managed.path, str(entrypoint.resolve()))
                self.assertIsNotNone(managed.private_path)
                self.assertIsNotNone(managed.shim_digest)
                self.assertNotIn("KESTREL_MANAGED_ENTRYPOINTS_JSON", bridge._agent_environment())
            finally:
                bridge.close()

    def test_write_to_completed_known_process_returns_completed_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                bridge._start({"command": "printf done"})
                process_id = next(iter(bridge._processes))

                result = bridge._write(process_id, {"data": "ignored\n"})

                self.assertEqual(result["status"], "COMPLETED")
                self.assertNotIn("processId", result)
                self.assertEqual(result["exitCode"], 0)
            finally:
                bridge.close()

    def test_write_accepts_multiline_for_active_process(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bridge = ContainerDevShellBridge(tmp)
            try:
                first = bridge._start(
                    {
                        "command": (
                            "python3 -c \"import sys; "
                            "print('ready', flush=True); "
                            "line=sys.stdin.readline(); "
                            "print('input=' + line.strip(), flush=True)\""
                        )
                    }
                )
                self.assertEqual(first["status"], "RUNNING")
                self.assertTrue(wait_for_output(bridge, "ready"))

                process_id = first["processId"]
                bridge._write(process_id, {"data": "move N\nignored\n"})
                self.assertTrue(wait_for_output(bridge, "input=move N"))
            finally:
                bridge.close()

    def test_send_logs_broken_pipe_without_raising(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log_path = Path(tmp) / "bridge.jsonl"
            bridge = ContainerDevShellBridge(tmp, log_path=str(log_path))

            bridge._send(BrokenPipeHandler(), {"status": "COMPLETED"}, status=200)

            records = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(records[-1]["event"], "response_write_failed")
            self.assertEqual(records[-1]["code"], "BrokenPipeError")


def wait_for_output(
    bridge: ContainerDevShellBridge,
    expected: str,
    process_id: str | None = None,
    timeout_sec: float = 5.0,
) -> bool:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        target_process_id = process_id or next(iter(bridge._processes), None)
        if target_process_id is not None:
            process = bridge._processes.get(target_process_id)
            if process is not None and expected in process.output:
                return True
        time.sleep(0.05)
    return False


def wait_for_completion(bridge: ContainerDevShellBridge, process_id: str, timeout_sec: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        process = bridge._processes.get(process_id)
        if process is not None and process.exit_code is not None:
            return True
        time.sleep(0.05)
    return False


class BrokenPipeWriter:
    def write(self, _raw: bytes) -> None:
        raise BrokenPipeError("client disconnected")


class BrokenPipeHandler:
    wfile = BrokenPipeWriter()

    def send_response(self, _status: int) -> None:
        return

    def send_header(self, _name: str, _value: str) -> None:
        return

    def end_headers(self) -> None:
        return


if __name__ == "__main__":
    unittest.main()
