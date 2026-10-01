"""Drive the metric assertion wizard through one complete real-PTY trace journey."""

import json
import os
import pty
import select
import signal
import sys
import termios
import time


def read_once(master_fd: int, timeout: float) -> bytes:
    """Read available terminal bytes while treating child-exit EIO as EOF."""
    readable, _, _ = select.select([master_fd], [], [], timeout)
    if not readable:
        return b""
    try:
        return os.read(master_fd, 4096)
    except OSError:
        return b""


def read_until(master_fd: int, expected: bytes, deadline: float) -> tuple[bytes, bool]:
    """Collect terminal output until one expected prompt or a bounded deadline."""
    output = b""
    while expected not in output and time.monotonic() < deadline:
        output += read_once(master_fd, 0.1)
    return output, expected in output


def finish_child(
    child_pid: int, master_fd: int, output: bytes, deadline: float
) -> tuple[int, bytes, bool]:
    """Collect a bounded child exit and verify that terminal modes were restored."""
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
    return os.waitstatus_to_exitcode(status), output, terminal_restored


def drive(command: list[str]) -> dict[str, object]:
    """Answer kind, evidence, capability, operator, value, and preview prompts in order."""
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.environ.pop("CI", None)
        os.execvp(command[0], command)
    deadline = time.monotonic() + 12
    output = b""
    prompts = [
        (b"Metric kind [assertion]", b"\n"),
        (b"Assertion evidence [output]", b"trace\n"),
        (b"Agent for capability guidance [traced]", b"\n"),
        (b"Trace operator [tool-called]", b"tool-called\n"),
        (b"Tool name: ", b"search\n"),
        (b"Apply these changes? [y/N]: ", b"yes\n"),
    ]
    seen: list[bool] = []
    for prompt, answer in prompts:
        chunk, prompt_seen = read_until(master_fd, prompt, deadline)
        output += chunk
        seen.append(prompt_seen)
        if not prompt_seen:
            break
        os.write(master_fd, answer)
    exit_code, output, terminal_restored = finish_child(
        child_pid, master_fd, output, deadline
    )
    return {
        "exit_code": exit_code,
        "output": output.decode("utf-8", errors="replace"),
        "prompts_seen": seen,
        "terminal_restored": terminal_restored,
    }


def main() -> None:
    """Run the supplied CLI command and print machine-readable PTY evidence."""
    print(json.dumps(drive(sys.argv[1:])))


if __name__ == "__main__":
    main()
