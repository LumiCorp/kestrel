from __future__ import annotations

import base64
import json
import os
import re
import shlex
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse


EXIT_MARKER_RE = re.compile(r"__KESTREL_CMD_DONE__:(?P<process_id>[^:\s]+):(?P<exit_code>-?\d+)")
PROTECTED_COMMAND_RE = re.compile(r"(^|[\s'\"`;&|()<>])(?:\.{1,2}/)*/?protected(?:/|$)")
STAGED_COMMAND_LENGTH_THRESHOLD = 2000


@dataclass
class BridgeProcess:
    process_id: str
    command: str
    cwd: str
    submitted_at: str
    pane_target: str
    output_cursor: int = 0
    exit_code: int | None = None
    completed_at: str | None = None
    stopped: bool = False
    failure_reason: str | None = None


class TmuxDevShellBridge:
    def __init__(self, session: Any, workspace_root: str = "/app") -> None:
        self.session = session
        self.workspace_root = workspace_root
        self.started_at = iso_now()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._processes: dict[str, BridgeProcess] = {}
        self._lock = threading.Lock()

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("Terminal-Bench dev shell bridge is not started")
        host, port = self._server.server_address
        return f"http://{host}:{port}"

    def start(self) -> None:
        if self._server is not None:
            return
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                bridge._handle(self)

            def do_POST(self) -> None:  # noqa: N802
                bridge._handle(self)

            def log_message(self, _format: str, *_args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        with self._lock:
            processes = list(self._processes.values())
        for process in processes:
            if not process.stopped and process.exit_code is None:
                process.stopped = True
                self._send_control_to_pane(process.pane_target, "C-c")
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        try:
            parsed = urlparse(handler.path)
            body = read_json(handler)
            if handler.command == "POST" and parsed.path == "/shell/run":
                self._send(handler, self._run(body))
                return
            if handler.command == "POST" and parsed.path == "/processes/start":
                self._send(handler, self._start(body))
                return
            parts = parsed.path.strip("/").split("/")
            if len(parts) == 3 and parts[0] == "processes":
                process_id = parts[1]
                action = parts[2]
                if handler.command == "POST" and action == "write":
                    self._send(handler, self._write(process_id, body))
                    return
                if handler.command == "POST" and action == "write_and_read":
                    self._send(handler, self._write_and_read(process_id, body))
                    return
                if action == "read" and handler.command in {"GET", "POST"}:
                    query = parse_qs(parsed.query) if handler.command == "GET" else body
                    self._send(handler, self._read(process_id, query))
                    return
                if handler.command == "POST" and action == "stop":
                    self._send(handler, self._stop(process_id, body))
                    return
            self._send(handler, {"code": "NOT_FOUND", "message": f"Unsupported path {parsed.path}"}, status=404)
        except Exception as error:
            self._send(handler, {"code": error.__class__.__name__, "message": str(error)}, status=500)

    def _run(self, body: dict[str, Any]) -> dict[str, Any]:
        result = self._start(body)
        process_id = result.get("processId")
        if isinstance(process_id, str):
            timeout_ms = parse_int(first_value(body, "timeoutMs", "30000"), 30000)
            deadline = time.time() + timeout_ms / 1000
            process = self._process_for(process_id)
            while process.exit_code is None and time.time() < deadline:
                full = self._capture_pane(process.pane_target)
                self._refresh_status(process, full)
                time.sleep(0.02)
            if process.exit_code is None:
                process.failure_reason = f"dev.shell.run timed out after {timeout_ms} ms and interrupted the process."
                self._send_control_to_pane(process.pane_target, "C-c")
            result = self._result_for(process_id, {"cursor": 0, "maxBytes": first_value(body, "maxOutputBytes", "131072")})
        return {
            "status": result.get("status", "FAILED"),
            "stdout": result.get("text", ""),
            "text": result.get("text", ""),
            "truncated": result.get("truncated", False),
            "command": result.get("command"),
            "cwd": result.get("cwd"),
            "workspaceRoot": result.get("workspaceRoot"),
            "submittedAt": result.get("submittedAt"),
            "startedAt": result.get("startedAt"),
            "updatedAt": result.get("updatedAt"),
            "completedAt": result.get("completedAt"),
            "exitCode": result.get("exitCode"),
            "failureReason": result.get("failureReason"),
        }

    def _start(self, body: dict[str, Any]) -> dict[str, Any]:
        command = str(body.get("command") or "").strip()
        if not command:
            raise ValueError("Missing command")
        workspace_root = resolve_bridge_workspace_path(body.get("workspaceRoot"), self.workspace_root)
        cwd = resolve_bridge_workspace_path(body.get("cwd"), workspace_root)
        try:
            reject_protected_access(command=command, workspace_root=workspace_root, cwd=cwd)
        except PermissionError as error:
            return protected_access_failure_result(
                message=str(error),
                command=command,
                cwd=cwd,
                workspace_root=workspace_root,
                options=body,
            )
        self.workspace_root = workspace_root
        process_id = f"tb-proc-{uuid.uuid4().hex[:12]}"
        submitted_at = iso_now()
        pane_target = self._new_process_pane(cwd)
        process = BridgeProcess(
            process_id=process_id,
            command=command,
            cwd=cwd,
            submitted_at=submitted_at,
            pane_target=pane_target,
        )
        with self._lock:
            self._processes[process_id] = process
        if should_stage_command(command):
            self._send_staged_command_to_pane(
                pane_target=pane_target,
                command=command,
                cwd=cwd,
                workspace_root=workspace_root,
                process_id=process_id,
            )
        else:
            self._send_command_to_pane(pane_target, render_wrapped_command(command, cwd, process_id))
        wait_for_yield(body, default_ms=1000)
        return self._result_for(process_id, body)

    def _write(self, process_id: str, body: dict[str, Any]) -> dict[str, Any]:
        data = body.get("data")
        if not isinstance(data, str):
            raise ValueError("Missing data")
        process = self._process_for(process_id)
        full = self._capture_pane(process.pane_target)
        self._refresh_status(process, full)
        if process.exit_code is not None or process.stopped:
            return {
                "processId": process_id,
                "status": "FAILED",
                "bytesWritten": 0,
                "message": "Process is not running.",
            }
        self._send_to_pane(process.pane_target, data)
        return {
            "processId": process_id,
            "status": "ACCEPTED",
            "bytesWritten": len(data.encode("utf-8")),
        }

    def _write_and_read(self, process_id: str, body: dict[str, Any]) -> dict[str, Any]:
        process = self._process_for(process_id)
        full = self._capture_pane(process.pane_target)
        cursor = len(full)
        result = self._write(process_id, body)
        if result.get("status") == "FAILED":
            return result
        read_options = {
            **body,
            "cursor": first_value(body, "cursor", str(cursor)),
        }
        read_result = self._read(process_id, read_options)
        read_result["bytesWritten"] = result.get("bytesWritten", 0)
        return read_result

    def _read(self, process_id: str, query_or_body: dict[str, Any]) -> dict[str, Any]:
        wait_for_yield(query_or_body)
        return self._result_for(process_id, query_or_body)

    def _stop(self, process_id: str, body: dict[str, Any]) -> dict[str, Any]:
        process = self._process_for(process_id)
        process.stopped = True
        self._send_control_to_pane(process.pane_target, "C-c")
        wait_for_yield(body)
        return self._result_for(process_id, body)

    def _result_for(self, process_id: str, options: dict[str, Any]) -> dict[str, Any]:
        process = self._process_for(process_id)
        full = self._capture_pane(process.pane_target)
        self._refresh_status(process, full)
        max_bytes = parse_int(first_value(options, "maxBytes", "maxOutputBytes", "131072"), 131072)
        cursor = parse_int(first_value(options, "cursor", "0"), 0)
        safe_cursor = max(0, min(cursor, len(full)))
        chunk = full[safe_cursor : safe_cursor + max_bytes]
        next_cursor = safe_cursor + len(chunk)
        process.output_cursor = max(process.output_cursor, len(full))
        submitted_at = process.submitted_at
        if process.failure_reason is not None:
            status = "FAILED"
        elif process.stopped:
            status = "STOPPED"
        elif process.exit_code is None:
            status = "RUNNING"
        elif process.exit_code == 0:
            status = "COMPLETED"
        elif process.exit_code is not None:
            status = "FAILED"
        else:
            status = "LOST"
        response: dict[str, Any] = {
            "status": status,
            "text": chunk,
            "truncated": next_cursor < len(full),
            "cursor": safe_cursor,
            "nextCursor": next_cursor,
            "command": process.command,
            "cwd": process.cwd,
            "workspaceRoot": self.workspace_root,
            "submittedAt": submitted_at,
            "startedAt": submitted_at,
            "updatedAt": iso_now(),
        }
        if status in {"RUNNING", "STOPPED"}:
            response["processId"] = process_id
        if process.exit_code is not None:
            response["exitCode"] = process.exit_code
            response["completedAt"] = process.completed_at or iso_now()
        if process.failure_reason is not None:
            response["exitCode"] = 124
            response.setdefault("completedAt", process.completed_at or iso_now())
            response["failureReason"] = process.failure_reason
        return response

    def _refresh_status(self, process: BridgeProcess, full: str) -> None:
        if process.exit_code is not None:
            return
        matches = list(EXIT_MARKER_RE.finditer(full))
        for match in reversed(matches):
            if match.group("process_id") == process.process_id:
                process.exit_code = int(match.group("exit_code"))
                process.completed_at = iso_now()
                return

    def _process_for(self, process_id: str) -> BridgeProcess:
        with self._lock:
            process = self._processes.get(process_id)
        if process is None:
            raise RuntimeError(f"Unknown dev process. (processId={process_id})")
        return process

    def _new_process_pane(self, cwd: str) -> str:
        if self._has_session_api():
            return "__terminal_bench_session__"
        session_target = self._session_target()
        if session_target is None:
            raise RuntimeError("Cannot determine tmux session target for multi-process dev shell bridge")
        completed = subprocess.run(
            [
                "tmux",
                "new-window",
                "-P",
                "-F",
                "#{pane_id}",
                "-t",
                session_target,
                "-c",
                cwd,
            ],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return completed.stdout.strip()

    def _session_target(self) -> str | None:
        for name in ("session_name", "_session_name", "tmux_session_name", "name"):
            value = getattr(self.session, name, None)
            if isinstance(value, str) and value.strip():
                return value.strip()
        inner = getattr(self.session, "session", None)
        if inner is not None:
            for name in ("session_name", "name", "id"):
                value = getattr(inner, name, None)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return None

    def _capture_pane(self, pane_target: str) -> str:
        if pane_target == "__terminal_bench_session__" and hasattr(self.session, "capture_pane"):
            return str(self.session.capture_pane(capture_entire=True))
        completed = subprocess.run(
            ["tmux", "capture-pane", "-p", "-J", "-S", "-", "-t", pane_target],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return completed.stdout

    def _send_to_pane(self, pane_target: str, chars: str) -> None:
        if pane_target == "__terminal_bench_session__" and hasattr(self.session, "send_keys"):
            self._session_send_keys([chars])
            return
        buffer_name = f"kestrel-{uuid.uuid4().hex}"
        subprocess.run(
            ["tmux", "load-buffer", "-b", buffer_name, "-"],
            input=chars,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            subprocess.run(
                ["tmux", "paste-buffer", "-d", "-b", buffer_name, "-t", pane_target],
                check=True,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        finally:
            subprocess.run(
                ["tmux", "delete-buffer", "-b", buffer_name],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

    def _send_command_to_pane(self, pane_target: str, command: str) -> None:
        if pane_target == "__terminal_bench_session__" and hasattr(self.session, "send_keys"):
            self._session_send_keys([command, "Enter"])
            return
        subprocess.run(
            ["tmux", "send-keys", "-t", pane_target, "--", command, "Enter"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def _send_control_to_pane(self, pane_target: str, key: str) -> None:
        if pane_target == "__terminal_bench_session__" and hasattr(self.session, "send_keys"):
            self._session_send_keys([key])
            return
        subprocess.run(
            ["tmux", "send-keys", "-t", pane_target, key],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def _send_staged_command_to_pane(
        self,
        *,
        pane_target: str,
        command: str,
        cwd: str,
        workspace_root: str,
        process_id: str,
    ) -> None:
        stage_dir = os.path.join(workspace_root, ".kestrel-tbench", "commands")
        script_path = os.path.join(stage_dir, f"{process_id}.sh")
        if is_protected_path(stage_dir) or is_protected_path(script_path):
            raise PermissionError("Terminal-Bench protected path is not available for staged commands")
        encoded_path = f"{script_path}.b64"
        encoded = base64.b64encode(command.encode("utf-8")).decode("ascii")
        self._send_command_to_pane(
            pane_target,
            f"mkdir -p {shlex.quote(stage_dir)} && : > {shlex.quote(encoded_path)}",
        )
        for chunk in chunk_text(encoded, 512):
            self._send_command_to_pane(
                pane_target,
                f"printf %s {shlex.quote(chunk)} >> {shlex.quote(encoded_path)}",
            )
        self._send_command_to_pane(
            pane_target,
            (
                f"base64 -d {shlex.quote(encoded_path)} > {shlex.quote(script_path)} && "
                f"chmod 700 {shlex.quote(script_path)}"
            ),
        )
        self._send_command_to_pane(
            pane_target,
            render_wrapped_command(f"/bin/bash {shlex.quote(script_path)}", cwd, process_id),
        )

    def _has_session_api(self) -> bool:
        return hasattr(self.session, "send_keys") and hasattr(self.session, "capture_pane")

    def _session_send_keys(self, keys: list[str]) -> None:
        try:
            self.session.send_keys(keys, block=False, min_timeout_sec=0.0, max_timeout_sec=1.0)
        except TypeError:
            self.session.send_keys(keys)

    def _send(self, handler: BaseHTTPRequestHandler, payload: dict[str, Any], status: int = 200) -> None:
        raw = json.dumps(payload).encode("utf-8")
        try:
            handler.send_response(status)
            handler.send_header("content-type", "application/json")
            handler.send_header("content-length", str(len(raw)))
            handler.end_headers()
            handler.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            return


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("content-length") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8")
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Bridge request body must be a JSON object")
    return parsed


def first_value(values: dict[str, Any], *keys_and_default: str) -> str:
    *keys, default = keys_and_default
    for key in keys:
        raw = values.get(key)
        if isinstance(raw, list):
            raw = raw[0] if raw else None
        if raw is not None:
            return str(raw)
    return default


def parse_int(value: str, default: int) -> int:
    try:
        return max(0, int(value))
    except ValueError:
        return default


def wait_for_yield(options: dict[str, Any], default_ms: int = 0) -> None:
    value = first_value(options, "yieldTimeMs", str(default_ms))
    try:
        delay = max(0, min(int(value), 5000)) / 1000.0
    except ValueError:
        delay = 0
    if delay > 0:
        time.sleep(delay)


def failure_result(message: str, options: dict[str, Any]) -> dict[str, Any]:
    max_bytes = parse_int(first_value(options, "maxOutputBytes", "131072"), 131072)
    chunk = f"{message}\n"[:max_bytes]
    now = iso_now()
    return {
        "status": "FAILED",
        "text": chunk,
        "truncated": len(chunk) < len(message) + 1,
        "cursor": 0,
        "nextCursor": len(chunk),
        "exitCode": 1,
        "submittedAt": now,
        "startedAt": now,
        "updatedAt": now,
        "completedAt": now,
    }


def protected_access_failure_result(
    *,
    message: str,
    command: str,
    cwd: str,
    workspace_root: str,
    options: dict[str, Any],
) -> dict[str, Any]:
    max_bytes = parse_int(first_value(options, "maxOutputBytes", "131072"), 131072)
    chunk = f"{message}\n"[:max_bytes]
    now = iso_now()
    return {
        "status": "FAILED",
        "text": chunk,
        "truncated": len(chunk) < len(message) + 1,
        "cursor": 0,
        "nextCursor": len(chunk),
        "command": command,
        "cwd": cwd,
        "workspaceRoot": workspace_root,
        "securityMode": "blocked_protected_path",
        "exitCode": 126,
        "submittedAt": now,
        "startedAt": now,
        "updatedAt": now,
        "completedAt": now,
    }


def is_within_workspace(candidate: str, workspace_root: str) -> bool:
    root = os.path.abspath(workspace_root)
    path = os.path.abspath(candidate)
    return path == root or path.startswith(f"{root}{os.sep}")


def resolve_workspace_path(value: Any, fallback: str) -> str:
    raw = str(value or "").strip()
    if raw == "" or raw == ".":
        return fallback
    if os.path.isabs(raw):
        return raw
    return os.path.normpath(os.path.join(fallback, raw))


def resolve_bridge_workspace_path(value: Any, fallback: str) -> str:
    raw = str(value or "").strip()
    if raw == "" or raw == ".":
        return fallback
    if os.path.isabs(raw):
        # The host runner may inject its own cwd into dev-shell tool inputs. This
        # bridge always executes inside the Terminal-Bench task workspace.
        if is_protected_path(raw):
            return raw
        if is_within_workspace(raw, fallback):
            return raw
        return fallback
    return os.path.normpath(os.path.join(fallback, raw))


def reject_protected_access(command: str, workspace_root: str, cwd: str) -> None:
    if is_protected_path(workspace_root):
        raise PermissionError("Terminal-Bench protected path is not available as workspaceRoot")
    if is_protected_path(cwd):
        raise PermissionError("Terminal-Bench protected path is not available as cwd")
    if PROTECTED_COMMAND_RE.search(command) is not None:
        raise PermissionError("Terminal-Bench protected path is not available to agent shell commands")


def is_protected_path(path: str) -> bool:
    normalized = os.path.realpath(path)
    return normalized == "/protected" or normalized.startswith("/protected/")


def should_stage_command(command: str) -> bool:
    return "\n" in command or len(command) > STAGED_COMMAND_LENGTH_THRESHOLD


def render_wrapped_command(command: str, cwd: str, process_id: str) -> str:
    return (
        f"set +H; cd {shlex.quote(cwd)} && ( {command} ); "
        f"printf '\\n__KESTREL_CMD_DONE__:{process_id}:%s\\n' \"$?\""
    )


def chunk_text(value: str, size: int) -> list[str]:
    return [value[index : index + size] for index in range(0, len(value), size)]


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
