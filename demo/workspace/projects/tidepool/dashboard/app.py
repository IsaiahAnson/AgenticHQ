"""Tidepool dashboard: streamlit run dashboard/app.py (port 8501)."""

import duckdb
import streamlit as st

st.set_page_config(page_title="Tidepool", layout="wide")
con = duckdb.connect("tidepool.duckdb", read_only=True)

stations = [r[0] for r in con.execute("select distinct station from daily_station order by 1").fetchall()]
pick = st.sidebar.multiselect("Stations", stations, default=stations[:3])
metric = st.sidebar.selectbox("Metric", ["temp_c", "wind_ms", "water_level_m", "pressure_hpa"])

df = con.execute(
    "select day, station, avg_value from daily_station where metric = ? and station in (select unnest(?)) order by day",
    [metric, pick],
).pl()

st.title("Tidepool")
st.line_chart(df.pivot(on="station", index="day", values="avg_value"), x="day")
flags = con.execute("select count(*) from qc_flags where day >= current_date - 7").fetchone()[0]
st.caption(f"{flags} QC flags in the last 7 days")
