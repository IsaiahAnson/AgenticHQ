export const SCHEMA_VERSION = 6;

export type Field = "title" | "body" | "tags" | "pinned" | "deleted";

export interface Hlc {
  wall: number;
  count: number;
  device: string;
}

export interface Op {
  id: string;
  noteId: string;
  field: Field;
  value: unknown;
  hlc: Hlc;
  device: string;
}

export interface OpLog {
  lastRemoteStamp(): Promise<Hlc | null>;
  headFor(ops: Op[]): Promise<Op[]>;
  applyRemote(ops: Op[]): Promise<void>;
  unsent(): Promise<Op[]>;
  markSent(ids: string[]): Promise<void>;
}

export interface RelayClient {
  reachable(): Promise<boolean>;
  pull(since: Hlc | null, limit: number): Promise<Op[]>;
  push(ops: Op[]): Promise<void>;
}
