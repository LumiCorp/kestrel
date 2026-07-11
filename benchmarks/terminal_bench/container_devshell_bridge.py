from __future__ import annotations

import json
import hashlib
import os
import pwd
import re
import shlex
import shutil
import stat
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

PROTECTED_COMMAND_RE = re.compile(r"(^|[\s'\"`;&|()<>])(?:\.{1,2}/)*/?protected(?:/|$)")
AGENT_USER_ENV = "KESTREL_TBENCH_AGENT_USER"
BRIDGE_URL_ENV = "KESTREL_DEV_SHELL_BRIDGE_URL"
SIMPLE_COMMAND_META_RE = re.compile(r"[\n;&|<>`$()]")


@dataclass
class RunningProcess:
    process_id: str
    command: str
    cwd: str
    workspace_root: str
    submitted_at: str
    process: subprocess.Popen[str]
    security_mode: str
    display_command: str | None = None
    before_snapshot: dict[str, str] | None = None
    changed_files: list[str] | None = None
    output: str = ""
    output_cursor: int = 0
    exit_code: int | None = None
    completed_at: str | None = None
    stopped: bool = False
    failure_reason: str | None = None


@dataclass(frozen=True)
class ProtectedEntrypoint:
    path: str
    digest: str
    private_path: str | None = None
    shim_digest: str | None = None


@dataclass(frozen=True)
class AgentProcessIdentity:
    uid: int
    gid: int


class ContainerDevShellBridge:
    def __init__(
        self,
        workspace_root: str = "/app",
        log_path: str | None = None,
        managed_entrypoint_root: str | None = None,
    ) -> None:
        self.workspace_root = workspace_root
        self.log_path = log_path or os.environ.get("KESTREL_TBENCH_BRIDGE_LOG_PATH")
        self.managed_entrypoint_root = managed_entrypoint_root or os.environ.get(
            "KESTREL_TBENCH_MANAGED_ENTRYPOINT_ROOT",
            "/installed-agent/managed-entrypoints",
        )
        self.started_at = iso_now()
        self._lock = threading.Lock()
        self._processes: dict[str, RunningProcess] = {}
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._protected_entrypoints_root: str | None = None
        self._protected_entrypoints: dict[str, ProtectedEntrypoint] = {}
        self._managed_entrypoint_private_roots: set[str] = set()
        self._prepared_workspace_roots: set[str] = set()

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("bridge not started")
        host, port = self._server.server_address
        return f"http://{host}:{port}"

    def start(self) -> None:
        self._refresh_protected_entrypoints(self.workspace_root)
        self._install_protected_entrypoint_shims(self.workspace_root)
        self._prepare_agent_filesystem_boundary(self.workspace_root)
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
        for running in processes:
            if running.process.poll() is None:
                running.stopped = True
                running.process.terminate()
                try:
                    running.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    running.process.kill()
                    running.process.wait(timeout=2)
            for stream in (running.process.stdin, running.process.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except ValueError:
                        pass
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        try:
            parsed = urlparse(handler.path)
            body = read_json(handler)
            self._log("request", {"method": handler.command, "path": parsed.path, "body": body})
            if handler.command == "POST" and parsed.path == "/shell/run":
                self._send(handler, self._run(body))
                return
            if handler.command == "POST" and parsed.path == "/processes/start":
                self._send(handler, self._start(body))
                return
            if handler.command == "POST" and parsed.path == "/entrypoints/start":
                self._send(handler, self._start_entrypoint(body))
                return
            if handler.command == "POST" and parsed.path in {
                "/processes/write",
                "/processes/write_and_read",
                "/processes/read",
                "/processes/stop",
                "/processes/close_stdin",
            }:
                process_id = body.get("processId")
                if not isinstance(process_id, str) or not process_id:
                    raise ValueError("Missing processId")
                action = parsed.path.rsplit("/", 1)[-1]
                if action == "write":
                    self._send(handler, self._write(process_id, body))
                    return
                if action == "write_and_read":
                    self._send(handler, self._write_and_read(process_id, body))
                    return
                if action == "close_stdin":
                    self._send(handler, self._close_stdin(process_id, body))
                    return
                if action == "read":
                    self._send(handler, self._read(process_id, body))
                    return
                if action == "stop":
                    self._send(handler, self._stop(process_id, body))
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
                if handler.command == "POST" and action == "close_stdin":
                    self._send(handler, self._close_stdin(process_id, body))
                    return
                if action == "read" and handler.command in {"GET", "POST"}:
                    query = parse_qs(parsed.query) if handler.command == "GET" else body
                    self._send(handler, self._read(process_id, query))
                    return
                if handler.command == "POST" and action == "stop":
                    self._send(handler, self._stop(process_id, body))
                    return
            self._send(handler, {"code": "NOT_FOUND", "message": parsed.path}, status=404)
        except Exception as error:
            self._send(handler, {"code": error.__class__.__name__, "message": str(error)}, status=500)

    def _run(self, body: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            before_process_ids = set(self._processes)
        result = self._start(body)
        process_id = result.get("processId")
        if not isinstance(process_id, str):
            with self._lock:
                new_process_ids = [process_id for process_id in self._processes if process_id not in before_process_ids]
            if len(new_process_ids) == 1:
                process_id = new_process_ids[0]
        if not isinstance(process_id, str):
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
                "exitCode": result.get("exitCode", 1),
                "securityMode": result.get("securityMode"),
                "failureReason": result.get("failureReason"),
            }
        timeout_ms = parse_int(first_value(body, "timeoutMs", "30000"), 30000)
        run_changed_files: list[str] = []
        with self._lock:
            running = self._processes.get(process_id)
        if running is not None:
            try:
                running.process.wait(timeout=timeout_ms / 1000)
            except subprocess.TimeoutExpired:
                running.failure_reason = f"dev.shell.run timed out after {timeout_ms} ms and killed the process."
                running.process.kill()
                running.process.wait(timeout=2)
            after_snapshot = snapshot_workspace_files(
                running.workspace_root,
                excluded_roots=self._managed_entrypoint_private_roots,
            )
            run_changed_files = changed_workspace_files(running.before_snapshot or {}, after_snapshot)
            with self._lock:
                if running.changed_files is None:
                    running.changed_files = run_changed_files
            telemetry_deadline = time.time() + 2
            while time.time() < telemetry_deadline:
                with self._lock:
                    telemetry_ready = running.exit_code is not None and running.changed_files is not None
                if telemetry_ready:
                    break
                time.sleep(0.02)
            with self._lock:
                needs_changed_file_fallback = running.changed_files is None and running.process.poll() is not None
                before_snapshot = running.before_snapshot or {}
                running_workspace_root = running.workspace_root
            if needs_changed_file_fallback:
                after_snapshot = snapshot_workspace_files(
                    running_workspace_root,
                    excluded_roots=self._managed_entrypoint_private_roots,
                )
                with self._lock:
                    if running.changed_files is None:
                        running.changed_files = changed_workspace_files(before_snapshot, after_snapshot)
        result = self._result_for(process_id, {"cursor": 0, "maxBytes": first_value(body, "maxOutputBytes", "131072")})
        if "changedFiles" not in result and result.get("status") != "RUNNING":
            with self._lock:
                running = self._processes.get(process_id)
                before_snapshot = running.before_snapshot if running is not None else {}
                running_workspace_root = running.workspace_root if running is not None else self.workspace_root
            if running is not None:
                after_snapshot = snapshot_workspace_files(
                    running_workspace_root,
                    excluded_roots=self._managed_entrypoint_private_roots,
                )
                fallback_changed_files = changed_workspace_files(before_snapshot or {}, after_snapshot)
                with self._lock:
                    if running.changed_files is None:
                        running.changed_files = fallback_changed_files
                if fallback_changed_files:
                    result["changedFiles"] = fallback_changed_files
        with self._lock:
            running_changed_files = list(running.changed_files or []) if running is not None else []
        changed_files = result.get("changedFiles") if isinstance(result.get("changedFiles"), list) and result.get("changedFiles") else running_changed_files or run_changed_files
        if not changed_files and running is not None and result.get("status") != "RUNNING":
            for _attempt in range(10):
                changed_files = changed_workspace_files(
                    running.before_snapshot or {},
                    snapshot_workspace_files(
                        running.workspace_root,
                        excluded_roots=self._managed_entrypoint_private_roots,
                    ),
                )
                if changed_files:
                    break
                time.sleep(0.02)
            if changed_files:
                with self._lock:
                    running.changed_files = changed_files
        if not changed_files and running is not None and result.get("status") != "RUNNING":
            time.sleep(0.05)
            with self._lock:
                changed_files = list(running.changed_files or [])
            if not changed_files:
                changed_files = changed_workspace_files(
                    running.before_snapshot or {},
                    snapshot_workspace_files(
                        running.workspace_root,
                        excluded_roots=self._managed_entrypoint_private_roots,
                    ),
                )
        response = {
            "status": result["status"],
            "stdout": result["text"],
            "text": result["text"],
            "truncated": result["truncated"],
            "command": result.get("command"),
            "cwd": result.get("cwd"),
            "workspaceRoot": result.get("workspaceRoot"),
            "submittedAt": result.get("submittedAt"),
            "startedAt": result.get("startedAt"),
            "updatedAt": result.get("updatedAt"),
            "completedAt": result.get("completedAt"),
            "exitCode": result.get("exitCode"),
            "securityMode": result.get("securityMode"),
            "failureReason": result.get("failureReason"),
        }
        if changed_files:
            response["changedFiles"] = changed_files
        return response

    def _start(self, body: dict[str, Any]) -> dict[str, Any]:
        command = str(body.get("command") or "").strip()
        if not command:
            raise ValueError("Missing command")
        display_command = command
        workspace_root = resolve_workspace_path(body.get("workspaceRoot"), self.workspace_root)
        cwd = resolve_workspace_path(body.get("cwd"), workspace_root)
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
        modified_entrypoint_error = self._modified_protected_entrypoint_error(
            command=command,
            cwd=cwd,
            workspace_root=workspace_root,
        )
        if modified_entrypoint_error is not None:
            return protected_access_failure_result(
                message=modified_entrypoint_error,
                command=command,
                cwd=cwd,
                workspace_root=workspace_root,
                options=body,
            )
        protected_entrypoint = self._matches_unmodified_protected_entrypoint(
            command=command,
            cwd=cwd,
            workspace_root=workspace_root,
        )
        if protected_entrypoint is not None:
            command = render_protected_entrypoint_command(
                command=command,
                cwd=cwd,
                workspace_root=workspace_root,
                entrypoint=protected_entrypoint,
            )
        return self._spawn_process(
            command=command,
            display_command=display_command,
            cwd=cwd,
            workspace_root=workspace_root,
            body=body,
            protected_entrypoint=protected_entrypoint,
        )

    def _start_entrypoint(self, body: dict[str, Any]) -> dict[str, Any]:
        workspace_root = resolve_workspace_path(body.get("workspaceRoot"), self.workspace_root)
        cwd = resolve_workspace_path(body.get("cwd"), workspace_root)
        entrypoint_path_raw = str(body.get("path") or body.get("entrypointPath") or "").strip()
        if not entrypoint_path_raw:
            raise ValueError("Missing entrypoint path")
        entrypoint_path = os.path.realpath(resolve_workspace_path(entrypoint_path_raw, workspace_root))
        self._refresh_protected_entrypoints(workspace_root)
        entrypoint = self._protected_entrypoints.get(entrypoint_path)
        if entrypoint is None:
            return protected_access_failure_result(
                message="Terminal-Bench managed task entrypoint is not registered.",
                command=entrypoint_path_raw,
                cwd=cwd,
                workspace_root=workspace_root,
                options=body,
            )
        modified_error = self._modified_public_entrypoint_error(entrypoint)
        if modified_error is not None:
            return protected_access_failure_result(
                message=modified_error,
                command=entrypoint_path_raw,
                cwd=cwd,
                workspace_root=workspace_root,
                options=body,
            )
        if not self._private_entrypoint_digest_is_valid(entrypoint):
            return protected_access_failure_result(
                message="Terminal-Bench protected task entrypoint is unavailable.",
                command=entrypoint_path_raw,
                cwd=cwd,
                workspace_root=workspace_root,
                options=body,
            )
        raw_argv = body.get("argv")
        argv = [str(value) for value in raw_argv] if isinstance(raw_argv, list) else []
        private_path = entrypoint.private_path or entrypoint.path
        command = shlex.join([private_path, *argv])
        display_command = shlex.join([entrypoint.path, *argv])
        return self._spawn_process(
            command=command,
            display_command=display_command,
            cwd=cwd,
            workspace_root=workspace_root,
            body=body,
            protected_entrypoint=entrypoint,
        )

    def _spawn_process(
        self,
        *,
        command: str,
        display_command: str,
        cwd: str,
        workspace_root: str,
        body: dict[str, Any],
        protected_entrypoint: ProtectedEntrypoint | None = None,
    ) -> dict[str, Any]:
        self._prepare_agent_filesystem_boundary(workspace_root)
        self.workspace_root = workspace_root

        process_id = f"tb-proc-{uuid.uuid4().hex[:12]}"
        submitted_at = iso_now()
        before_snapshot = snapshot_workspace_files(
            workspace_root,
            excluded_roots=self._managed_entrypoint_private_roots,
        )
        security_kwargs = {} if protected_entrypoint is not None else agent_process_security_kwargs()
        security_mode = "protected_entrypoint" if protected_entrypoint is not None else agent_process_security_mode()
        process = subprocess.Popen(
            command,
            cwd=cwd,
            shell=True,
            executable="/bin/bash",
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=self._agent_environment(),
            **security_kwargs,
        )
        running = RunningProcess(
            process_id=process_id,
            command=command,
            cwd=cwd,
            workspace_root=workspace_root,
            submitted_at=submitted_at,
            process=process,
            security_mode=security_mode,
            display_command=display_command,
            before_snapshot=before_snapshot,
            output="" if body.get("suppressCommandEcho") is True else f"\n$ {display_command}\n",
        )
        with self._lock:
            self._processes[process_id] = running
        threading.Thread(target=self._drain, args=(running,), daemon=True).start()
        wait_for_yield(body, default_ms=1000)
        return self._result_for(process_id, body)

    def _agent_environment(self) -> dict[str, str]:
        self._refresh_protected_entrypoints(self.workspace_root)
        env = os.environ.copy()
        if self._server is not None:
            env[BRIDGE_URL_ENV] = self.url
        bridge_dir = os.path.dirname(os.path.realpath(__file__))
        helper_paths = [
            "/installed-agent",
            bridge_dir,
            os.path.realpath(os.path.join(bridge_dir, "..", "..", "src", "devshell")),
        ]
        existing = env.get("PYTHONPATH")
        if existing:
            helper_paths.append(existing)
        env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(path for path in helper_paths if path))
        return env

    def _matches_unmodified_protected_entrypoint(
        self,
        *,
        command: str,
        cwd: str,
        workspace_root: str,
    ) -> ProtectedEntrypoint | None:
        self._refresh_protected_entrypoints(workspace_root)
        return match_unmodified_protected_entrypoint(
            command=command,
            cwd=cwd,
            workspace_root=workspace_root,
            entrypoints=self._protected_entrypoints,
        )

    def _refresh_protected_entrypoints(self, workspace_root: str) -> None:
        workspace_root = os.path.realpath(workspace_root)
        if self._protected_entrypoints_root == workspace_root:
            return
        self._protected_entrypoints_root = workspace_root
        self._protected_entrypoints = discover_protected_entrypoints(workspace_root)

    def _install_protected_entrypoint_shims(self, workspace_root: str) -> None:
        if not self._protected_entrypoints:
            return
        root = os.path.realpath(self.managed_entrypoint_root)
        try:
            os.makedirs(root, mode=0o700, exist_ok=True)
        except PermissionError:
            root = os.path.join(os.path.realpath(workspace_root), ".kestrel-managed-entrypoints")
            os.makedirs(root, mode=0o700, exist_ok=True)
        try:
            os.chmod(root, 0o700)
        except OSError:
            pass
        self._managed_entrypoint_private_roots.add(root)

        updated: dict[str, ProtectedEntrypoint] = {}
        for public_path, entrypoint in self._protected_entrypoints.items():
            if entrypoint.private_path is not None:
                updated[public_path] = entrypoint
                continue
            digest_dir = os.path.join(root, entrypoint.digest)
            os.makedirs(digest_dir, mode=0o700, exist_ok=True)
            try:
                os.chmod(digest_dir, 0o700)
            except OSError:
                pass
            private_path = os.path.join(digest_dir, os.path.basename(entrypoint.path))
            shutil.copy2(entrypoint.path, private_path)
            try:
                os.chmod(private_path, 0o700)
            except OSError:
                pass
            shim = render_entrypoint_shim(
                public_path=entrypoint.path,
                workspace_root=os.path.realpath(workspace_root),
            )
            with open(entrypoint.path, "w", encoding="utf-8") as handle:
                handle.write(shim)
            os.chmod(entrypoint.path, 0o755)
            updated[public_path] = ProtectedEntrypoint(
                path=entrypoint.path,
                digest=entrypoint.digest,
                private_path=private_path,
                shim_digest=hashlib.sha256(shim.encode("utf-8")).hexdigest(),
            )
        self._protected_entrypoints = updated

    def _prepare_agent_filesystem_boundary(self, workspace_root: str) -> None:
        workspace_root = os.path.realpath(workspace_root)
        if workspace_root in self._prepared_workspace_roots:
            return
        excluded_roots = list(self._managed_entrypoint_private_roots)
        for entrypoint in self._protected_entrypoints.values():
            if entrypoint.private_path is not None:
                excluded_roots.append(os.path.dirname(entrypoint.private_path))
        prepare_agent_filesystem_boundary(workspace_root, excluded_roots=excluded_roots)
        self._prepared_workspace_roots.add(workspace_root)

    def _modified_protected_entrypoint_error(
        self,
        *,
        command: str,
        cwd: str,
        workspace_root: str,
    ) -> str | None:
        reference = parse_protected_entrypoint_command_reference(
            command=command,
            cwd=cwd,
            workspace_root=workspace_root,
            entrypoints=self._protected_entrypoints,
        )
        if reference is None:
            return None
        entrypoint, matched_path = reference
        if os.path.realpath(matched_path) != os.path.realpath(entrypoint.path):
            return None
        return self._modified_public_entrypoint_error(entrypoint)

    def _modified_public_entrypoint_error(self, entrypoint: ProtectedEntrypoint) -> str | None:
        if entrypoint.shim_digest is None:
            return None
        try:
            with open(entrypoint.path, "rb") as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()
        except OSError:
            return "Terminal-Bench protected task entrypoint is unavailable."
        if digest == entrypoint.shim_digest:
            return None
        return "Terminal-Bench protected task entrypoint was modified and cannot use protected execution."

    def _private_entrypoint_digest_is_valid(self, entrypoint: ProtectedEntrypoint) -> bool:
        digest_path = entrypoint.private_path or entrypoint.path
        try:
            with open(digest_path, "rb") as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()
        except OSError:
            return False
        return digest == entrypoint.digest

    def _write(self, process_id: str, body: dict[str, Any]) -> dict[str, Any]:
        raw_data = body.get("data", body.get("input"))
        if not isinstance(raw_data, str):
            raise ValueError("Missing data")
        data = raw_data
        with self._lock:
            running = self._processes.get(process_id)
        if running is None:
            raise RuntimeError(f"dev.process.write requires a known process. (processId={process_id})")
        if running.process.poll() is not None:
            return self._result_for(process_id, body)
        if running.process.stdin is None:
            raise RuntimeError("Process stdin is unavailable")
        running.process.stdin.write(data)
        running.process.stdin.flush()
        return {
            "processId": process_id,
            "status": "ACCEPTED",
            "bytesWritten": len(data.encode("utf-8")),
        }

    def _write_and_read(self, process_id: str, body: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            running = self._processes.get(process_id)
            cursor = len(running.output) if running is not None else 0
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

    def _close_stdin(self, process_id: str, _body: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            running = self._processes.get(process_id)
        if running is None:
            raise RuntimeError(f"dev.process.close_stdin requires a known process. (processId={process_id})")
        if running.process.stdin is not None and not running.process.stdin.closed:
            running.process.stdin.close()
        return {
            "processId": process_id,
            "status": "ACCEPTED",
        }

    def _read(self, process_id: str, query_or_body: dict[str, Any]) -> dict[str, Any]:
        wait_for_yield(query_or_body)
        return self._result_for(process_id, query_or_body)

    def _stop(self, process_id: str, body: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            running = self._processes.get(process_id)
            if running is None:
                raise RuntimeError(f"dev.process.stop requires a known process. (processId={process_id})")
            running.stopped = True
        if running.process.poll() is None:
            running.process.terminate()
        wait_for_yield(body)
        return self._result_for(process_id, body)

    def _drain(self, running: RunningProcess) -> None:
        assert running.process.stdout is not None
        try:
            while True:
                chunk = running.process.stdout.read(1)
                if chunk == "":
                    break
                with self._lock:
                    running.output += chunk
        except ValueError:
            pass
        exit_code = running.process.wait()
        for stream in (running.process.stdin, running.process.stdout):
            if stream is not None:
                try:
                    stream.close()
                except ValueError:
                    pass
        with self._lock:
            running.output += f"\n__KESTREL_CMD_DONE__:{running.process_id}:{exit_code}\n"
            running.exit_code = exit_code
            running.completed_at = iso_now()
        after_snapshot = snapshot_workspace_files(
            running.workspace_root,
            excluded_roots=self._managed_entrypoint_private_roots,
        )
        changed_files = changed_workspace_files(running.before_snapshot or {}, after_snapshot)
        with self._lock:
            running.changed_files = changed_files

    def _result_for(self, process_id: str, options: dict[str, Any]) -> dict[str, Any]:
        max_bytes = parse_int(first_value(options, "maxBytes", "maxOutputBytes", "131072"), 131072)
        cursor = parse_int(first_value(options, "cursor", "0"), 0)
        with self._lock:
            running = self._processes.get(process_id)
            if running is None:
                raise RuntimeError(f"Unknown dev process. (processId={process_id})")
            safe_cursor = max(0, min(cursor, len(running.output)))
            chunk = running.output[safe_cursor : safe_cursor + max_bytes]
            next_cursor = safe_cursor + len(chunk)
            running.output_cursor = max(running.output_cursor, len(running.output))
            truncated = next_cursor < len(running.output)
            exit_code = running.exit_code
            completed_at = running.completed_at
            stopped = running.stopped
            failure_reason = running.failure_reason
            poll_status = running.process.poll()
            submitted_at = running.submitted_at
            security_mode = running.security_mode
            changed_files = list(running.changed_files or [])
            workspace_root = running.workspace_root
        if failure_reason is not None:
            status = "FAILED"
        elif stopped:
            status = "STOPPED"
        elif poll_status is None:
            status = "RUNNING"
        elif exit_code == 0:
            status = "COMPLETED"
        elif exit_code is not None:
            status = "FAILED"
        else:
            status = "LOST"
        response: dict[str, Any] = {
            "status": status,
            "text": chunk,
            "truncated": truncated,
            "cursor": safe_cursor,
            "nextCursor": next_cursor,
            "command": running.display_command or running.command,
            "cwd": running.cwd,
            "workspaceRoot": workspace_root,
            "securityMode": security_mode,
            "submittedAt": submitted_at,
            "startedAt": submitted_at,
            "updatedAt": iso_now(),
        }
        if status in {"RUNNING", "STOPPED"}:
            response["processId"] = process_id
        if exit_code is not None:
            response["exitCode"] = exit_code
            response["completedAt"] = completed_at or iso_now()
        if status != "RUNNING" and changed_files:
            response["changedFiles"] = changed_files
        if failure_reason is not None:
            response["exitCode"] = 124
            response.setdefault("completedAt", completed_at or iso_now())
            response["failureReason"] = failure_reason
        return response

    def _send(self, handler: BaseHTTPRequestHandler, payload: dict[str, Any], status: int = 200) -> None:
        self._log("response", {"status": status, "payload": payload})
        raw = json.dumps(payload).encode("utf-8")
        try:
            handler.send_response(status)
            handler.send_header("content-type", "application/json")
            handler.send_header("content-length", str(len(raw)))
            handler.end_headers()
            handler.wfile.write(raw)
        except BrokenPipeError as error:
            self._log("response_write_failed", {"status": status, "code": error.__class__.__name__, "message": str(error)})
        except ConnectionResetError as error:
            self._log("response_write_failed", {"status": status, "code": error.__class__.__name__, "message": str(error)})

    def _log(self, event: str, payload: dict[str, Any]) -> None:
        if self.log_path is None:
            return
        record = {
            "event": event,
            "ts": iso_now(),
            **payload,
        }
        with open(self.log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")


def readiness(workspace_root: str, cwd: str, body: dict[str, Any]) -> dict[str, Any]:
    tools = body.get("requiredTools") if isinstance(body.get("requiredTools"), list) else []
    env_names = body.get("envNames") if isinstance(body.get("envNames"), list) else []
    return {
        "workspaceRootExists": os.path.isdir(workspace_root),
        "cwdExists": os.path.isdir(cwd),
        "cwdWithinWorkspace": is_within_workspace(cwd, workspace_root),
        "shellResolved": os.path.exists("/bin/bash"),
        "tools": [{"name": str(tool), "present": shutil.which(str(tool)) is not None} for tool in tools],
        "env": [{"name": str(name), "present": str(name) in os.environ} for name in env_names],
    }


def resolve_workspace_path(value: Any, fallback: str) -> str:
    raw = str(value or "").strip()
    if raw == "" or raw == ".":
        return fallback
    if os.path.isabs(raw):
        return raw
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


def snapshot_workspace_files(
    workspace_root: str,
    *,
    excluded_roots: set[str] | list[str] | tuple[str, ...] = (),
) -> dict[str, str]:
    workspace_real = os.path.realpath(workspace_root)
    if not os.path.isdir(workspace_real):
        return {}
    excluded_real = {
        os.path.realpath(root)
        for root in excluded_roots
        if root and os.path.exists(root)
    }
    snapshot: dict[str, str] = {}
    for root, dirnames, filenames in os.walk(workspace_real, followlinks=False):
        root_real = os.path.realpath(root)
        if not is_within_workspace(root_real, workspace_real):
            dirnames[:] = []
            continue
        if any(root_real == excluded or root_real.startswith(excluded + os.sep) for excluded in excluded_real):
            dirnames[:] = []
            continue
        dirnames[:] = [
            dirname
            for dirname in dirnames
            if not os.path.islink(os.path.join(root, dirname))
            and not any(
                os.path.realpath(os.path.join(root, dirname)) == excluded
                or os.path.realpath(os.path.join(root, dirname)).startswith(excluded + os.sep)
                for excluded in excluded_real
            )
        ]
        for filename in filenames:
            path = os.path.join(root, filename)
            try:
                file_stat = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISREG(file_stat.st_mode) is False:
                continue
            path_real = os.path.realpath(path)
            if not is_within_workspace(path_real, workspace_real):
                continue
            if any(path_real == excluded or path_real.startswith(excluded + os.sep) for excluded in excluded_real):
                continue
            try:
                with open(path, "rb") as handle:
                    digest = hashlib.sha256(handle.read()).hexdigest()
            except OSError:
                continue
            relative_path = os.path.relpath(path_real, workspace_real)
            snapshot[relative_path.replace(os.sep, "/")] = digest
    return snapshot


def changed_workspace_files(before: dict[str, str], after: dict[str, str]) -> list[str]:
    paths = set(before) | set(after)
    return sorted(path for path in paths if before.get(path) != after.get(path))


def prepare_agent_filesystem_boundary(
    workspace_root: str,
    *,
    excluded_roots: list[str] | tuple[str, ...] | None = None,
) -> None:
    if os.name != "posix":
        return
    if os.geteuid() == 0 and os.path.isdir("/protected"):
        os.chmod("/protected", 0o700)
    if os.geteuid() != 0:
        return
    if os.path.isdir(workspace_root):
        identity = resolve_agent_process_identity()
        if identity is None:
            return
        prepare_agent_workspace_permissions(
            workspace_root,
            uid=identity.uid,
            gid=identity.gid,
            excluded_roots=excluded_roots or (),
        )


def prepare_agent_workspace_permissions(
    workspace_root: str,
    *,
    uid: int,
    gid: int,
    excluded_roots: list[str] | tuple[str, ...] = (),
) -> None:
    workspace_real = os.path.realpath(workspace_root)
    if not os.path.isdir(workspace_real):
        return
    exclusions = tuple(os.path.realpath(path) for path in excluded_roots if path)
    if path_is_within_roots(workspace_real, exclusions):
        return

    for current_root, dirs, files in os.walk(workspace_real, topdown=True, followlinks=False):
        current_real = os.path.realpath(current_root)
        if not path_is_within_root(current_real, workspace_real) or path_is_within_roots(current_real, exclusions):
            dirs[:] = []
            continue

        dirs[:] = [
            name
            for name in dirs
            if not os.path.islink(os.path.join(current_root, name))
            and not path_is_within_roots(os.path.realpath(os.path.join(current_root, name)), exclusions)
        ]

        prepare_agent_workspace_node(current_root, uid=uid, gid=gid, is_dir=True)
        for name in files:
            path = os.path.join(current_root, name)
            if os.path.islink(path):
                continue
            real_path = os.path.realpath(path)
            if not path_is_within_root(real_path, workspace_real) or path_is_within_roots(real_path, exclusions):
                continue
            prepare_agent_workspace_node(path, uid=uid, gid=gid, is_dir=False)


def prepare_agent_workspace_node(path: str, *, uid: int, gid: int, is_dir: bool) -> None:
    try:
        node_stat = os.stat(path, follow_symlinks=False)
    except OSError:
        return
    if stat.S_ISLNK(node_stat.st_mode):
        return
    try:
        os.chown(path, uid, gid, follow_symlinks=False)
    except OSError:
        pass
    current_mode = stat.S_IMODE(node_stat.st_mode)
    owner_bits = stat.S_IRUSR | stat.S_IWUSR
    if is_dir:
        owner_bits |= stat.S_IXUSR
    desired_mode = current_mode | owner_bits
    if desired_mode != current_mode:
        try:
            os.chmod(path, desired_mode)
        except OSError:
            pass


def path_is_within_roots(path: str, roots: tuple[str, ...]) -> bool:
    return any(path_is_within_root(path, root) for root in roots)


def path_is_within_root(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def discover_protected_entrypoints(workspace_root: str) -> dict[str, ProtectedEntrypoint]:
    entrypoints: dict[str, ProtectedEntrypoint] = {}
    if not os.path.isdir(workspace_root):
        return entrypoints
    for name in os.listdir(workspace_root):
        path = os.path.realpath(os.path.join(workspace_root, name))
        if not os.path.isfile(path):
            continue
        if not os.access(path, os.X_OK):
            continue
        try:
            with open(path, "rb") as handle:
                content = handle.read()
        except OSError:
            continue
        if b"/protected" not in content:
            continue
        entrypoints[path] = ProtectedEntrypoint(path=path, digest=hashlib.sha256(content).hexdigest())
    return entrypoints


def match_unmodified_protected_entrypoint(
    *,
    command: str,
    cwd: str,
    workspace_root: str,
    entrypoints: dict[str, ProtectedEntrypoint],
    allow_private: bool = False,
) -> ProtectedEntrypoint | None:
    reference = parse_protected_entrypoint_command_reference(
        command=command,
        cwd=cwd,
        workspace_root=workspace_root,
        entrypoints=entrypoints,
        allow_private=allow_private,
    )
    if reference is None:
        return None
    entrypoint, matched_path = reference
    digest_path = entrypoint.private_path if entrypoint.private_path is not None else matched_path
    try:
        with open(digest_path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None
    return entrypoint if digest == entrypoint.digest else None


def parse_protected_entrypoint_command_reference(
    *,
    command: str,
    cwd: str,
    workspace_root: str,
    entrypoints: dict[str, ProtectedEntrypoint],
    allow_private: bool = False,
) -> tuple[ProtectedEntrypoint, str] | None:
    if not entrypoints or SIMPLE_COMMAND_META_RE.search(command) is not None:
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens:
        return None
    script_token: str | None = None
    if tokens[0] in {"bash", "sh", "/bin/bash", "/bin/sh"} and len(tokens) >= 2:
        script_token = tokens[1]
    elif "/" in tokens[0]:
        script_token = tokens[0]
    if script_token is None:
        return None
    script_path = resolve_workspace_path(script_token, cwd)
    real_script_path = os.path.realpath(script_path)
    for entrypoint in entrypoints.values():
        if real_script_path == os.path.realpath(entrypoint.path):
            return entrypoint, real_script_path
        if (
            allow_private
            and entrypoint.private_path is not None
            and real_script_path == os.path.realpath(entrypoint.private_path)
        ):
            return entrypoint, real_script_path
    return None


def render_protected_entrypoint_command(
    *,
    command: str,
    cwd: str,
    workspace_root: str,
    entrypoint: ProtectedEntrypoint,
) -> str:
    if entrypoint.private_path is None:
        return command
    try:
        tokens = shlex.split(command)
    except ValueError:
        return command
    if not tokens:
        return command
    script_index: int | None = None
    if tokens[0] in {"bash", "sh", "/bin/bash", "/bin/sh"} and len(tokens) >= 2:
        script_index = 1
    elif "/" in tokens[0]:
        script_index = 0
    if script_index is None:
        return command
    script_path = os.path.realpath(resolve_workspace_path(tokens[script_index], cwd))
    if script_path == os.path.realpath(entrypoint.path):
        tokens[script_index] = entrypoint.private_path
    return shlex.join(tokens)


def render_entrypoint_shim(*, public_path: str, workspace_root: str) -> str:
    return f"""#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import select
import sys
import time
from urllib import request


BRIDGE_URL_ENV = "KESTREL_DEV_SHELL_BRIDGE_URL"
PUBLIC_ENTRYPOINT = {public_path!r}
WORKSPACE_ROOT = {workspace_root!r}


def post_json(path: str, payload: dict) -> dict:
    bridge_url = os.environ.get(BRIDGE_URL_ENV, "").rstrip("/")
    if not bridge_url:
        print("missing KESTREL_DEV_SHELL_BRIDGE_URL", file=sys.stderr)
        raise SystemExit(126)
    raw = json.dumps(payload).encode("utf-8")
    req = request.Request(
        bridge_url + path,
        data=raw,
        headers={{"content-type": "application/json"}},
        method="POST",
    )
    with request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def emit(text: str) -> None:
    if text:
        sys.stdout.write(text)
        sys.stdout.flush()


def main() -> int:
    started = post_json(
        "/entrypoints/start",
        {{
            "path": PUBLIC_ENTRYPOINT,
            "argv": sys.argv[1:],
            "cwd": os.getcwd(),
            "workspaceRoot": WORKSPACE_ROOT,
            "yieldTimeMs": 100,
            "maxOutputBytes": 131072,
            "suppressCommandEcho": True,
        }},
    )
    process_id = started.get("processId")
    cursor = int(started.get("nextCursor", started.get("cursor", 0)))
    emit(str(started.get("text", "")))
    if not process_id:
        return int(started.get("exitCode", 1))

    stdin_fd = sys.stdin.fileno()
    stdin_open = True
    while True:
        if stdin_open:
            readable, _, _ = select.select([stdin_fd], [], [], 0.05)
            if readable:
                data = os.read(stdin_fd, 65536)
                if data:
                    post_json(f"/processes/{{process_id}}/write", {{"data": data.decode("utf-8", errors="replace")}})
                else:
                    post_json(f"/processes/{{process_id}}/close_stdin", {{}})
                    stdin_open = False

        result = post_json(
            f"/processes/{{process_id}}/read",
            {{"cursor": cursor, "waitMs": 50, "maxBytes": 131072}},
        )
        cursor = int(result.get("nextCursor", cursor))
        emit(str(result.get("text", "")))
        status = result.get("status")
        if status not in (None, "RUNNING"):
            return int(result.get("exitCode", 0 if status == "COMPLETED" else 1))
        time.sleep(0.01)


if __name__ == "__main__":
    raise SystemExit(main())
"""


def agent_process_security_kwargs() -> dict[str, Any]:
    if os.name != "posix" or os.geteuid() != 0:
        return {}
    identity = resolve_agent_process_identity()
    if identity is None:
        return {}
    return {
        "user": identity.uid,
        "group": identity.gid,
        "extra_groups": [],
    }


def agent_process_security_mode() -> str:
    if os.name != "posix" or os.geteuid() != 0:
        return "agent_default"
    identity = resolve_agent_process_identity()
    if identity is None:
        return "agent_default"
    return "agent_root" if identity.uid == 0 else "agent_unprivileged"


def resolve_agent_process_identity() -> AgentProcessIdentity | None:
    user_name = os.environ.get(AGENT_USER_ENV, "nobody")
    try:
        user = pwd.getpwnam(user_name)
    except KeyError:
        return None
    return AgentProcessIdentity(uid=user.pw_uid, gid=user.pw_gid)


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("content-length") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8")
    return json.loads(raw) if raw.strip() else {}


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
    value = first_value(options, "yieldTimeMs", "waitMs", str(default_ms))
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
    root = os.path.realpath(workspace_root)
    path = os.path.realpath(candidate)
    return path == root or path.startswith(f"{root}{os.sep}")


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
