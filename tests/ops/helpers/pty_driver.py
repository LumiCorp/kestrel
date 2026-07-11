#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ANSI_PATTERN = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def main() -> int:
    payload, control_buffer, stdin_closed = read_initial_payload()
    command = payload["command"]
    env = payload["env"]
    steps = payload["steps"]
    abort_patterns = payload.get("abortPatterns") or []
    timeout_seconds = payload.get("timeoutSeconds", 5)

    pid, master_fd = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, env)
        raise SystemExit(1)

    set_pty_size(master_fd, rows=40, cols=120)

    transcript = ""
    visible_cursor = 0
    try:
        for step in steps:
            step_timeout = step.get("timeoutSeconds", timeout_seconds)
            step_abort_patterns = step.get("abortPatterns") or abort_patterns
            transcript, visible_cursor = wait_for_step(
                master_fd=master_fd,
                transcript=transcript,
                pattern=step["pattern"],
                regex=bool(step["regex"]),
                from_cursor=bool(step.get("fromCursor", False)),
                visible_cursor=visible_cursor,
                timeout_seconds=float(step_timeout),
                abort_patterns=step_abort_patterns,
            )
            send_value = step.get("send")
            if send_value:
                write_all(master_fd, send_value.encode("utf-8"))
            actions = step.get("actions") or []
            for action in actions:
                type_text = action.get("typeText")
                if type_text:
                    write_all(master_fd, type_text.encode("utf-8"))
                key = action.get("key")
                if key == "enter":
                    write_all(master_fd, b"\r")
                elif key == "esc":
                    write_all(master_fd, b"\x1b")
                elif key == "up":
                    write_all(master_fd, b"\x1b[A")
                elif key == "down":
                    write_all(master_fd, b"\x1b[B")
                elif key == "right":
                    write_all(master_fd, b"\x1b[C")
                elif key == "left":
                    write_all(master_fd, b"\x1b[D")
                elif key == "tab":
                    write_all(master_fd, b"\t")
                elif key == "shift-tab":
                    write_all(master_fd, b"\x1b[Z")
                elif key == "ctrl-p":
                    write_all(master_fd, b"\x10")
                elif key == "ctrl-2":
                    write_all(master_fd, b"\x00")
                settle_ms = action.get("settleMs")
                if settle_ms:
                    time.sleep(float(settle_ms) / 1000.0)

        if stdin_closed:
            request_interrupt(master_fd)
            transcript = drain_output(master_fd, transcript)
        else:
            transcript = run_interactive_loop(
                pid=pid,
                master_fd=master_fd,
                transcript=transcript,
                control_buffer=control_buffer,
            )
    except Exception as error:
        terminate_child(pid)
        sys.stderr.write(f"{error}\n")
        return 1
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        terminate_child(pid)

    sys.stdout.write(transcript)
    return 0


def read_initial_payload():
    stdin_fd = sys.stdin.fileno()
    chunks = []
    while True:
        data = os.read(stdin_fd, 4096)
        if not data:
            payload = json.loads(b"".join(chunks).decode("utf-8"))
            return payload, "", True
        newline_index = data.find(b"\n")
        if newline_index >= 0:
            chunks.append(data[:newline_index])
            payload = json.loads(b"".join(chunks).decode("utf-8"))
            remainder = data[newline_index + 1 :].decode("utf-8", errors="ignore")
            return payload, remainder, False
        chunks.append(data)


def wait_for_step(
    master_fd: int,
    transcript: str,
    pattern: str,
    regex: bool,
    from_cursor: bool,
    visible_cursor: int,
    timeout_seconds: float,
    abort_patterns,
):
    deadline = time.time() + timeout_seconds
    matcher = re.compile(pattern) if regex else None

    while time.time() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if ready:
            transcript += read_available(master_fd)
            visible = normalize_output(transcript)
            matched_abort = find_abort_match(
                visible=visible,
                visible_cursor=visible_cursor,
                abort_patterns=abort_patterns,
            )
            if matched_abort is not None:
                reason, matched_pattern, match_count, max_matches = matched_abort
                tail = visible[-4000:]
                count_note = (
                    f" count={match_count}"
                    if max_matches is None
                    else f" count={match_count} maxMatches={max_matches}"
                )
                raise RuntimeError(
                    f"ABORT_PATTERN_MATCHED:{reason}\n"
                    f"matched={matched_pattern!r}{count_note}\n"
                    f"{tail}"
                )
            haystack = visible[visible_cursor:] if from_cursor else visible
            if regex:
                if matcher.search(haystack):
                    return transcript, len(visible)
            elif pattern in haystack:
                return transcript, len(visible)
    raise RuntimeError(f"Timed out waiting for {pattern!r}\n{transcript}")


def run_interactive_loop(
    pid: int,
    master_fd: int,
    transcript: str,
    control_buffer: str,
) -> str:
    stdin_fd = sys.stdin.fileno()
    stdin_eof = False
    terminate_requested = False

    while True:
        waited_pid, _ = poll_child(pid)
        if waited_pid == pid:
            return drain_output(master_fd, transcript)
        if terminate_requested:
            request_interrupt(master_fd)
            return drain_output(master_fd, transcript)

        read_fds = [master_fd]
        if not stdin_eof:
            read_fds.append(stdin_fd)
        ready, _, _ = select.select(read_fds, [], [], 0.05)
        if master_fd in ready:
            transcript += read_available(master_fd)
        if not stdin_eof and stdin_fd in ready:
            chunk = os.read(stdin_fd, 4096)
            if not chunk:
                stdin_eof = True
            else:
                control_buffer += chunk.decode("utf-8", errors="ignore")

        control_buffer, commands = split_control_commands(control_buffer)
        for command in commands:
            command_type = str(command.get("type", "")).strip()
            if command_type == "send_text":
                text = str(command.get("text", ""))
                if text:
                    write_all(master_fd, text.encode("utf-8"))
            elif command_type == "terminate":
                terminate_requested = True


def split_control_commands(buffer: str):
    if not buffer:
        return buffer, []

    if buffer.endswith("\n"):
        lines = buffer.split("\n")
        remainder = ""
    else:
        lines = buffer.split("\n")
        remainder = lines.pop()
    commands = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        commands.append(json.loads(stripped))
    return remainder, commands


def find_abort_match(
    visible: str,
    visible_cursor: int,
    abort_patterns,
):
    for item in abort_patterns:
        pattern = str(item.get("pattern", ""))
        if len(pattern) == 0:
            continue
        regex = bool(item.get("regex", False))
        reason = str(item.get("reason", "")).strip()
        from_cursor = bool(item.get("fromCursor", False))
        max_matches_raw = item.get("maxMatches")
        max_matches = None
        if max_matches_raw is not None:
            try:
                max_matches = int(max_matches_raw)
            except (TypeError, ValueError):
                raise RuntimeError(
                    f"Invalid maxMatches for abort pattern {pattern!r}: {max_matches_raw!r}"
                )
            if max_matches < 0:
                raise RuntimeError(
                    f"Invalid maxMatches for abort pattern {pattern!r}: must be >= 0"
                )
        haystack = visible[visible_cursor:] if from_cursor else visible
        if regex:
            try:
                match_count = sum(1 for _ in re.finditer(pattern, haystack))
            except re.error as error:
                raise RuntimeError(f"Invalid abort regex {pattern!r}: {error}") from error
        else:
            match_count = haystack.count(pattern)

        if max_matches is None:
            if match_count > 0:
                return (
                    reason if len(reason) > 0 else "abort_pattern_matched",
                    pattern,
                    match_count,
                    max_matches,
                )
        elif match_count > max_matches:
            return (
                reason if len(reason) > 0 else "abort_pattern_matched",
                pattern,
                match_count,
                max_matches,
            )
    return None


def read_available(master_fd: int) -> str:
    try:
        data = os.read(master_fd, 4096)
    except OSError:
        return ""
    return data.decode("utf-8", errors="ignore")


def write_all(master_fd: int, data: bytes) -> None:
    written = 0
    length = len(data)
    while written < length:
        try:
            count = os.write(master_fd, data[written:])
        except InterruptedError:
            continue
        if count <= 0:
            raise RuntimeError("PTY write failed before payload was fully sent.")
        written += count


def drain_output(master_fd: int, transcript: str) -> str:
    deadline = time.time() + 0.5
    while time.time() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.05)
        if not ready:
            break
        transcript += read_available(master_fd)
    return transcript


def request_interrupt(master_fd: int) -> None:
    write_all(master_fd, b"\x03")
    time.sleep(0.2)
    write_all(master_fd, b"\x03")
    time.sleep(0.3)


def normalize_output(value: str) -> str:
    value = ANSI_PATTERN.sub("", value)
    value = value.replace("\u001b[?1049h", "")
    value = value.replace("\u001b[?1049l", "")
    value = value.replace("\u0007", "")
    value = value.replace("\r", "")
    value = re.sub(r"[^\S\n]+\n", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value


def terminate_child(pid: int) -> None:
    try:
        waited_pid, _ = os.waitpid(pid, os.WNOHANG)
        if waited_pid == pid:
            return
    except ChildProcessError:
        return

    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return
        try:
            waited_pid, _ = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                return
            time.sleep(0.1)
            waited_pid, _ = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                return
        except ChildProcessError:
            return
        except OSError:
            continue


def poll_child(pid: int):
    try:
        return os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return pid, 0


def set_pty_size(master_fd: int, rows: int, cols: int) -> None:
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)


if __name__ == "__main__":
    raise SystemExit(main())
