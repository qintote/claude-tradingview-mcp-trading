"""
File-based exclusive process lock with stale-PID detection.

A lock file stores the PID of the owning process.  On acquisition we check:
  1. Does the file exist?
  2. If yes, is the PID still alive (psutil)?
  3. Is the lock younger than LOCK_TTL_SECONDS?
If the stored PID is dead OR the lock is older than the TTL, the lock is
treated as stale and removed before we try to acquire our own.
"""

from __future__ import annotations
import os
import time
from pathlib import Path
from typing import Optional
import psutil
from utils.config import config
from utils.logger import get_logger

log = get_logger("lock")


class LockError(RuntimeError):
    """Raised when the lock cannot be acquired."""


class ProcessLock:
    def __init__(self) -> None:
        self.path = Path(config.lock_dir) / f"{config.lock_name}.lock"
        self._acquired = False

    # ── public API ────────────────────────────────────────────────────────────

    def acquire(self) -> None:
        """Try to acquire the lock; raise LockError if another live process holds it."""
        self._evict_stale()
        try:
            # Atomic open: O_CREAT | O_EXCL fails if file exists
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w") as f:
                f.write(str(os.getpid()))
            self._acquired = True
            log.info("lock_acquired", path=str(self.path), pid=os.getpid())
        except FileExistsError:
            pid = self._read_pid()
            raise LockError(
                f"Lock held by PID {pid} at {self.path}"
            )

    def release(self) -> None:
        if self._acquired and self.path.exists():
            self.path.unlink(missing_ok=True)
            self._acquired = False
            log.info("lock_released", path=str(self.path))

    def __enter__(self) -> "ProcessLock":
        self.acquire()
        return self

    def __exit__(self, *_) -> None:
        self.release()

    # ── internals ─────────────────────────────────────────────────────────────

    def _evict_stale(self) -> None:
        if not self.path.exists():
            return

        age = time.time() - self.path.stat().st_mtime
        pid = self._read_pid()

        pid_dead = pid is None or not _pid_alive(pid)
        too_old = age > config.lock_ttl_seconds

        if pid_dead or too_old:
            reason = "dead_pid" if pid_dead else "ttl_exceeded"
            log.warning("stale_lock_removed", path=str(self.path),
                        pid=pid, age_seconds=round(age, 1), reason=reason)
            self.path.unlink(missing_ok=True)

    def _read_pid(self) -> Optional[int]:
        try:
            return int(self.path.read_text().strip())
        except (ValueError, OSError):
            return None


def _pid_alive(pid: int) -> bool:
    try:
        proc = psutil.Process(pid)
        # status() raises NoSuchProcess if PID is gone; zombie means dead
        return proc.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
