import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../../src/approval-record.js";
import { FileBackedApprovalStore } from "../../src/approvals/file-backed.js";

function rec(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    intent_id: "a",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    state: "staged",
    channel: "staged",
    mcp_server: null,
    tool: null,
    actor: null,
    amount: 1,
    currency: "USDC",
    recipient_url: "https://example.com/x",
    intent: "buy data",
    trigger: null,
    rule_fired: "rule_1",
    decision_reason: null,
    params_hash: "sha256:jcs-v1:abc",
    expires_at: "2026-01-01T00:10:00Z",
    ...overrides,
  };
}

describe("FileBackedApprovalStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bt-appr-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not touch the filesystem until the first append", () => {
    new FileBackedApprovalStore({ path: join(dir, "nested", "approvals.jsonl") });
    expect(existsSync(join(dir, "nested"))).toBe(false);
  });

  it("appends one JSON line per snapshot and creates the directory", async () => {
    const p = join(dir, "nested", "approvals.jsonl");
    const store = new FileBackedApprovalStore({ path: p });
    await store.append(
      rec({ intent_id: "a", state: "staged", updated_at: "2026-01-01T00:00:00Z" }),
    );
    await store.append(
      rec({ intent_id: "a", state: "settled", updated_at: "2026-01-01T00:00:05Z" }),
    );
    expect(readFileSync(p, "utf-8").trim().split("\n")).toHaveLength(2);
  });

  it("readLatest collapses to the latest snapshot per intent, newest first, skipping bad lines", async () => {
    const p = join(dir, "approvals.jsonl");
    const store = new FileBackedApprovalStore({ path: p });
    await store.append(
      rec({ intent_id: "a", state: "staged", updated_at: "2026-01-01T00:00:00Z" }),
    );
    await store.append(
      rec({ intent_id: "a", state: "settled", updated_at: "2026-01-01T00:00:05Z" }),
    );
    await store.append(
      rec({ intent_id: "b", state: "staged", updated_at: "2026-01-01T00:01:00Z" }),
    );
    writeFileSync(p, `${readFileSync(p, "utf-8")}not json\n`);
    expect(FileBackedApprovalStore.readLatest(p).map((r) => [r.intent_id, r.state])).toEqual([
      ["b", "staged"],
      ["a", "settled"],
    ]);
  });

  it("readLatest skips records without a string intent_id and updated_at", async () => {
    const p = join(dir, "approvals.jsonl");
    const store = new FileBackedApprovalStore({ path: p });
    await store.append(rec({ intent_id: "a", updated_at: "2026-01-01T00:00:00Z" }));
    writeFileSync(
      p,
      `${readFileSync(p, "utf-8")}{"intent_id":"x"}\n{"intent_id":"y","updated_at":5}\n{"updated_at":"2026-01-02T00:00:00Z"}\nnull\n`,
    );
    expect(FileBackedApprovalStore.readLatest(p).map((r) => r.intent_id)).toEqual(["a"]);
  });

  it("readLatest keeps file order for records with the same updated_at", async () => {
    const p = join(dir, "approvals.jsonl");
    const store = new FileBackedApprovalStore({ path: p });
    for (const id of ["a", "b", "c"]) {
      await store.append(rec({ intent_id: id, updated_at: "2026-01-01T00:00:00Z" }));
    }
    expect(FileBackedApprovalStore.readLatest(p).map((r) => r.intent_id)).toEqual(["a", "b", "c"]);
  });

  it("readLatest returns [] when the file does not exist", () => {
    expect(FileBackedApprovalStore.readLatest(join(dir, "none.jsonl"))).toEqual([]);
  });
});
