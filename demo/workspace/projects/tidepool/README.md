# tidepool

A small pipeline for six coastal weather boxes. Each box reports air temperature, humidity, wind, pressure and water level every five minutes over LoRa to a gateway, which drops CSV files into an inbox folder. tidepool ingests them into DuckDB, runs quality checks and builds the daily rollups behind the dashboard.

- Sensors and stations: [docs/sensors.md](docs/sensors.md)
- Pipeline stages: [docs/pipeline.md](docs/pipeline.md)
- Daily rollup query: [sql/daily_rollup.sql](sql/daily_rollup.sql)
- Calibration notes: [notes/meetings/2026-10-09-tidepool-calibration.md](../../notes/meetings/2026-10-09-tidepool-calibration.md)

## Run it

```
uv sync
uv run tidepool ingest samples/
uv run tidepool qc --since 7d
uv run streamlit run dashboard/app.py   # http://localhost:8501
uv run pytest
```

Station boxes sit on a private network; when one goes quiet, follow [ops/runbooks/sensor-box-offline.md](../../ops/runbooks/sensor-box-offline.md).
