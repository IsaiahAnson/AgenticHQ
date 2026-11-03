"""Build daily_station from clean readings."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb

SQL = (Path(__file__).parent.parent / "sql" / "daily_rollup.sql").read_text()


def rollup_day(con: duckdb.DuckDBPyConnection, day: date) -> int:
    con.execute("delete from daily_station where day = ?", [day])
    con.execute(SQL, [day, day])
    row = con.execute("select count(*) from daily_station where day = ?", [day]).fetchone()
    return int(row[0]) if row else 0
