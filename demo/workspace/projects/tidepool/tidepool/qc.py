"""Quality checks. Flags are added, readings are never removed."""

from __future__ import annotations

from dataclasses import dataclass

RANGES = {
    "temp_c": (-20.0, 45.0),
    "humidity_pct": (0.0, 100.0),
    "wind_ms": (0.0, 60.0),
    "pressure_hpa": (930.0, 1060.0),
    "water_level_m": (-1.5, 4.5),
}


@dataclass
class Flag:
    station: str
    metric: str
    reason: str


def out_of_range(metric: str, value: float) -> bool:
    low, high = RANGES.get(metric, (float("-inf"), float("inf")))
    return not (low <= value <= high)


def flat_line(values: list[float], window: int = 12) -> bool:
    """True when the last `window` readings are identical (a stuck sensor)."""
    tail = values[-window:]
    return len(tail) == window and len(set(tail)) == 1


def spike(prev: float, current: float, limit: float) -> bool:
    return abs(current - prev) > limit
