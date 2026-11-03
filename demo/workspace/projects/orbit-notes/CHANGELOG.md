# Changelog

## 0.14.2 (beta)
- Sync status badge shows "waiting for relay" instead of a spinner.
- Conflict banner names the device that made the other edit.
- Fixed: pinned notes lost their order after a full resync.

## 0.14.0
- Hybrid logical clocks replace wall-clock stamps for field merges ([sync protocol](docs/sync-protocol.md)).
- Operation log compaction runs after 5,000 ops or on app close.
- Desktop: tray menu with "Sync now" and "Pause sync".

## 0.13.0
- Web build works offline with a service worker.
- Search index moved off the main thread.
