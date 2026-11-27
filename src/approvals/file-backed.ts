/**
 * Default ApprovalStore: append-only JSONL, one full snapshot per line.
 *
 * Nothing touches the filesystem until the first append(). readLatest()
 * collapses snapshots to the latest per intent_id for readers (the CLI).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ApprovalRecord } from "../approval-record.js";
import type { ApprovalStore } from "../types.js";

export interface FileBackedApprovalOptions {
  /** Path to the JSONL file. Defaults to ./.blacktea/approvals.jsonl. */
  path?: string;
}

export class FileBackedApprovalStore implements ApprovalStore {
  private readonly path: string;

  constructor(opts: FileBackedApprovalOptions = {}) {
    this.path = resolve(opts.path ?? "./.blacktea/approvals.jsonl");
  }

  async append(record: ApprovalRecord): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }

  /**
   * Latest snapshot per intent_id, newest updated_at first. Missing file
   * yields []. Unparseable lines are skipped.
   */
  static readLatest(path: string): ApprovalRecord[] {
    const file = resolve(path);
    if (!existsSync(file)) return [];
    const latest = new Map<string, ApprovalRecord>();
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (line.trim().length === 0) continue;
      let rec: ApprovalRecord;
      try {
        rec = JSON.parse(line) as ApprovalRecord;
      } catch {
        continue;
      }
      if (typeof rec?.intent_id !== "string") continue;
      const prev = latest.get(rec.intent_id);
      if (!prev || rec.updated_at >= prev.updated_at) latest.set(rec.intent_id, rec);
    }
    return [...latest.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }
}
