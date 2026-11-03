import { useEffect, useState } from "react";
import { listNotes, type Note } from "../store/notes-store";
import type { SyncState } from "../sync/engine";

const LABELS: Record<SyncState, string> = {
  idle: "Synced",
  sending: "Sending changes",
  receiving: "Getting changes",
  "waiting-for-relay": "Waiting for relay",
  paused: "Sync paused",
};

export function App({ syncState }: { syncState: SyncState }) {
  const [notes, setNotes] = useState<Note[]>([]);

  useEffect(() => {
    listNotes().then(setNotes);
  }, []);

  return (
    <main className="orbit">
      <header>
        <h1>Orbit Notes</h1>
        <span className={"sync sync-" + syncState}>{LABELS[syncState]}</span>
      </header>
      <ul>
        {notes.map((n) => (
          <li key={n.id} className={n.pinned ? "pinned" : undefined}>
            {n.title || "Untitled"}
          </li>
        ))}
      </ul>
    </main>
  );
}
