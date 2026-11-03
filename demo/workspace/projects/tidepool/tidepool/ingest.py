"""Load gateway CSV drops into raw_readings."""

from __future__ import annotations

import hashlib
from pathlib import Path

import duckdb

SCHEMA = """
create table if not exists raw_readings (
  station text, ts_utc timestamp, metric text, value double, battery_v double, source_file text
);
create table if not exists seen_files (sha256 text primary key, name text, loaded_at timestamp);
"""


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ingest_folder(con: duckdb.DuckDBPyConnection, inbox: Path) -> int:
    con.execute(SCHEMA)
    loaded = 0
    for csv in sorted(inbox.glob("*.csv")):
        digest = file_hash(csv)
        if con.execute("select 1 from seen_files where sha256 = ?", [digest]).fetchone():
            continue
        con.execute(
            "insert into raw_readings select *, ? from read_csv(?, header = true)",
            [csv.name, str(csv)],
        )
        con.execute("insert into seen_files values (?, ?, now())", [digest, csv.name])
        loaded += 1
    return loaded
