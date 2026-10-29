"""Linux PTY regression for the WSL ownership helper, not Windows/wslpath certification.

Run: python3 scripts/terminal-shell-drop/probe.py <path-to-wsl_probe.sh>
Uses only disposable PTYs/processes. No user files or clipboard contents.
"""
import os
import pty
import signal
import subprocess
import sys
import time
import uuid


def check(command, expected):
    token = uuid.uuid4().hex
    pid, fd = pty.fork()
    if pid == 0:
        os.execl(
            "/bin/sh", "/bin/sh", "-c",
            'OARLOCK_DROP_OWNER="$1:$$"; export OARLOCK_DROP_OWNER; shift; exec "$@"',
            "oarlock-shell", token, "/bin/sh", "-c", command,
        )
    try:
        time.sleep(0.1)
        path = "/tmp/it's$(printf nope) with spaces"
        result = subprocess.run(
            ["/bin/sh", sys.argv[1], token, "/bin/sh", "wsl", path],
            capture_output=True, timeout=3,
        )
        if expected:
            assert result.returncode == 0, (result.returncode, result.stderr)
            assert result.stdout.split(b"\0") == [
                os.path.realpath("/bin/sh").encode(), path.encode(), b"",
            ], result.stdout
        else:
            assert result.returncode != 0, result.stdout
        print("PASS", command, flush=True)
    finally:
        # Only processes in this test's private session are terminated.
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open("/proc/" + entry + "/stat") as file:
                    stat = file.read().rsplit(") ", 1)[1].split()
                if stat[3] == str(pid):
                    os.kill(int(entry), signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        os.close(fd)


check("read line", True)
check("exec /bin/sleep 30", False)
check("set -m; /bin/sleep 30; :", False)
check("(read line); :", False)
