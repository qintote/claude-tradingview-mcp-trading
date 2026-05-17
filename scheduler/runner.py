"""
Job runner: acquires the file lock, spawns the bot subprocess, retries on
failure, and updates the health tracker.
"""

from __future__ import annotations
import subprocess
import time
from utils.config import config
from utils.health import health
from utils.logger import get_logger
from scheduler.lock import ProcessLock, LockError

log = get_logger("runner")


def run_job() -> None:
    """Entry point called by APScheduler for every cron trigger."""
    lock = ProcessLock()

    try:
        lock.acquire()
    except LockError as exc:
        # Another instance is running — skip this tick silently
        log.info("job_skipped_lock_busy", reason=str(exc))
        return

    try:
        _run_with_retry(lock)
    finally:
        lock.release()


def _run_with_retry(lock: ProcessLock) -> None:
    cmd = f"{config.bot_command} {config.bot_args}".strip()
    attempt = 0

    while attempt <= config.max_retries:
        attempt += 1
        log.info("job_attempt", attempt=attempt, max=config.max_retries + 1, cmd=cmd)

        try:
            result = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=config.lock_ttl_seconds - 10,  # leave headroom before lock expires
            )

            if result.stdout:
                log.debug("bot_stdout", output=result.stdout.strip())
            if result.stderr:
                log.warning("bot_stderr", output=result.stderr.strip())

            if result.returncode == 0:
                health.record_success()
                log.info("job_completed", attempt=attempt, returncode=0)
                return

            raise RuntimeError(
                f"bot exited with code {result.returncode}: {result.stderr.strip()[:200]}"
            )

        except subprocess.TimeoutExpired as exc:
            _handle_transient(exc, attempt)
        except RuntimeError as exc:
            _handle_transient(exc, attempt)
        except Exception as exc:  # unexpected
            health.record_failure(exc)
            log.error("job_unexpected_error", error=str(exc), exc_info=True)
            return  # don't retry on unknown errors

    # All retries exhausted
    final_exc = RuntimeError(f"job failed after {config.max_retries + 1} attempts")
    health.record_failure(final_exc)


def _handle_transient(exc: Exception, attempt: int) -> None:
    if attempt > config.max_retries:
        return  # caller loop will exit; health updated after loop
    log.warning("job_retry",
                attempt=attempt,
                delay=config.retry_delay_seconds,
                error=str(exc))
    time.sleep(config.retry_delay_seconds)
