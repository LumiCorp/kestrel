import unittest

from .tmux_devshell_bridge import TmuxDevShellBridge


class TmuxDevShellBridgeTest(unittest.TestCase):
    def test_protected_path_denial_returns_failed_process_result(self) -> None:
        bridge = TmuxDevShellBridge(session=object(), workspace_root="/app")

        result = bridge._start({"command": "cat /protected/ground_truth_map.txt", "cwd": "/app"})

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["exitCode"], 126)
        self.assertEqual(result["securityMode"], "blocked_protected_path")
        self.assertNotIn("processId", result)
        self.assertIn("protected path", result["text"])

    def test_relative_protected_path_denial_from_root_returns_failed_process_result(self) -> None:
        bridge = TmuxDevShellBridge(session=object(), workspace_root="/app")

        result = bridge._start({"command": "cat protected/ground_truth_map.txt", "cwd": "/"})

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["exitCode"], 126)
        self.assertEqual(result["securityMode"], "blocked_protected_path")
        self.assertNotIn("processId", result)
        self.assertIn("protected path", result["text"])

    def test_send_ignores_broken_pipe(self) -> None:
        bridge = TmuxDevShellBridge(session=object())

        bridge._send(BrokenPipeHandler(), {"status": "COMPLETED"}, status=200)

    def test_run_timeout_returns_failed_result_with_output_and_reason(self) -> None:
        bridge = FakeTmuxDevShellBridge(session=object(), workspace_root="/app")

        result = bridge._run(
            {
                "command": "python3 -c 'import time; time.sleep(5)'",
                "cwd": "/app",
                "yieldTimeMs": 0,
                "timeoutMs": 1,
                "maxOutputBytes": 4096,
            }
        )

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["exitCode"], 124)
        self.assertIn("controller started", result["text"])
        self.assertIn("timed out after 1 ms", result["failureReason"])
        self.assertEqual(bridge.controls, [("pane-1", "C-c")])

    def test_write_and_read_uses_pre_write_cursor_by_default(self) -> None:
        bridge = FakeTmuxDevShellBridge(session=object(), workspace_root="/app")
        bridge.output = "ready\n"
        process_id = "proc-1"
        bridge._processes[process_id] = bridge_process_for_test(process_id)

        result = bridge._write_and_read(process_id, {"data": "move E\n"})

        self.assertEqual(result["processId"], process_id)
        self.assertEqual(result["bytesWritten"], 7)
        self.assertEqual(result["text"], "input=move E\n")
        self.assertEqual(result["cursor"], len("ready\n"))
        self.assertEqual(bridge.sent, [("pane-1", "move E\n")])

    def test_session_api_maps_host_paths_to_container_workspace(self) -> None:
        session = FakeTerminalBenchSession()
        bridge = TmuxDevShellBridge(session=session, workspace_root="/app")

        result = bridge._run(
            {
                "command": "printf ok > hello.txt",
                "cwd": "/Users/example/Projects/kestrel",
                "workspaceRoot": "/Users/example/Projects/kestrel",
                "yieldTimeMs": 0,
            }
        )

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["cwd"], "/app")
        self.assertEqual(result["workspaceRoot"], "/app")
        self.assertIn("cd /app", session.sent[0][0])
        self.assertIn("set +H", session.sent[0][0])

    def test_multiline_session_api_command_is_staged_under_workspace(self) -> None:
        session = FakeTerminalBenchSession()
        bridge = TmuxDevShellBridge(session=session, workspace_root="/app")
        command = "cat > explore_maze.py <<'PY'\nprint('ok')\nPY\npython3 explore_maze.py"

        result = bridge._run({"command": command, "cwd": "/app", "yieldTimeMs": 0})

        self.assertEqual(result["status"], "COMPLETED")
        sent = ["".join(keys) for keys in session.sent]
        self.assertIn("mkdir -p /app/.kestrel-tbench/commands", sent[0])
        self.assertIn(".sh.b64", sent[0])
        self.assertTrue(any("printf %s" in command and ".sh.b64" in command for command in sent))
        self.assertTrue(any("base64 -d" in command and "chmod 700" in command for command in sent))
        self.assertIn("/bin/bash /app/.kestrel-tbench/commands/", sent[-1])
        self.assertIn("__KESTREL_CMD_DONE__", sent[-1])
        self.assertFalse(any("print('ok')" in command for command in sent))

    def test_multiline_session_api_command_keeps_protected_paths_blocked(self) -> None:
        session = FakeTerminalBenchSession()
        bridge = TmuxDevShellBridge(session=session, workspace_root="/app")

        result = bridge._start({"command": "printf ok\ncat /protected/answer.txt", "cwd": "/app"})

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["securityMode"], "blocked_protected_path")
        self.assertEqual(session.sent, [])

    def test_session_api_keeps_protected_paths_blocked(self) -> None:
        session = FakeTerminalBenchSession()
        bridge = TmuxDevShellBridge(session=session, workspace_root="/app")

        result = bridge._start({"command": "cat file.txt", "cwd": "/protected"})

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["securityMode"], "blocked_protected_path")
        self.assertEqual(session.sent, [])

    def test_session_api_write_and_read_drives_active_process(self) -> None:
        session = FakeInteractiveTerminalBenchSession()
        bridge = TmuxDevShellBridge(session=session, workspace_root="/app")

        started = bridge._start({"command": "./maze_game.sh", "cwd": "/app", "yieldTimeMs": 0})
        self.assertEqual(started["status"], "RUNNING")
        self.assertIn("ready", started["text"])

        process_id = started["processId"]
        written = bridge._write(process_id, {"data": "move N\n"})
        self.assertEqual(written["status"], "ACCEPTED")
        self.assertEqual(written["bytesWritten"], 7)

        read = bridge._read(process_id, {"cursor": started["nextCursor"]})
        self.assertEqual(read["status"], "COMPLETED")
        self.assertIn("input=move N", read["text"])
        self.assertEqual(session.sent[-1], ["move N\n"])


class FakeTmuxDevShellBridge(TmuxDevShellBridge):
    def __init__(self, session: object, workspace_root: str = "/app") -> None:
        super().__init__(session=session, workspace_root=workspace_root)
        self.controls: list[tuple[str, str]] = []
        self.sent: list[tuple[str, str]] = []
        self.output = "controller started\n"

    def _new_process_pane(self, _cwd: str) -> str:
        return "pane-1"

    def _send_command_to_pane(self, _pane_target: str, _command: str) -> None:
        return

    def _send_control_to_pane(self, pane_target: str, control: str) -> None:
        self.controls.append((pane_target, control))

    def _send_to_pane(self, pane_target: str, chars: str) -> None:
        self.sent.append((pane_target, chars))
        self.output = "ready\ninput=move E\n"

    def _capture_pane(self, _pane_target: str) -> str:
        return self.output


class FakeTerminalBenchSession:
    def __init__(self) -> None:
        self.sent: list[list[str]] = []
        self.output = ""

    def send_keys(self, keys: list[str], **_kwargs: object) -> None:
        self.sent.append(keys)
        command = keys[0] if keys else ""
        marker = "__KESTREL_CMD_DONE__:"
        if marker in command:
            process_id = command.split(marker, 1)[1].split(":", 1)[0]
            self.output += f"ok\n{marker}{process_id}:0\n"

    def capture_pane(self, capture_entire: bool = False) -> str:
        return self.output


class FakeInteractiveTerminalBenchSession:
    def __init__(self) -> None:
        self.sent: list[list[str]] = []
        self.output = ""
        self.process_id: str | None = None

    def send_keys(self, keys: list[str], **_kwargs: object) -> None:
        self.sent.append(keys)
        first = keys[0] if keys else ""
        marker = "__KESTREL_CMD_DONE__:"
        if marker in first:
            self.process_id = first.split(marker, 1)[1].split(":", 1)[0]
            self.output += "ready\n"
            return
        if self.process_id is not None and first == "move N\n":
            self.output += f"input=move N\n{marker}{self.process_id}:0\n"

    def capture_pane(self, capture_entire: bool = False) -> str:
        return self.output


def bridge_process_for_test(process_id: str):
    from .tmux_devshell_bridge import BridgeProcess

    return BridgeProcess(
        process_id=process_id,
        command="./task.sh",
        cwd="/app",
        submitted_at="2026-01-01T00:00:00.000Z",
        pane_target="pane-1",
    )


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
