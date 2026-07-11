from __future__ import annotations

import json
import os
import socketserver
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "devshell"))

import kestrel_devshell


class KestrelDevShellClientTest(unittest.TestCase):
    def test_http_client_maps_run_start_write_read_stop(self) -> None:
        with DevShellHttpFixture() as fixture:
            ran = kestrel_devshell.run("printf ok", endpoint=fixture.endpoint)
            self.assertEqual(ran["text"], "ran")

            process = kestrel_devshell.start(
                ["./task.sh"],
                cwd="/app",
                workspace_root="/app",
                yield_time_ms=10,
                max_output_bytes=100,
                endpoint=fixture.endpoint,
            )
            started = process.start_result
            self.assertEqual(started["process_id"], "proc-1")
            self.assertEqual(process.process_id, "proc-1")
            self.assertEqual(process.cursor, 0)

            written = kestrel_devshell.write(processId="proc-1", data="move N\n", endpoint=fixture.endpoint)
            self.assertEqual(written["status"], "ACCEPTED")

            read = kestrel_devshell.read(process_id="proc-1", cursor=0, endpoint=fixture.endpoint)
            self.assertEqual(read["status"], "RUNNING")

            stopped = kestrel_devshell.stop(process_id="proc-1", signal="SIGTERM", endpoint=fixture.endpoint)
            self.assertEqual(stopped["status"], "STOPPED")

            self.assertEqual(
                [call["path"] for call in fixture.calls],
                ["/shell/run", "/processes/start", "/processes/proc-1/write", "/processes/proc-1/read", "/processes/proc-1/stop"],
            )
            self.assertEqual(fixture.calls[2]["body"]["data"], "move N\n")

    def test_process_read_after_start_begins_with_startup_cursor(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.start("./task.sh", endpoint=fixture.endpoint)

            read = process.read()

            self.assertEqual(read["text"], "ready")
            self.assertEqual(read.text, "ready")
            self.assertEqual(str(read), "ready")
            self.assertEqual(fixture.calls[1]["query"]["cursor"], ["0"])

    def test_process_read_accepts_timeout_alias_as_wait_ms(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint)

            read = process.read(timeout=2000, max_bytes=100)

            self.assertEqual(read["status"], "RUNNING")
            self.assertEqual(fixture.calls[0]["query"]["waitMs"], ["2000"])
            self.assertEqual(fixture.calls[0]["query"]["maxBytes"], ["100"])

    def test_run_accepts_timeout_alias_as_timeout_ms(self) -> None:
        with DevShellHttpFixture() as fixture:
            ran = kestrel_devshell.run("printf ok", timeout=1234, endpoint=fixture.endpoint)

            self.assertEqual(ran["text"], "ran")
            self.assertEqual(fixture.calls[0]["body"]["timeoutMs"], 1234)

    def test_process_context_manager_stops_on_controller_exception(self) -> None:
        with DevShellHttpFixture() as fixture:
            with self.assertRaisesRegex(RuntimeError, "controller failed"):
                with kestrel_devshell.start("./task.sh", endpoint=fixture.endpoint) as process:
                    self.assertEqual(process.process_id, "proc-1")
                    raise RuntimeError("controller failed")

            self.assertEqual(
                [call["path"] for call in fixture.calls],
                ["/processes/start", "/processes/proc-1/stop"],
            )

    def test_process_close_alias_stops_once(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint)

            closed = process.close()
            closed_again = process.close()

            self.assertEqual(closed["status"], "STOPPED")
            self.assertIsNone(closed_again)
            self.assertEqual([call["path"] for call in fixture.calls], ["/processes/proc-1/stop"])

    def test_sendline_and_wait_matches_prompt_prefixed_output(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint, cursor=5)

            result = process.sendline_and_wait("move N", "hit wall", timeout=1000)

            self.assertEqual(result, "hit wall")
            self.assertEqual(fixture.calls[0]["path"], "/processes/proc-1/write")
            self.assertEqual(fixture.calls[0]["body"]["data"], "move N\n")
            self.assertEqual(fixture.calls[1]["path"], "/processes/proc-1/read")
            self.assertEqual(fixture.calls[1]["query"]["cursor"], ["5"])

    def test_process_write_and_read_sends_input_and_advances_cursor(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint, cursor=5)

            result = process.write_and_read("move E\n", wait_ms=100, max_bytes=50)

            self.assertEqual(result["text"], "> moved\n")
            self.assertEqual(result["bytesWritten"], 7)
            self.assertEqual(process.cursor, 13)
            self.assertEqual(fixture.calls[0]["path"], "/processes/proc-1/write_and_read")
            self.assertEqual(fixture.calls[0]["body"]["data"], "move E\n")
            self.assertEqual(fixture.calls[0]["body"]["cursor"], 5)
            self.assertEqual(fixture.calls[0]["body"]["waitMs"], 100)
            self.assertEqual(fixture.calls[0]["body"]["maxBytes"], 50)

    def test_top_level_write_and_read_accepts_process_object(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint, cursor=5)

            result = kestrel_devshell.write_and_read(process, data="move E\n", wait_ms=100)

            self.assertEqual(result["status"], "RUNNING")
            self.assertEqual(result["text"], "> moved\n")
            self.assertEqual(process.cursor, 13)
            self.assertEqual(fixture.calls[0]["path"], "/processes/proc-1/write_and_read")

    def test_wait_for_returns_matched_text_and_read_stays_raw(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint, cursor=5)

            result = process.wait_for(["hit wall", "moved"], timeout=1000)
            raw = process.read(cursor=5)

            self.assertEqual(result, "hit wall")
            self.assertEqual(raw["text"], "> hit wall\n")
            self.assertEqual(raw["status"], "RUNNING")

    def test_wait_for_can_return_debug_result(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint, cursor=5)

            result = process.wait_for(["hit wall", "moved"], timeout=1000, return_result=True)

            self.assertEqual(result["matched"], "hit wall")
            self.assertEqual(result["buffer"], "> hit wall\n")
            self.assertFalse(result["timedOut"])
            self.assertEqual(result["status"], "RUNNING")
            self.assertEqual(result["lastOutput"], "> hit wall\n")

    def test_sendline_and_wait_can_return_debug_result(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint, cursor=5)

            result = process.sendline_and_wait("move N", ["hit wall", "moved"], timeout=1000, return_result=True)

            self.assertEqual(result["matched"], "hit wall")
            self.assertEqual(result["buffer"], "> hit wall\n")
            self.assertEqual(fixture.calls[0]["path"], "/processes/proc-1/write")
            self.assertEqual(fixture.calls[1]["path"], "/processes/proc-1/read")

    def test_sendline_and_wait_accepts_wait_for_alias(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint, cursor=5)

            result = process.sendline_and_wait("move N", wait_for=["hit wall", "moved"], timeout_ms=1000)

            self.assertEqual(result, "hit wall")
            self.assertEqual(fixture.calls[0]["path"], "/processes/proc-1/write")
            self.assertEqual(fixture.calls[0]["body"]["data"], "move N\n")
            self.assertEqual(fixture.calls[1]["path"], "/processes/proc-1/read")

    def test_wait_for_timeout_reports_buffered_output(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint, cursor=5)

            with self.assertRaises(TimeoutError) as raised:
                process.wait_for("not present", timeout_ms=1, read_wait_ms=1)
            message = str(raised.exception)
            self.assertIn("No requested pattern matched", message)
            self.assertIn("> hit wall", message)

    def test_sendline_and_wait_rejects_unknown_kwargs(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint)

            with self.assertRaises(TypeError):
                process.sendline_and_wait("move N", wait_for="hit wall", nonsense=True)
            self.assertEqual(fixture.calls, [])

    def test_sendline_and_wait_rejects_invalid_patterns_before_write(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint)

            with self.assertRaisesRegex(TypeError, "patterns must be"):
                process.sendline_and_wait("move N", wait_for={"bad": "shape"})
            self.assertEqual(fixture.calls, [])

    def test_process_write_accepts_bytes_like_stdin(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint)

            written = process.write(b"move N\n")

            self.assertEqual(written["status"], "ACCEPTED")
            self.assertEqual(fixture.calls[0]["body"]["data"], "move N\n")

    def test_write_read_stop_accept_start_result_dict_as_process_ref(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.start("./task.sh", endpoint=fixture.endpoint)
            started = process.start_result

            written = kestrel_devshell.write(started, data="move N\n", endpoint=fixture.endpoint)
            read = kestrel_devshell.read(started, endpoint=fixture.endpoint)
            stopped = kestrel_devshell.stop(started, signal="SIGTERM", endpoint=fixture.endpoint)

            self.assertEqual(started["process_id"], "proc-1")
            self.assertEqual(written["status"], "ACCEPTED")
            self.assertEqual(read["status"], "RUNNING")
            self.assertEqual(stopped["status"], "STOPPED")
            self.assertEqual(
                [call["path"] for call in fixture.calls],
                ["/processes/start", "/processes/proc-1/write", "/processes/proc-1/read", "/processes/proc-1/stop"],
            )

    def test_write_read_stop_accept_process_object_as_process_ref(self) -> None:
        with DevShellHttpFixture() as fixture:
            process = kestrel_devshell.DevShellProcess("proc-1", endpoint=fixture.endpoint)

            written = kestrel_devshell.write(process, data="move N\n")
            read = kestrel_devshell.read(process)
            stopped = kestrel_devshell.stop(process, signal="SIGTERM")

            self.assertEqual(written["status"], "ACCEPTED")
            self.assertEqual(read["status"], "RUNNING")
            self.assertEqual(stopped["status"], "STOPPED")
            self.assertEqual(
                [call["path"] for call in fixture.calls],
                ["/processes/proc-1/write", "/processes/proc-1/read", "/processes/proc-1/stop"],
            )

    def test_top_level_write_requires_explicit_data(self) -> None:
        with DevShellHttpFixture() as fixture:
            with self.assertRaisesRegex(ValueError, "data is required"):
                kestrel_devshell.write("proc-1", endpoint=fixture.endpoint)
            self.assertEqual(fixture.calls, [])

    def test_top_level_write_allows_explicit_empty_data(self) -> None:
        with DevShellHttpFixture() as fixture:
            written = kestrel_devshell.write("proc-1", data="", endpoint=fixture.endpoint)

            self.assertEqual(written["status"], "ACCEPTED")
            self.assertEqual(fixture.calls[0]["body"]["data"], "")

    def test_unix_socket_client_uses_local_dev_shell_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            socket_path = str(Path(tmp) / "devshell.sock")
            with DevShellUnixFixture(socket_path) as fixture:
                result = kestrel_devshell.start("printf ok", endpoint=f"unix://{socket_path}").start_result

            self.assertEqual(result["status"], "RUNNING")
            self.assertEqual(result["process_id"], "proc-1")
            self.assertEqual(fixture.calls[0]["path"], "/processes/start")

    def test_env_resolution_uses_generic_bridge_only(self) -> None:
        original_generic = os.environ.get(kestrel_devshell.BRIDGE_URL_ENV)
        try:
            os.environ[kestrel_devshell.BRIDGE_URL_ENV] = "http://generic"
            self.assertEqual(kestrel_devshell.require_endpoint(), "http://generic")

            del os.environ[kestrel_devshell.BRIDGE_URL_ENV]
            with self.assertRaisesRegex(RuntimeError, "KESTREL_DEV_SHELL_BRIDGE_URL"):
                kestrel_devshell.require_endpoint()
        finally:
            restore_env(kestrel_devshell.BRIDGE_URL_ENV, original_generic)

    def test_unknown_kwargs_and_missing_process_ids_fail_clearly(self) -> None:
        with self.assertRaisesRegex(TypeError, "Unexpected keyword"):
            kestrel_devshell.run("echo ok", nonsense=True, endpoint="http://example.invalid")
        with self.assertRaisesRegex(ValueError, "process_id is required"):
            kestrel_devshell.write(data="x", endpoint="http://example.invalid")


class DevShellHandler(BaseHTTPRequestHandler):
    calls: list[dict[str, Any]]

    def do_GET(self) -> None:  # noqa: N802
        self.handle_request()

    def do_POST(self) -> None:  # noqa: N802
        self.handle_request()

    def handle_request(self) -> None:
        body = read_json(self)
        parsed = urlparse(self.path)
        self.calls.append({"method": self.command, "path": parsed.path, "query": parse_qs(parsed.query), "body": body})
        if parsed.path == "/shell/run":
            send_json(self, {"status": "COMPLETED", "stdout": "ran", "text": "ran", "truncated": False, "exitCode": 0})
            return
        if parsed.path == "/processes/start":
            send_json(self, {"processId": "proc-1", "status": "RUNNING", "text": "ready", "cursor": 0, "nextCursor": 5, "truncated": False})
            return
        if parsed.path == "/processes/proc-1/write":
            send_json(self, {"processId": "proc-1", "status": "ACCEPTED", "bytesWritten": 7})
            return
        if parsed.path == "/processes/proc-1/write_and_read":
            send_json(
                self,
                {
                    "processId": "proc-1",
                    "status": "RUNNING",
                    "text": "> moved\n",
                    "cursor": 5,
                    "nextCursor": 13,
                    "truncated": False,
                    "bytesWritten": 7,
                },
            )
            return
        if parsed.path == "/processes/proc-1/read":
            query = parse_qs(parsed.query)
            if query.get("cursor") == ["0"]:
                send_json(self, {"status": "RUNNING", "text": "ready", "cursor": 0, "nextCursor": 5, "truncated": False})
                return
            if query.get("cursor") == ["5"]:
                send_json(self, {"status": "RUNNING", "text": "> hit wall\n", "cursor": 5, "nextCursor": 16, "truncated": False})
                return
            send_json(self, {"status": "COMPLETED", "exitCode": 0, "text": "done", "cursor": 5, "nextCursor": 9, "truncated": False})
            return
        if parsed.path == "/processes/proc-1/stop":
            send_json(self, {"status": "STOPPED", "text": "", "cursor": 0, "nextCursor": 0, "truncated": False})
            return
        send_json(self, {"message": "not found"}, status=404)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class DevShellHttpFixture:
    def __enter__(self) -> "DevShellHttpFixture":
        handler = type("Handler", (DevShellHandler,), {"calls": []})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.calls = handler.calls
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.endpoint = f"http://{host}:{port}"
        return self

    def __exit__(self, *_args: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class DevShellUnixFixture:
    def __init__(self, socket_path: str) -> None:
        self.socket_path = socket_path

    def __enter__(self) -> "DevShellUnixFixture":
        handler = type("Handler", (DevShellHandler,), {"calls": []})
        self.server = socketserver.UnixStreamServer(self.socket_path, handler)
        self.calls = handler.calls
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("content-length") or "0")
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def send_json(handler: BaseHTTPRequestHandler, payload: dict[str, Any], status: int = 200) -> None:
    raw = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def restore_env(name: str, value: str | None) -> None:
    if value is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
