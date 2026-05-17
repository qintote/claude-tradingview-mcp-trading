"""
Entry point for the production XAUUSD trading scheduler.

Usage:
    python run_scheduler.py

Environment:
    Copy .env.example → .env and fill in your values.
    On Railway set variables via the dashboard.
"""

import sys
from utils.config import config
from utils.logger import setup_logging, get_logger


def main() -> None:
    setup_logging()
    log = get_logger("main")

    log.info("startup", asset=config.asset, timezone=config.timezone,
             log_level=config.log_level, log_format=config.log_format)

    try:
        config.validate()
        log.info("config_valid")
    except ValueError as exc:
        log.error("config_invalid", error=str(exc))
        sys.exit(1)

    # Import scheduler after logging is configured so APScheduler logs go through structlog
    from scheduler.scheduler import start
    start()


if __name__ == "__main__":
    main()
