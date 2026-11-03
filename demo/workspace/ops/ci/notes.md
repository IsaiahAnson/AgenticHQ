# CI notes

- All Node projects run on Node 22, the same as local ([lesson](../../memory/lessons/ci.md)).
- tidepool runs on Python 3.12 with `uv`.
- orbit-notes runs unit tests, then Playwright e2e on Chromium.
- Quarantined tests carry an issue link in the skip message; `/weekly-review` counts them.
- Theo owns the runners and release builds.
