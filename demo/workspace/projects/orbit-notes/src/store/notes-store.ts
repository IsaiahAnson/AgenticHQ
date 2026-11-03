import { get, set, keys } from "idb-keyval";

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  updatedAt: number;
}

const PREFIX = "note:";

export async function saveNote(note: Note): Promise<void> {
  await set(PREFIX + note.id, { ...note, updatedAt: Date.now() });
}

export async function loadNote(id: string): Promise<Note | undefined> {
  return get(PREFIX + id);
}

export async function listNotes(): Promise<Note[]> {
  const all = await keys();
  const ids = all.map(String).filter((k) => k.startsWith(PREFIX));
  const notes = await Promise.all(ids.map((k) => get(k)));
  return (notes.filter(Boolean) as Note[]).sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
  );
}
