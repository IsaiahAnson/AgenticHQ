import { mergeOps } from "./merge";
import type { Op, RelayClient, OpLog } from "./schema";

export type SyncState = "idle" | "sending" | "receiving" | "waiting-for-relay" | "paused";

export class SyncEngine {
  private state: SyncState = "idle";
  private listeners = new Set<(s: SyncState) => void>();

  constructor(private log: OpLog, private relay: RelayClient) {}

  onState(fn: (s: SyncState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: SyncState) {
    this.state = next;
    for (const fn of this.listeners) fn(next);
  }

  pause() {
    this.set("paused");
  }

  async round(): Promise<number> {
    if (this.state === "paused") return 0;
    if (!(await this.relay.reachable())) {
      this.set("waiting-for-relay");
      return 0;
    }
    this.set("receiving");
    const since = await this.log.lastRemoteStamp();
    const incoming: Op[] = await this.relay.pull(since, 500);
    const merged = mergeOps(await this.log.headFor(incoming), incoming);
    await this.log.applyRemote(merged);

    this.set("sending");
    const outgoing = await this.log.unsent();
    if (outgoing.length > 0) {
      await this.relay.push(outgoing);
      await this.log.markSent(outgoing.map((op) => op.id));
    }
    this.set("idle");
    return incoming.length + outgoing.length;
  }
}
