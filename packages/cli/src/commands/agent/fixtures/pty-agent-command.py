"""Drive Attest guided prompts in a real PTY for signal and concurrency probes."""

import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time


def read_once(master_fd: int, timeout: float) -> bytes:
    """Read available PTY bytes without allowing an EIO-at-exit to escape."""
    readable, _, _ = select.select([master_fd], [], [], timeout)
    if not readable:
        return b""
    try:
        return os.read(master_fd, 4096)
    except OSError:
        return b""


def spawn_pty(command: list[str]) -> tuple[int, int]:
    """Start one command as the foreground process of a fresh controlling PTY."""
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.environ.pop("CI", None)
        os.execvp(command[0], command)
    return child_pid, master_fd


def read_until(master_fd: int, expected: bytes, deadline: float) -> tuple[bytes, bool]:
    """Collect terminal output until one prompt appears or the deadline expires."""
    output = b""
    while expected not in output and time.monotonic() < deadline:
        output += read_once(master_fd, 0.1)
    return output, expected in output


def finish_child(
    child_pid: int, master_fd: int, output: bytes, deadline: float
) -> tuple[int, bytes, bool]:
    """Collect a bounded child exit and report whether the PTY returned to cooked mode."""
    status = None
    while status is None and time.monotonic() < deadline:
        output += read_once(master_fd, 0.1)
        waited_pid, waited_status = os.waitpid(child_pid, os.WNOHANG)
        if waited_pid == child_pid:
            status = waited_status
    if status is None:
        os.kill(child_pid, signal.SIGKILL)
        _, status = os.waitpid(child_pid, 0)
    while True:
        chunk = read_once(master_fd, 0)
        if not chunk:
            break
        output += chunk
    terminal_after = termios.tcgetattr(master_fd)
    terminal_restored = all(
        terminal_after[3] & flag for flag in (termios.ECHO, termios.ICANON, termios.ISIG)
    )
    os.close(master_fd)
    return os.waitstatus_to_exitcode(status), output, terminal_restored


def interrupt(command: list[str]) -> dict[str, object]:
    """Send terminal Ctrl+C at the first agent-id prompt and capture the exit contract."""
    child_pid, master_fd = spawn_pty(command)
    deadline = time.monotonic() + 8
    output, prompt_seen = read_until(master_fd, b"Agent id: ", deadline)
    if prompt_seen:
        os.write(master_fd, b"\x03")
    exit_code, output, terminal_restored = finish_child(
        child_pid, master_fd, output, deadline
    )
    return {
        "exit_code": exit_code,
        "output": output.decode("utf-8", errors="replace"),
        "prompt_seen": prompt_seen,
        "terminal_restored": terminal_restored,
    }


def race(project_root: str, argv_json: str, command_prefix: list[str]) -> dict[str, object]:
    """Commit a second mutation while a guided add waits on its preview confirmation."""
    outer_command = command_prefix + [
        "agent",
        "add",
        "previewed",
        "--argv-json",
        argv_json,
        "--project",
        project_root,
    ]
    child_pid, master_fd = spawn_pty(outer_command)
    deadline = time.monotonic() + 8
    output, prompt_seen = read_until(master_fd, b"Apply these changes? [y/N]: ", deadline)
    environment = os.environ.copy()
    environment.pop("CI", None)
    concurrent = subprocess.run(
        command_prefix
        + [
            "agent",
            "add",
            "racer",
            "--argv-json",
            argv_json,
            "--project",
            project_root,
            "--output",
            "json",
        ],
        capture_output=True,
        check=False,
        env=environment,
        text=True,
        timeout=8,
    )
    if prompt_seen:
        os.write(master_fd, b"yes\n")
    exit_code, output, terminal_restored = finish_child(
        child_pid, master_fd, output, deadline
    )
    return {
        "concurrent_exit_code": concurrent.returncode,
        "concurrent_output": concurrent.stdout,
        "exit_code": exit_code,
        "output": output.decode("utf-8", errors="replace"),
        "prompt_seen": prompt_seen,
        "terminal_restored": terminal_restored,
    }


def main() -> None:
    """Dispatch one bounded PTY scenario and print its evidence as JSON."""
    mode = sys.argv[1]
    if mode == "interrupt":
        result = interrupt(sys.argv[2:])
    elif mode == "race":
        result = race(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        raise ValueError(f"Unknown PTY probe mode: {mode}")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
