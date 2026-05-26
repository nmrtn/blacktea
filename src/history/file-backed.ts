/**
 * Default HistoryStore: append-only JSONL file with an in-memory index.
 *
 * On construction, reads the file (if it exists) into an in-memory array.
 * record() appends one JSON line to the file AND updates the in-memory array.
 * sumSince/countSince are answered from memory (no disk reads at query time).
 * prune() rewrites the file with the events younger than the cutoff.
 *
 * v1 trade-offs:
 *   - The whole history is kept in memory. For agents doing 1000 payments/day
 *     this is ~30k lines after a month. Fine.
 *   - No file locking. Two processes pointing at the same path will corrupt
 *     each other's writes. Document this and put the path in a per-process
 *     subdirectory if you run multiple agents.
 *   - Corrupted lines in the JSONL file are skipped with a warning, not fatal.
 *
 * Swap for Redis or SQLite by implementing the HistoryStore interface and
 * passing it to blacktea() as `history`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HistoryFilter, HistoryRecord, HistoryStore } from "../types.js";

export interface FileBackedHistoryOptions {
  /** Path to the JSONL file. Defaults to ./.blacktea/history.jsonl. */
  path?: string;
}

export class FileBackedHistoryStore implements HistoryStore {
  private readonly path: string;
  private events: HistoryRecord[] = [];

  constructor(opts: FileBackedHistoryOptions = {}) {
    this.path = resolve(opts.path ?? "./.blacktea/history.jsonl");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.path)) {
      // Ensure the directory exists so the first record() succeeds.
      mkdirSync(dirname(this.path), { recursive: true });
      this.events = [];
      return;
    }
    const text = readFileSync(this.path, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const parsed: HistoryRecord[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as HistoryRecord;
        parsed.push(event);
      } catch (_err) {
        // Skip corrupted lines. A future version can write them to a quarantine
        // file. For now, warn loud so the contributor knows something is off.
        console.warn(`[blacktea] skipped corrupted history line in ${this.path}`);
      }
    }
    this.events = parsed;
  }

  async record(event: HistoryRecord): Promise<void> {
    this.events.push(event);
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf-8");
  }

  async sumSince(opts: { seconds: number; filter?: HistoryFilter }): Promise<number> {
    const cutoff = Date.now() - opts.seconds * 1000;
    let sum = 0;
    for (const e of this.events) {
      if (Date.parse(e.ts) < cutoff) continue;
      if (!matchesFilter(e, opts.filter)) continue;
      sum += e.amount;
    }
    return sum;
  }

  async countSince(opts: { seconds: number; filter?: HistoryFilter }): Promise<number> {
    const cutoff = Date.now() - opts.seconds * 1000;
    let count = 0;
    for (const e of this.events) {
      if (Date.parse(e.ts) < cutoff) continue;
      if (!matchesFilter(e, opts.filter)) continue;
      count += 1;
    }
    return count;
  }

  async prune(older_than_seconds: number): Promise<number> {
    const cutoff = Date.now() - older_than_seconds * 1000;
    const kept = this.events.filter((e) => Date.parse(e.ts) >= cutoff);
    const dropped = this.events.length - kept.length;
    if (dropped === 0) return 0;
    this.events = kept;
    // Rewrite the file with the kept events. This is the only synchronous
    // truncate-and-rewrite path; everything else is append-only.
    const text = kept.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(this.path, text.length > 0 ? `${text}\n` : "", "utf-8");
    return dropped;
  }

  /** Test helper. Not part of the HistoryStore interface. */
  size(): number {
    return this.events.length;
  }

  /** Test helper. Not part of the HistoryStore interface. */
  filePath(): string {
    return this.path;
  }
}

function matchesFilter(event: HistoryRecord, filter: HistoryFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.wallet && event.recipient_wallet !== filter.wallet) return false;
  if (filter.url && event.recipient_url !== filter.url) return false;
  return true;
}
