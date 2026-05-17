"""
Simple in-process health tracker.  Counts consecutive job failures and
raises an alert (log + optional future webhook) when the threshold is hit.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone
from utils.config import config
from utils.logger import get_logger

log = get_logger("health")


@dataclass
class HealthTracker:
    consecutive_failures: int = 0
    total_runs: int = 0
    total_failures: int = 0
    last_success: datetime | None = None
    last_failure: datetime | None = None
    _alert_fired: bool = field(default=False, repr=False)

    def record_success(self) -> None:
        self.total_runs += 1
        self.consecutive_failures = 0
        self._alert_fired = False
        self.last_success = datetime.now(timezone.utc)
        log.info("job_success",
                 total_runs=self.total_runs,
                 last_success=self.last_success.isoformat())

    def record_failure(self, exc: Exception) -> None:
        self.total_runs += 1
        self.total_failures += 1
        self.consecutive_failures += 1
        self.last_failure = datetime.now(timezone.utc)
        log.warning("job_failure",
                    consecutive=self.consecutive_failures,
                    total_failures=self.total_failures,
                    error=str(exc))
        if (self.consecutive_failures >= config.max_consecutive_failures
                and not self._alert_fired):
            self._fire_alert()

    def _fire_alert(self) -> None:
        self._alert_fired = True
        log.error("health_alert",
                  consecutive_failures=self.consecutive_failures,
                  threshold=config.max_consecutive_failures,
                  message="Too many consecutive failures — check the bot process")

    @property
    def is_healthy(self) -> bool:
        return self.consecutive_failures < config.max_consecutive_failures

    def summary(self) -> dict:
        return {
            "total_runs": self.total_runs,
            "total_failures": self.total_failures,
            "consecutive_failures": self.consecutive_failures,
            "is_healthy": self.is_healthy,
            "last_success": self.last_success.isoformat() if self.last_success else None,
            "last_failure": self.last_failure.isoformat() if self.last_failure else None,
        }


# Singleton
health = HealthTracker()
