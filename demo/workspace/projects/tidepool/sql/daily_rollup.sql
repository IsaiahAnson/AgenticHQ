-- One row per station, metric and day. Flagged readings are left out.
insert into daily_station
select
  station,
  cast(ts_utc as date) as day,
  metric,
  min(value) as min_value,
  avg(value) as avg_value,
  max(value) as max_value,
  count(*) as readings
from clean_readings
where cast(ts_utc as date) = ?
  and not exists (
    select 1 from qc_flags f
    where f.station = clean_readings.station
      and f.metric = clean_readings.metric
      and f.ts_utc = clean_readings.ts_utc
      and cast(f.ts_utc as date) = ?
  )
group by station, day, metric;
