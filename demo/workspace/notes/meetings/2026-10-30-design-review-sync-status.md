# Design review: sync status

Friday, October 30, 11:00 AM. Priya, me.

## Proposals
| State | Badge text | Icon |
|---|---|---|
| idle | Synced | filled circle |
| sending / receiving | Syncing | rotating arc, slow |
| waiting-for-relay | Waiting for relay | hollow circle |
| paused | Sync paused | pause bars |

## Notes
- No spinner that runs forever. If nothing happens for 30 seconds, show "Waiting for relay".
- Conflict banner: "Edited on Sam's laptop at 4:12 PM. Keep both?" Name the device, show the time.
- Priya delivers final icons by Wednesday.

Source of the request: [beta tester call](2026-10-16-beta-tester-call.md). Code: [App.tsx](../../projects/orbit-notes/src/app/App.tsx).
