"""Drive one command through a real PTY: wait for each expected output, then send its input.

Usage: drive-pty.py '<steps JSON>' command [args...]
Each step is {"expect": "<output text>", "send": "<input text>"}. Prints JSON evidence.
"""

import json
import os
import pty
import select
import signal
import sys
import termios
import time


def read_once(master_fd: int, timeout: float) -> bytes:
    """Read available PTY bytes, treating the child-exit EIO as EOF."""
    readable, _, _ = select.select([master_fd], [], [], timeout)
    if not readable:
        return b""
    try:
        return os.read(master_fd, 4096)
    except OSError:
        return b""


def read_until(master_fd: int, expected: bytes, deadline: float) -> tuple[bytes, bool]:
    """Collect output until the marker appears or the deadline passes."""
    output = b""
    while expected not in output and time.monotonic() < deadline:
        output += read_once(master_fd, 0.1)
    return output, expected in output


def finish_child(child_pid: int, master_fd: int, output: bytes, deadline: float) -> dict[str, object]:
    """Wait for the child, then check that canonical terminal modes were restored."""
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


def drive(steps: list[dict[str, str]], command: list[str]) -> dict[str, object]:
    """Run the command in a PTY and play the steps in order, stopping at the first miss."""
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.environ.pop("CI", None)
        os.execvp(command[0], command)
    deadline = time.monotonic() + 15
    output = b""
    steps_seen = []
    for step in steps:
        chunk, seen = read_until(master_fd, step["expect"].encode("utf-8"), deadline)
        output += chunk
        steps_seen.append(seen)
        if not seen:
            break
        os.write(master_fd, step["send"].encode("utf-8"))
    evidence = finish_child(child_pid, master_fd, output, deadline)
    evidence["steps_seen"] = steps_seen
    return evidence


def main() -> None:
    """Print the JSON evidence for the caller."""
    print(json.dumps(drive(json.loads(sys.argv[1]), sys.argv[2:])))


if __name__ == "__main__":
    main()
