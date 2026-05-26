import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBackedHistoryStore } from "../../src/history/file-backed.js";
import type { HistoryRecord } from "../../src/types.js";

function recordAt(secondsAgo: number, partial: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    ts: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    amount: 50,
    currency: "USDC",
    rule_fired: "test",
    intent_id: `intent_${Math.random().toString(36).slice(2)}`,
    ...partial,
  };
}

describe("FileBackedHistoryStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blacktea-history-"));
    path = join(dir, "history.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when the file does not exist", () => {
    const store = new FileBackedHistoryStore({ path });
    expect(store.size()).toBe(0);
  });

  it("creates the parent directory if missing", () => {
    const nestedPath = join(dir, "nested", "path", "history.jsonl");
    const store = new FileBackedHistoryStore({ path: nestedPath });
    expect(store.size()).toBe(0);
  });

  it("appends a record to disk on record()", async () => {
    const store = new FileBackedHistoryStore({ path });
    await store.record(recordAt(0));
    const content = readFileSync(path, "utf-8");
    expect(content.trim().split("\n")).toHaveLength(1);
    expect(store.size()).toBe(1);
  });

  it("survives restart (reads existing file on construction)", async () => {
    const a = new FileBackedHistoryStore({ path });
    await a.record(recordAt(0, { amount: 10 }));
    await a.record(recordAt(0, { amount: 20 }));
    await a.record(recordAt(0, { amount: 30 }));

    const b = new FileBackedHistoryStore({ path });
    expect(b.size()).toBe(3);
    expect(await b.sumSince({ seconds: 60 })).toBe(60);
  });

  it("skips corrupted lines without crashing", () => {
    const valid = recordAt(0);
    const bad = "{not valid json";
    const content = `${JSON.stringify(valid)}\n${bad}\n${JSON.stringify(valid)}\n`;
    require("node:fs").writeFileSync(path, content, "utf-8");
    const store = new FileBackedHistoryStore({ path });
    expect(store.size()).toBe(2);
  });

  describe("sumSince", () => {
    it("sums amounts inside the window", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(3600, { amount: 30 }));
      await store.record(recordAt(7200, { amount: 50 }));
      expect(await store.sumSince({ seconds: 24 * 3600 })).toBe(80);
    });

    it("excludes amounts older than the window", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(3600, { amount: 30 }));
      await store.record(recordAt(48 * 3600, { amount: 1000 }));
      expect(await store.sumSince({ seconds: 24 * 3600 })).toBe(30);
    });

    it("filters by wallet when filter.wallet is set", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(0, { amount: 10, recipient_wallet: "0xA" }));
      await store.record(recordAt(0, { amount: 20, recipient_wallet: "0xB" }));
      await store.record(recordAt(0, { amount: 30, recipient_wallet: "0xA" }));
      const got = await store.sumSince({ seconds: 60, filter: { wallet: "0xA" } });
      expect(got).toBe(40);
    });

    it("filters by url when filter.url is set", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(0, { amount: 10, recipient_url: "api.openai.com" }));
      await store.record(recordAt(0, { amount: 20, recipient_url: "api.other.com" }));
      const got = await store.sumSince({
        seconds: 60,
        filter: { url: "api.openai.com" },
      });
      expect(got).toBe(10);
    });

    it("returns 0 for an empty store", async () => {
      const store = new FileBackedHistoryStore({ path });
      expect(await store.sumSince({ seconds: 86400 })).toBe(0);
    });
  });

  describe("countSince", () => {
    it("counts events inside the window", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(0));
      await store.record(recordAt(0));
      await store.record(recordAt(48 * 3600));
      expect(await store.countSince({ seconds: 24 * 3600 })).toBe(2);
    });

    it("filters by wallet", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(0, { recipient_wallet: "0xA" }));
      await store.record(recordAt(0, { recipient_wallet: "0xB" }));
      await store.record(recordAt(0, { recipient_wallet: "0xA" }));
      const got = await store.countSince({ seconds: 60, filter: { wallet: "0xA" } });
      expect(got).toBe(2);
    });
  });

  describe("prune", () => {
    it("drops events older than the cutoff and rewrites the file", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(0, { amount: 10 }));
      await store.record(recordAt(48 * 3600, { amount: 1000 }));
      const dropped = await store.prune(24 * 3600);
      expect(dropped).toBe(1);
      expect(store.size()).toBe(1);

      // File on disk also shrinks.
      const reloaded = new FileBackedHistoryStore({ path });
      expect(reloaded.size()).toBe(1);
    });

    it("returns 0 when nothing is old enough", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(0));
      const dropped = await store.prune(24 * 3600);
      expect(dropped).toBe(0);
    });

    it("handles pruning everything (file becomes empty)", async () => {
      const store = new FileBackedHistoryStore({ path });
      await store.record(recordAt(48 * 3600));
      const dropped = await store.prune(24 * 3600);
      expect(dropped).toBe(1);
      expect(store.size()).toBe(0);

      const reloaded = new FileBackedHistoryStore({ path });
      expect(reloaded.size()).toBe(0);
    });
  });
});
