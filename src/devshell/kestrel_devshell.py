from __future__ import annotations

import http.client
import json
import os
import re
import shlex
import socket
import time
from typing import Any, Pattern
from urllib import error, parse, request


BRIDGE_URL_ENV = "KESTREL_DEV_SHELL_BRIDGE_URL"
SOCKET_PATH_ENV = "KESTREL_DEV_SHELL_SOCKET_PATH"


class DevShellResult(dict[str, Any]):
    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __str__(self) -> str:
        text = self.get("text")
        return text if isinstance(text, str) else super().__str__()


class DevProcess:
    def __init__(
        self,
        process_id: str,
        endpoint: str | None = None,
        cursor: int = 0,
        start_result: dict[str, Any] | None = None,
    ) -> None:
        if not process_id:
            raise ValueError("process_id is required")
        self.process_id = process_id
        self.endpoint = endpoint or require_endpoint()
        self.cursor = max(0, int(cursor))
        self.start_result = start_result or {"processId": process_id, "process_id": process_id}
        self._closed = False

    def __enter__(self) -> "DevProcess":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        try:
            self.close()
        except Exception:
            if exc_type is None:
                raise
        return False

    def write(self, data: str | bytes | bytearray | memoryview, **kwargs: Any) -> dict[str, Any]:
        fail_on_unknown_kwargs(kwargs)
        return request_json(
            self.endpoint,
            "POST",
            f"/processes/{parse.quote(self.process_id)}/write",
            {"data": coerce_write_data(data)},
        )

    def write_and_read(
        self,
        data: str | bytes | bytearray | memoryview,
        *,
        cursor: int | None = None,
        wait_ms: int = 250,
        max_bytes: int = 131072,
        **kwargs: Any,
    ) -> dict[str, Any]:
        cursor = int(pop_alias(kwargs, "cursor", default=cursor if cursor is not None else self.cursor))
        wait_ms = int(pop_alias(kwargs, "wait_ms", "waitMs", "timeout", default=wait_ms))
        max_bytes = int(pop_alias(kwargs, "max_bytes", "maxBytes", default=max_bytes))
        fail_on_unknown_kwargs(kwargs)
        result = request_json(
            self.endpoint,
            "POST",
            f"/processes/{parse.quote(self.process_id)}/write_and_read",
            {
                "data": coerce_write_data(data),
                "cursor": cursor,
                "waitMs": wait_ms,
                "maxBytes": max_bytes,
            },
        )
        self.cursor = int(result.get("nextCursor", result.get("next_cursor", self.cursor)))
        return result

    def read(
        self,
        *,
        cursor: int | None = None,
        wait_ms: int = 250,
        max_bytes: int = 131072,
        **kwargs: Any,
    ) -> dict[str, Any]:
        cursor = int(pop_alias(kwargs, "cursor", default=cursor if cursor is not None else self.cursor))
        wait_ms = int(pop_alias(kwargs, "wait_ms", "waitMs", "timeout", default=wait_ms))
        max_bytes = int(pop_alias(kwargs, "max_bytes", "maxBytes", default=max_bytes))
        fail_on_unknown_kwargs(kwargs)
        result = request_json(
            self.endpoint,
            "GET",
            f"/processes/{parse.quote(self.process_id)}/read",
            {"cursor": cursor, "waitMs": wait_ms, "maxBytes": max_bytes},
        )
        self.cursor = int(result.get("nextCursor", result.get("next_cursor", self.cursor)))
        return result

    def stop(
        self,
        *,
        signal: str | None = None,
        cursor: int | None = None,
        wait_ms: int = 250,
        max_bytes: int = 131072,
        **kwargs: Any,
    ) -> dict[str, Any]:
        cursor = int(pop_alias(kwargs, "cursor", default=cursor if cursor is not None else self.cursor))
        wait_ms = int(pop_alias(kwargs, "wait_ms", "waitMs", "timeout", default=wait_ms))
        max_bytes = int(pop_alias(kwargs, "max_bytes", "maxBytes", default=max_bytes))
        signal = pop_alias(kwargs, "signal", default=signal)
        fail_on_unknown_kwargs(kwargs)
        payload: dict[str, Any] = {"cursor": cursor, "waitMs": wait_ms, "maxBytes": max_bytes}
        if signal is not None:
            payload["signal"] = signal
        result = request_json(
            self.endpoint,
            "POST",
            f"/processes/{parse.quote(self.process_id)}/stop",
            payload,
        )
        self.cursor = int(result.get("nextCursor", result.get("next_cursor", self.cursor)))
        self._closed = True
        return result

    def close(self, **kwargs: Any) -> dict[str, Any] | None:
        if self._closed:
            fail_on_unknown_kwargs(kwargs)
            return None
        return self.stop(**kwargs)

    def sendline(self, line: str, **kwargs: Any) -> dict[str, Any]:
        return self.write(f"{line}\n", **kwargs)

    def wait_for(
        self,
        patterns: str | Pattern[str] | list[str | Pattern[str]],
        *,
        timeout_ms: int = 5000,
        read_wait_ms: int = 250,
        max_bytes: int = 131072,
        return_result: bool = False,
        **kwargs: Any,
    ) -> str | dict[str, Any]:
        timeout_ms = int(pop_alias(kwargs, "timeout_ms", "timeoutMs", "timeout", default=timeout_ms))
        read_wait_ms = int(pop_alias(kwargs, "read_wait_ms", "readWaitMs", default=read_wait_ms))
        max_bytes = int(pop_alias(kwargs, "max_bytes", "maxBytes", default=max_bytes))
        return_result = bool(pop_alias(kwargs, "return_result", "returnResult", default=return_result))
        fail_on_unknown_kwargs(kwargs)
        compiled = compile_patterns(patterns)
        deadline = time.monotonic() + timeout_ms / 1000
        combined = ""
        last: dict[str, Any] = {}
        while time.monotonic() <= deadline:
            last = self.read(wait_ms=read_wait_ms, max_bytes=max_bytes)
            text = str(last.get("text", ""))
            combined += text
            for pattern in compiled:
                match = pattern.search(combined)
                if match is not None:
                    matched = match.group(0)
                    if return_result:
                        return {
                            "matched": matched,
                            "buffer": combined,
                            "timedOut": False,
                            "status": last.get("status"),
                            "lastOutput": text,
                        }
                    return matched
            if last.get("status") not in (None, "RUNNING") and text == "":
                break
        final_buffer = combined[-500:]
        raise TimeoutError(
            f"Timed out waiting for process output after {timeout_ms} ms. "
            f"Last output: {final_buffer!r}. "
            "No requested pattern matched the buffered output."
        )

    def sendline_and_wait(
        self,
        line: str,
        patterns: str | Pattern[str] | list[str | Pattern[str]] | None = None,
        **kwargs: Any,
    ) -> str:
        if patterns is None:
            patterns = pop_alias(kwargs, "wait_for", "waitFor", default=None)
        if patterns is None:
            raise TypeError("sendline_and_wait() missing required patterns argument")
        compile_patterns(patterns)
        unknown = {
            key: value
            for key, value in kwargs.items()
            if key not in {
                "timeout_ms",
                "timeoutMs",
                "timeout",
                "read_wait_ms",
                "readWaitMs",
                "max_bytes",
                "maxBytes",
                "return_result",
                "returnResult",
            }
        }
        fail_on_unknown_kwargs(unknown)
        self.sendline(line)
        return self.wait_for(patterns, **kwargs)


DevShellProcess = DevProcess
ProcessRef = str | dict[str, Any] | DevProcess | None


def run(
    command: str | list[str] | tuple[str, ...],
    *,
    cwd: str = ".",
    workspace_root: str = ".",
    timeout_ms: int = 30000,
    max_output_bytes: int = 131072,
    endpoint: str | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    workspace_root = str(pop_alias(kwargs, "workspace_root", "workspaceRoot", default=workspace_root))
    timeout_ms = int(pop_alias(kwargs, "timeout_ms", "timeoutMs", "timeout", default=timeout_ms))
    max_output_bytes = int(pop_alias(kwargs, "max_output_bytes", "maxOutputBytes", default=max_output_bytes))
    fail_on_unknown_kwargs(kwargs)
    return request_json(
        endpoint or require_endpoint(),
        "POST",
        "/shell/run",
        {
            "command": render_command(command),
            "cwd": cwd,
            "workspaceRoot": workspace_root,
            "timeoutMs": timeout_ms,
            "maxOutputBytes": max_output_bytes,
        },
    )


def start(
    command: str | list[str] | tuple[str, ...],
    *,
    cwd: str = ".",
    workspace_root: str = ".",
    yield_time_ms: int = 1000,
    max_output_bytes: int = 131072,
    endpoint: str | None = None,
    **kwargs: Any,
) -> DevProcess:
    workspace_root = str(pop_alias(kwargs, "workspace_root", "workspaceRoot", default=workspace_root))
    yield_time_ms = int(pop_alias(kwargs, "yield_time_ms", "yieldTimeMs", default=yield_time_ms))
    max_output_bytes = int(pop_alias(kwargs, "max_output_bytes", "maxOutputBytes", default=max_output_bytes))
    fail_on_unknown_kwargs(kwargs)
    resolved_endpoint = endpoint or require_endpoint()
    result = request_json(
        resolved_endpoint,
        "POST",
        "/processes/start",
        {
            "command": render_command(command),
            "cwd": cwd,
            "workspaceRoot": workspace_root,
            "yieldTimeMs": yield_time_ms,
            "maxOutputBytes": max_output_bytes,
        },
    )
    process_id = result.get("processId") or result.get("process_id")
    if not process_id:
        message = result.get("message") or result.get("error") or "dev shell did not return a process id"
        raise RuntimeError(str(message))
    return DevProcess(
        str(process_id),
        resolved_endpoint,
        int(result.get("cursor", 0)),
        result,
    )


def write(
    process_id: ProcessRef = None,
    data: str | bytes | bytearray | memoryview | None = None,
    *,
    endpoint: str | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    process_id = pop_alias(kwargs, "process_id", "processId", default=process_id)
    if data is None and "data" not in kwargs:
        raise ValueError("data is required")
    data = coerce_write_data(pop_alias(kwargs, "data", default=data))
    fail_on_unknown_kwargs(kwargs)
    if isinstance(process_id, DevProcess) and endpoint is None:
        return process_id.write(data)
    process_id, endpoint = resolve_process_ref(process_id, endpoint)
    return DevProcess(process_id, endpoint).write(data)


def write_and_read(
    process_id: ProcessRef = None,
    data: str | bytes | bytearray | memoryview | None = None,
    *,
    endpoint: str | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    process_id = pop_alias(kwargs, "process_id", "processId", default=process_id)
    if data is None and "data" not in kwargs:
        raise ValueError("data is required")
    data = coerce_write_data(pop_alias(kwargs, "data", default=data))
    if isinstance(process_id, DevProcess) and endpoint is None:
        return process_id.write_and_read(data, **kwargs)
    process_id, endpoint = resolve_process_ref(process_id, endpoint)
    return DevProcess(process_id, endpoint).write_and_read(data, **kwargs)


def read(process_id: ProcessRef = None, *, endpoint: str | None = None, **kwargs: Any) -> dict[str, Any]:
    process_id = pop_alias(kwargs, "process_id", "processId", default=process_id)
    if isinstance(process_id, DevProcess) and endpoint is None:
        return process_id.read(**kwargs)
    process_id, endpoint = resolve_process_ref(process_id, endpoint)
    return DevProcess(process_id, endpoint).read(**kwargs)


def stop(process_id: ProcessRef = None, *, endpoint: str | None = None, **kwargs: Any) -> dict[str, Any]:
    process_id = pop_alias(kwargs, "process_id", "processId", default=process_id)
    if isinstance(process_id, DevProcess) and endpoint is None:
        return process_id.stop(**kwargs)
    process_id, endpoint = resolve_process_ref(process_id, endpoint)
    return DevProcess(process_id, endpoint).stop(**kwargs)


def close(process_id: ProcessRef = None, *, endpoint: str | None = None, **kwargs: Any) -> dict[str, Any] | None:
    process_id = pop_alias(kwargs, "process_id", "processId", default=process_id)
    if isinstance(process_id, DevProcess) and endpoint is None:
        return process_id.close(**kwargs)
    return stop(process_id, endpoint=endpoint, **kwargs)


def require_endpoint() -> str:
    bridge_url = os.environ.get(BRIDGE_URL_ENV)
    if bridge_url:
        return bridge_url.rstrip("/")
    socket_path = os.environ.get(SOCKET_PATH_ENV)
    if socket_path:
        return f"unix://{socket_path}"
    raise RuntimeError(f"{BRIDGE_URL_ENV} or {SOCKET_PATH_ENV} is required")


def request_json(endpoint: str, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if endpoint.startswith("unix://"):
        parsed = request_json_over_unix_socket(endpoint.removeprefix("unix://"), method, path, payload)
    else:
        parsed = request_json_over_http(endpoint, method, path, payload)
    return normalize_response(parsed)


def request_json_over_http(endpoint: str, method: str, path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    url = f"{endpoint.rstrip('/')}{path}"
    body: bytes | None = None
    if method == "GET" and payload:
        url = f"{url}?{parse.urlencode(payload)}"
    elif payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=body, headers={"content-type": "application/json"}, method=method)
    try:
        with request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
            status = response.status
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        status = exc.code
    return parse_response(raw, status)


def request_json_over_unix_socket(socket_path: str, method: str, path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    request_path = f"{path}?{parse.urlencode(payload)}" if method == "GET" and payload else path
    body = None if method == "GET" or payload is None else json.dumps(payload)
    conn = UnixSocketHTTPConnection(socket_path, timeout=30)
    try:
        conn.request(method, request_path, body=body, headers={"content-type": "application/json"} if body else {})
        response = conn.getresponse()
        return parse_response(response.read().decode("utf-8"), response.status)
    finally:
        conn.close()


class UnixSocketHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: int = 30) -> None:
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.socket_path)
        self.sock = sock


def parse_response(raw: str, status: int) -> dict[str, Any]:
    parsed = json.loads(raw) if raw.strip() else {}
    if not isinstance(parsed, dict):
        raise RuntimeError(f"Unexpected dev-shell response: {parsed!r}")
    parsed.setdefault("httpStatus", status)
    if status >= 400:
        message = parsed.get("message") or parsed.get("error") or f"dev shell returned HTTP {status}"
        raise RuntimeError(str(message))
    return parsed


def normalize_response(parsed: dict[str, Any]) -> dict[str, Any]:
    if "processId" in parsed and "process_id" not in parsed:
        parsed["process_id"] = parsed.get("processId")
    if "exitCode" in parsed and "exit_code" not in parsed:
        parsed["exit_code"] = parsed.get("exitCode")
    if "nextCursor" in parsed and "next_cursor" not in parsed:
        parsed["next_cursor"] = parsed.get("nextCursor")
    parsed.setdefault("text", parsed.get("stdout", ""))
    return DevShellResult(parsed)


def coerce_write_data(data: str | bytes | bytearray | memoryview) -> str:
    if isinstance(data, str):
        return data
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data).decode("utf-8")
    raise TypeError("data must be str or bytes")


def resolve_process_ref(process_ref: ProcessRef, endpoint: str | None) -> tuple[str, str | None]:
    if isinstance(process_ref, DevProcess):
        return process_ref.process_id, endpoint or process_ref.endpoint
    if isinstance(process_ref, dict):
        process_id = process_ref.get("processId") or process_ref.get("process_id")
        return "" if process_id is None else str(process_id), endpoint
    if process_ref is None:
        raise ValueError("process_id is required")
    return str(process_ref), endpoint


def render_command(command: str | list[str] | tuple[str, ...]) -> str:
    return shlex.join([str(part) for part in command]) if isinstance(command, (list, tuple)) else command


def compile_patterns(patterns: str | Pattern[str] | list[str | Pattern[str]]) -> list[Pattern[str]]:
    values = patterns if isinstance(patterns, list) else [patterns]
    compiled: list[Pattern[str]] = []
    for value in values:
        if isinstance(value, str):
            compiled.append(re.compile(value))
        elif hasattr(value, "search"):
            compiled.append(value)
        else:
            raise TypeError("patterns must be a string, compiled regex, or list of those")
    if not compiled:
        raise TypeError("patterns must include at least one pattern")
    return compiled


def pop_alias(kwargs: dict[str, Any], *names: str, default: Any) -> Any:
    for name in names:
        if name in kwargs:
            return kwargs.pop(name)
    return default


def fail_on_unknown_kwargs(kwargs: dict[str, Any]) -> None:
    if kwargs:
        names = ", ".join(sorted(kwargs))
        raise TypeError(f"Unexpected keyword argument(s): {names}")
