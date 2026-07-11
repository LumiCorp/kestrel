from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any


RESULT_MARKER = "CODEX_TBENCH_RESULT_JSON_BASE64"
RESULT_PATH = Path("/installed-agent/codex-cli-result.json")
STDOUT_PATH = Path("/installed-agent/codex-cli-stdout.txt")
STDERR_PATH = Path("/installed-agent/codex-cli-stderr.txt")


def main() -> int:
    args = parse_args()
    instruction = base64.b64decode(args.instruction_base64).decode("utf-8")
    started_at = time.monotonic()
    auth = prepare_codex_auth()
    command = build_codex_command(args.model)
    timed_out = False
    if not auth["ok"]:
        exit_code = 1
        stdout = ""
        stderr = str(auth["stderr"] or "Codex authentication setup failed.")
    else:
        try:
            completed = subprocess.run(
                command,
                cwd="/app",
                input=instruction,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=args.timeout_sec,
                check=False,
            )
            exit_code = completed.returncode
            stdout = completed.stdout
            stderr = completed.stderr
        except subprocess.TimeoutExpired as error:
            timed_out = True
            exit_code = 124
            stdout = decode_output(error.stdout)
            stderr = decode_output(error.stderr) + "\nCodex CLI timed out.\n"
        except FileNotFoundError as error:
            exit_code = 127
            stdout = ""
            stderr = f"{error}\n"
    STDOUT_PATH.write_text(stdout, encoding="utf-8")
    STDERR_PATH.write_text(stderr, encoding="utf-8")
    result = {
        "adapter": "codex-harbor-cli",
        "dataset": os.environ.get("CODEX_TBENCH_RESULT_DATASET", "terminal-bench@2.0"),
        "task_id": args.task_id,
        "status": "timeout" if timed_out else ("completed" if exit_code == 0 else "failed"),
        "duration_ms": monotonic_ms(started_at),
        "failure_kind": "timeout" if timed_out else ("none" if exit_code == 0 else "cli_command_failed"),
        "notes": f"codex_cli_exit_code={exit_code}",
        "failure_details": {
            "codex_cli": {
                "auth_env_present": codex_auth_env_present(),
                "auth_env_keys": codex_auth_env_keys(),
                "auth_setup": auth_summary(auth),
                "command": command,
                "exit_code": exit_code,
                "stdout_path": str(STDOUT_PATH),
                "stderr_path": str(STDERR_PATH),
            }
        },
    }
    RESULT_PATH.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    payload = base64.b64encode(json.dumps(result).encode("utf-8")).decode("ascii")
    print(f"{RESULT_MARKER}:{payload}", flush=True)
    return exit_code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instruction-base64", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--model", default="")
    parser.add_argument("--timeout-sec", type=float, default=None)
    return parser.parse_args()


def build_codex_command(model: str) -> list[str]:
    command = [
        "codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-c",
        'cli_auth_credentials_store="file"',
    ]
    resolved_model = model.strip() or os.environ.get("KESTREL_TBENCH_CODEX_MODEL", "").strip()
    if resolved_model:
        command.extend(["-m", resolved_model])
    command.extend(["--cd", "/app", "-"])
    return command


def prepare_codex_auth() -> dict[str, Any]:
    codex_home = os.environ.get("CODEX_HOME") or "/tmp/codex-home"
    os.environ["CODEX_HOME"] = codex_home
    Path(codex_home).mkdir(parents=True, exist_ok=True)
    access_token = os.environ.get("CODEX_ACCESS_TOKEN")
    if access_token:
        return run_codex_login(["codex", "login", "--with-access-token"], access_token, "access-token")
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("CODEX_API_KEY")
    if api_key:
        return run_codex_login(
            ["codex", "login", "-c", 'cli_auth_credentials_store="file"', "--with-api-key"],
            api_key,
            "api-key",
        )
    return {"ok": True, "method": "existing-or-none", "stderr": ""}


def run_codex_login(command: list[str], secret: str, method: str) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            command,
            input=secret,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
    except FileNotFoundError as error:
        return {"ok": False, "method": method, "stderr": str(error)}
    except subprocess.TimeoutExpired as error:
        return {"ok": False, "method": method, "stderr": decode_output(error.stderr) + "\nCodex login timed out.\n"}
    return {
        "ok": completed.returncode == 0,
        "method": method,
        "stderr": completed.stderr,
    }


def auth_summary(auth: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": bool(auth.get("ok")),
        "method": str(auth.get("method") or "unknown"),
    }


def decode_output(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def codex_auth_env_present() -> bool:
    return bool(codex_auth_env_keys())


def codex_auth_env_keys() -> list[str]:
    return [
        key
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL")
        if os.environ.get(key)
    ]


def monotonic_ms(started_at: float) -> int:
    return max(0, round((time.monotonic() - started_at) * 1000))


if __name__ == "__main__":
    raise SystemExit(main())
