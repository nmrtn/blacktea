/**
 * Default IdempotencyStore: in-memory LRU with per-entry TTL, backed by lru-cache.
 *
 * Fine for short-lived agents and dev. Cross-process restart safety requires
 * a persistent store (Redis, SQLite, file) which can be implemented behind
 * the same IdempotencyStore interface and passed to blacktea() as `store`.
 */

import { LRUCache } from "lru-cache";
import type { IdempotencyStore, Receipt } from "../types.js";

export interface InMemoryIdempotencyOptions {
  /** Max number of entries before LRU eviction kicks in. Defaults to 10_000. */
  max_entries?: number;
  /** Default TTL applied if put() is called without a ttl_seconds override. Defaults to 86_400 (24h). */
  default_ttl_seconds?: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private cache: LRUCache<string, Receipt>;
  private readonly default_ttl_ms: number;

  constructor(opts: InMemoryIdempotencyOptions = {}) {
    const max = opts.max_entries ?? 10_000;
    this.default_ttl_ms = (opts.default_ttl_seconds ?? 86_400) * 1000;
    this.cache = new LRUCache<string, Receipt>({
      max,
      ttl: this.default_ttl_ms,
      updateAgeOnGet: false,
      updateAgeOnHas: false,
    });
  }

  async get(key: string): Promise<Receipt | null> {
    const hit = this.cache.get(key);
    return hit ?? null;
  }

  async put(key: string, receipt: Receipt, ttl_seconds: number): Promise<void> {
    this.cache.set(key, receipt, { ttl: ttl_seconds * 1000 });
  }

  /** Test helper. Not part of the IdempotencyStore interface. */
  size(): number {
    return this.cache.size;
  }
}
