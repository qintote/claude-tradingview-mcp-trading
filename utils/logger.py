"""
Structured JSON logger — single shared instance for the whole scheduler.
"""

import logging
import sys
import structlog
from utils.config import config


def _configure_stdlib() -> None:
    level = getattr(logging, config.log_level, logging.INFO)
    logging.basicConfig(
        stream=sys.stdout,
        format="%(message)s",
        level=level,
    )
    # Silence noisy third-party loggers
    for name in ("apscheduler", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)


def _build_processors(json_output: bool) -> list:
    shared = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    if json_output:
        shared.append(structlog.processors.JSONRenderer())
    else:
        shared.append(structlog.dev.ConsoleRenderer(colors=True))
    return shared


def setup_logging() -> None:
    _configure_stdlib()
    json_output = config.log_format.lower() == "json"
    structlog.configure(
        processors=_build_processors(json_output),
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, config.log_level, logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(sys.stdout),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "scheduler") -> structlog.BoundLogger:
    return structlog.get_logger(name)
