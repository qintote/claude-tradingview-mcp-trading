"""
APScheduler setup with three cron windows (Mon-Fri, UTC).

  Window A — London open build-up:   every 15 min, 03:00–07:59
  Window B — NY overlap peak:         every  5 min, 08:00–12:59
  Window C — NY afternoon / close:    every 15 min, 14:00–20:59

Overlap 13:00–13:59 is intentionally skipped (low liquidity transition).
"""

import signal
import sys
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from utils.config import config
from utils.health import health
from utils.logger import get_logger
from scheduler.runner import run_job

log = get_logger("scheduler")

_WINDOWS = [
    {
        "id": "london_open",
        "label": "London open (every 15 min, 03-07 UTC)",
        "cron": dict(minute="*/15", hour="3-7", day_of_week="mon-fri"),
    },
    {
        "id": "ny_overlap",
        "label": "NY overlap peak (every 5 min, 08-12 UTC)",
        "cron": dict(minute="*/5", hour="8-12", day_of_week="mon-fri"),
    },
    {
        "id": "ny_afternoon",
        "label": "NY afternoon/close (every 15 min, 14-20 UTC)",
        "cron": dict(minute="*/15", hour="14-20", day_of_week="mon-fri"),
    },
]


def build_scheduler() -> BlockingScheduler:
    tz = config.timezone
    scheduler = BlockingScheduler(timezone=tz)

    for window in _WINDOWS:
        trigger = CronTrigger(timezone=tz, **window["cron"])
        scheduler.add_job(
            run_job,
            trigger=trigger,
            id=window["id"],
            name=window["label"],
            max_instances=1,      # never run the same job twice concurrently
            coalesce=True,        # if scheduler was paused, run once not N times
            misfire_grace_time=60,
        )
        log.info("cron_registered", id=window["id"], label=window["label"], tz=tz)

    return scheduler


def _shutdown(scheduler: BlockingScheduler, signum: int, *_) -> None:
    sig_name = signal.Signals(signum).name
    log.info("shutdown_signal", signal=sig_name, health=health.summary())
    scheduler.shutdown(wait=False)
    sys.exit(0)


def start() -> None:
    scheduler = build_scheduler()

    # Graceful shutdown on SIGINT / SIGTERM
    signal.signal(signal.SIGINT, lambda s, f: _shutdown(scheduler, s, f))
    signal.signal(signal.SIGTERM, lambda s, f: _shutdown(scheduler, s, f))

    log.info("scheduler_starting",
             asset=config.asset,
             timezone=config.timezone,
             windows=len(_WINDOWS))
    scheduler.start()  # blocks until shutdown
