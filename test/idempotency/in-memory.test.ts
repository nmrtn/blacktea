import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "../../src/idempotency/in-memory.js";
import type { Receipt } from "../../src/types.js";

function fakeReceipt(id: string): Receipt {
  return {
    id,
    amount: 50,
    currency: "USDC",
    rail: "x402",
    paid_at: "2026-05-22T14:00:00Z",
  };
}

describe("InMemoryIdempotencyStore", () => {
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
  });

  it("returns null for a missing key", async () => {
    const got = await store.get("never_stored");
    expect(got).toBeNull();
  });

  it("returns the receipt for a stored key", async () => {
    const r = fakeReceipt("intent_1");
    await store.put("key1", r, 3600);
    const got = await store.get("key1");
    expect(got).toEqual(r);
  });

  it("does not return entries after their TTL", async () => {
    // Use short real timeouts. lru-cache reads performance.now() at set time
    // and Vitest fake timers do not move it by default, so real waits are
    // the reliable path here.
    const r = fakeReceipt("intent_2");
    // 50ms TTL so the test stays fast.
    await store.put("key2", r, 0.05);
    expect(await store.get("key2")).toEqual(r);
    await sleep(80);
    expect(await store.get("key2")).toBeNull();
  });

  it("respects per-call TTL override", async () => {
    const short = fakeReceipt("short");
    const long = fakeReceipt("long");
    await store.put("short_key", short, 0.05); // 50ms
    await store.put("long_key", long, 600); // 10 min
    await sleep(80);
    expect(await store.get("short_key")).toBeNull();
    expect(await store.get("long_key")).toEqual(long);
  });

  it("evicts oldest entries past the max_entries bound", async () => {
    const tiny = new InMemoryIdempotencyStore({ max_entries: 3 });
    await tiny.put("a", fakeReceipt("a"), 3600);
    await tiny.put("b", fakeReceipt("b"), 3600);
    await tiny.put("c", fakeReceipt("c"), 3600);
    await tiny.put("d", fakeReceipt("d"), 3600);
    expect(tiny.size()).toBe(3);
    expect(await tiny.get("a")).toBeNull();
    expect(await tiny.get("d")).not.toBeNull();
  });

  it("overwrites a key when put twice with the same key", async () => {
    const first = fakeReceipt("first");
    const second = fakeReceipt("second");
    await store.put("key", first, 3600);
    await store.put("key", second, 3600);
    expect(await store.get("key")).toEqual(second);
  });
});
