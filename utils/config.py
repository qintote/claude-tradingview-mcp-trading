"""
Configuration management — loads and validates all env vars at startup.
Fails fast with a clear error if a required variable is missing.
"""

import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    # ── Scheduling ────────────────────────────────────────────────────────────
    timezone: str           = field(default_factory=lambda: os.getenv("SCHEDULER_TIMEZONE", "UTC"))
    asset: str              = field(default_factory=lambda: os.getenv("ASSET", "XAUUSD"))
    bot_command: str        = field(default_factory=lambda: os.getenv("BOT_COMMAND", "python main.py"))
    bot_args: str           = field(default_factory=lambda: os.getenv("BOT_ARGS", "--mode=scan"))

    # ── Lock ─────────────────────────────────────────────────────────────────
    lock_dir: str           = field(default_factory=lambda: os.getenv("LOCK_DIR", "/tmp"))
    lock_name: str          = field(default_factory=lambda: os.getenv("LOCK_NAME", "xauusd_scanner"))
    # Maximum seconds a lock is considered valid before treated as stale
    lock_ttl_seconds: int   = field(default_factory=lambda: int(os.getenv("LOCK_TTL_SECONDS", "300")))

    # ── Retry ────────────────────────────────────────────────────────────────
    max_retries: int        = field(default_factory=lambda: int(os.getenv("MAX_RETRIES", "3")))
    retry_delay_seconds: float = field(default_factory=lambda: float(os.getenv("RETRY_DELAY_SECONDS", "5.0")))

    # ── Health ────────────────────────────────────────────────────────────────
    max_consecutive_failures: int = field(
        default_factory=lambda: int(os.getenv("MAX_CONSECUTIVE_FAILURES", "5"))
    )

    # ── Logging ──────────────────────────────────────────────────────────────
    log_level: str          = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))
    log_format: str         = field(default_factory=lambda: os.getenv("LOG_FORMAT", "json"))

    def validate(self) -> None:
        """Raise on startup if config is invalid."""
        try:
            import pytz
            pytz.timezone(self.timezone)
        except Exception:
            raise ValueError(f"Invalid SCHEDULER_TIMEZONE: '{self.timezone}'")

        if self.lock_ttl_seconds < 30:
            raise ValueError("LOCK_TTL_SECONDS must be >= 30")

        if self.max_retries < 0:
            raise ValueError("MAX_RETRIES must be >= 0")

        if self.log_level not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
            raise ValueError(f"Invalid LOG_LEVEL: '{self.log_level}'")


# Singleton — imported everywhere
config = Config()
