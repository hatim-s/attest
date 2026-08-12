"""Exercise the eval selection wizard and signal handling through one real PTY."""

import json
import os
import pty
import select
import signal
import sys
import termios
import time


def read_once(master_fd: int, timeout: float) -> bytes:
    """Read available PTY bytes while treating child-exit EIO as EOF."""
    readable, _, _ = select.select([master_fd], [], [], timeout)
    if not readable:
        return b""
    try:
        return os.read(master_fd, 4096)
    except OSError:
        return b""


def read_until(master_fd: int, expected: bytes, deadline: float) -> tuple[bytes, bool]:
    """Collect output until one marker appears or the bounded deadline expires."""
    output = b""
    while expected not in output and time.monotonic() < deadline:
        output += read_once(master_fd, 0.1)
    return output, expected in output


def finish_child(child_pid: int, master_fd: int, output: bytes, deadline: float) -> dict[str, object]:
    """Collect child exit evidence and verify canonical terminal flags were restored."""
    status = None
    while status is None and time.monotonic() < deadline:
        output += read_once(master_fd, 0.1)
        waited_pid, waited_status = os.waitpid(child_pid, os.WNOHANG)
        if waited_pid == child_pid:
            status = waited_status
    if status is None:
        os.kill(child_pid, signal.SIGKILL)
        _, status = os.waitpid(child_pid, 0)
    terminal_after = termios.tcgetattr(master_fd)
    terminal_restored = all(
        terminal_after[3] & flag for flag in (termios.ECHO, termios.ICANON, termios.ISIG)
    )
    os.close(master_fd)
    return {
        "exit_code": os.waitstatus_to_exitcode(status),
        "output": output.decode("utf-8", errors="replace"),
        "terminal_restored": terminal_restored,
    }


def drive(command: list[str]) -> dict[str, object]:
    """Answer the selection wizard, then send terminal SIGINT during the watched run."""
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.environ.pop("CI", None)
        os.execvp(command[0], command)
    deadline = time.monotonic() + 15
    output, prompt_seen = read_until(master_fd, b"Test ids (space-separated) or all [all]: ", deadline)
    if prompt_seen:
        os.write(master_fd, b"refund\n")
    chunk, run_seen = read_until(master_fd, b"started: 0 cases", deadline)
    output += chunk
    if run_seen:
        os.write(master_fd, b"\x03")
    evidence = finish_child(child_pid, master_fd, output, deadline)
    evidence.update({"prompt_seen": prompt_seen, "run_seen": run_seen})
    return evidence


def main() -> None:
    """Run the supplied command and print JSON evidence for Vitest."""
    print(json.dumps(drive(sys.argv[1:])))


if __name__ == "__main__":
    main()
