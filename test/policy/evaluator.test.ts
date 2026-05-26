/**
 * Policy evaluator tests.
 *
 * Covers every operator, every combinator, and the rule ordering contract
 * (first match wins; default fires when nothing matches). Stateful tests
 * use an in-memory FakeHistory that records and returns sums on demand.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/policy/evaluator.js";
import type { Policy } from "../../src/policy/schema.js";
import type { HistoryQuery, PaymentIntentInput } from "../../src/types.js";

class FakeHistory implements HistoryQuery {
  private events: Array<{
    amount: number;
    wallet?: string;
    url?: string;
    secondsAgo: number;
  }> = [];

  record(event: { amount: number; wallet?: string; url?: string; secondsAgo: number }) {
    this.events.push(event);
  }

  reset() {
    this.events = [];
  }

  async sumSince(opts: {
    seconds: number;
    filter?: { wallet?: string; url?: string };
  }): Promise<number> {
    return this.events
      .filter((e) => e.secondsAgo <= opts.seconds)
      .filter((e) => {
        if (opts.filter?.wallet && e.wallet !== opts.filter.wallet) return false;
        if (opts.filter?.url && e.url !== opts.filter.url) return false;
        return true;
      })
      .reduce((acc, e) => acc + e.amount, 0);
  }

  async countSince(opts: {
    seconds: number;
    filter?: { wallet?: string; url?: string };
  }): Promise<number> {
    return this.events
      .filter((e) => e.secondsAgo <= opts.seconds)
      .filter((e) => {
        if (opts.filter?.wallet && e.wallet !== opts.filter.wallet) return false;
        if (opts.filter?.url && e.url !== opts.filter.url) return false;
        return true;
      }).length;
  }
}

const baseInput: PaymentIntentInput = {
  amount: 50,
  currency: "USDC",
  url: "https://api.openai.com/v1/chat",
  intent: "buy GPT-4 tokens",
  recipient_wallet: "0xabc123",
};

const allowAllDefault: Policy = {
  rules: [],
  default: { approve: true },
};

const denyAllDefault: Policy = {
  rules: [],
  default: { reject: "default_deny" },
};

describe("evaluatePolicy", () => {
  let history: FakeHistory;
  beforeEach(() => {
    history = new FakeHistory();
  });

  describe("default action when no rules match", () => {
    it("returns allow when default is approve", async () => {
      const decision = await evaluatePolicy(baseInput, allowAllDefault, history);
      expect(decision).toEqual({ kind: "allow", rule_fired: "default" });
    });

    it("returns reject when default is reject", async () => {
      const decision = await evaluatePolicy(baseInput, denyAllDefault, history);
      expect(decision).toEqual({ kind: "reject", reason: "default_deny", rule_fired: "default" });
    });

    it("returns approval (with default timeout) when default is approval string", async () => {
      const policy: Policy = { rules: [], default: { approval: "callback" } };
      const decision = await evaluatePolicy(baseInput, policy, history);
      expect(decision).toEqual({
        kind: "approval",
        channel: "callback",
        timeout_seconds: 600,
        rule_fired: "default",
      });
    });

    it("returns approval with custom timeout when default is structured approval", async () => {
      const policy: Policy = {
        rules: [],
        default: { approval: { via: "console", timeout_seconds: 120 } },
      };
      const decision = await evaluatePolicy(baseInput, policy, history);
      expect(decision).toEqual({
        kind: "approval",
        channel: "console",
        timeout_seconds: 120,
        rule_fired: "default",
      });
    });
  });

  describe("amount operators", () => {
    it("amount_lt matches", async () => {
      const policy: Policy = {
        rules: [{ if: { amount_lt: 100 }, then: { approve: true } }],
        default: { reject: "default" },
      };
      const d = await evaluatePolicy({ ...baseInput, amount: 50 }, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("amount_lt does not match at boundary", async () => {
      const policy: Policy = {
        rules: [{ if: { amount_lt: 100 }, then: { approve: true } }],
        default: { reject: "default" },
      };
      const d = await evaluatePolicy({ ...baseInput, amount: 100 }, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("amount_gte matches at boundary", async () => {
      const policy: Policy = {
        rules: [{ if: { amount_gte: 100 }, then: { approval: "callback" } }],
        default: { approve: true },
      };
      const d = await evaluatePolicy({ ...baseInput, amount: 100 }, policy, history);
      expect(d.kind).toBe("approval");
    });

    it("amount_gt does not match at boundary", async () => {
      const policy: Policy = {
        rules: [{ if: { amount_gt: 100 }, then: { reject: "over" } }],
        default: { approve: true },
      };
      const d = await evaluatePolicy({ ...baseInput, amount: 100 }, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("amount_lte matches at boundary", async () => {
      const policy: Policy = {
        rules: [{ if: { amount_lte: 100 }, then: { approve: true } }],
        default: { reject: "default" },
      };
      const d = await evaluatePolicy({ ...baseInput, amount: 100 }, policy, history);
      expect(d.kind).toBe("allow");
    });
  });

  describe("wallet_in", () => {
    it("matches when recipient is in the array", async () => {
      const policy: Policy = {
        rules: [{ if: { wallet_in: ["0xabc123", "0xdef456"] }, then: { reject: "blocked" } }],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d).toEqual({ kind: "reject", reason: "blocked", rule_fired: "rule[0]" });
    });

    it("does not match when recipient is not in the array", async () => {
      const policy: Policy = {
        rules: [{ if: { wallet_in: ["0xdef456"] }, then: { reject: "blocked" } }],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("does not match when input has no recipient_wallet", async () => {
      const policy: Policy = {
        rules: [{ if: { wallet_in: ["0xabc123"] }, then: { reject: "blocked" } }],
        default: { approve: true },
      };
      const inputNoWallet = { ...baseInput };
      inputNoWallet.recipient_wallet = undefined;
      const d = await evaluatePolicy(inputNoWallet, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("throws a clear error when given a file path (unresolved)", async () => {
      const policy: Policy = {
        rules: [{ if: { wallet_in: "./blocklist.txt" }, then: { reject: "blocked" } }],
        default: { approve: true },
      };
      await expect(evaluatePolicy(baseInput, policy, history)).rejects.toThrow(/file path/);
    });
  });

  describe("url_starts_with", () => {
    it("matches the prefix", async () => {
      const policy: Policy = {
        rules: [
          {
            if: { url_starts_with: "https://api.openai.com" },
            then: { approve: true },
          },
        ],
        default: { reject: "default" },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("does not match when prefix does not match", async () => {
      const policy: Policy = {
        rules: [
          {
            if: { url_starts_with: "https://api.anthropic.com" },
            then: { approve: true },
          },
        ],
        default: { reject: "default" },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });
  });

  describe("intent operators", () => {
    it("intent_contains_any matches case-insensitively", async () => {
      const policy: Policy = {
        rules: [
          {
            if: { intent_contains_any: ["TOKENS", "missing-word"] },
            then: { approval: "callback" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("approval");
    });

    it("intent_contains_all requires all words", async () => {
      const policy: Policy = {
        rules: [
          {
            if: { intent_contains_all: ["buy", "tokens"] },
            then: { reject: "matched" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("intent_contains_all fails when one word is missing", async () => {
      const policy: Policy = {
        rules: [
          {
            if: { intent_contains_all: ["buy", "missing"] },
            then: { reject: "matched" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("intent_eq matches case-sensitively", async () => {
      const policy: Policy = {
        rules: [{ if: { intent_eq: "buy GPT-4 tokens" }, then: { approve: true } }],
        default: { reject: "default" },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });
  });

  describe("time_of_day_between", () => {
    const policy: Policy = {
      time_zone: "Europe/Paris",
      rules: [
        {
          if: { time_of_day_between: ["22:00", "08:00"] },
          then: { approval: "callback" },
        },
      ],
      default: { approve: true },
    };

    it("matches inside the window that wraps midnight (23:30 Paris)", async () => {
      // 2026-05-22 21:30 UTC = 23:30 Paris (UTC+2 in May).
      const now = () => new Date("2026-05-22T21:30:00Z");
      const d = await evaluatePolicy(baseInput, policy, history, { now });
      expect(d.kind).toBe("approval");
    });

    it("matches just after midnight (02:00 Paris)", async () => {
      // 2026-05-23 00:00 UTC = 02:00 Paris.
      const now = () => new Date("2026-05-23T00:00:00Z");
      const d = await evaluatePolicy(baseInput, policy, history, { now });
      expect(d.kind).toBe("approval");
    });

    it("does not match in the middle of the day (14:00 Paris)", async () => {
      // 2026-05-22 12:00 UTC = 14:00 Paris.
      const now = () => new Date("2026-05-22T12:00:00Z");
      const d = await evaluatePolicy(baseInput, policy, history, { now });
      expect(d.kind).toBe("allow");
    });

    it("does not match at window boundary end (08:00 Paris)", async () => {
      // 2026-05-22 06:00 UTC = 08:00 Paris. End boundary is exclusive.
      const now = () => new Date("2026-05-22T06:00:00Z");
      const d = await evaluatePolicy(baseInput, policy, history, { now });
      expect(d.kind).toBe("allow");
    });

    it("non-wrapping window (09:00 to 17:00) works", async () => {
      const workHoursPolicy: Policy = {
        time_zone: "Europe/Paris",
        rules: [
          {
            if: { time_of_day_between: ["09:00", "17:00"] },
            then: { approve: true },
          },
        ],
        default: { reject: "off_hours" },
      };
      // 10:00 Paris (in window)
      let d = await evaluatePolicy(baseInput, workHoursPolicy, history, {
        now: () => new Date("2026-05-22T08:00:00Z"),
      });
      expect(d.kind).toBe("allow");
      // 18:00 Paris (outside window)
      d = await evaluatePolicy(baseInput, workHoursPolicy, history, {
        now: () => new Date("2026-05-22T16:00:00Z"),
      });
      expect(d.kind).toBe("reject");
    });

    it("uses UTC when time_zone is omitted", async () => {
      const policyUtc: Policy = {
        rules: [{ if: { time_of_day_between: ["10:00", "11:00"] }, then: { reject: "matched" } }],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policyUtc, history, {
        now: () => new Date("2026-05-22T10:30:00Z"),
      });
      expect(d.kind).toBe("reject");
    });
  });

  describe("would_spend (stateful)", () => {
    it("matches when past + current >= threshold", async () => {
      history.record({ amount: 99, wallet: "0xabc123", secondsAgo: 3600 });
      const policy: Policy = {
        rules: [
          {
            if: {
              would_spend: { window_hours: 24, gte: 100, by: "wallet" },
            },
            then: { reject: "per_wallet_cap" },
          },
        ],
        default: { approve: true },
      };
      // current input is 50, past is 99, sum is 149 >= 100 -> reject
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("does not match when sum is under threshold", async () => {
      history.record({ amount: 30, wallet: "0xabc123", secondsAgo: 3600 });
      const policy: Policy = {
        rules: [
          {
            if: {
              would_spend: { window_hours: 24, gte: 100, by: "wallet" },
            },
            then: { reject: "per_wallet_cap" },
          },
        ],
        default: { approve: true },
      };
      // 50 + 30 = 80 < 100 -> allow
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("filters by wallet when by: wallet (different wallet does not count)", async () => {
      // Past payment to a DIFFERENT wallet should not affect this wallet's cap
      history.record({ amount: 200, wallet: "0xother", secondsAgo: 3600 });
      const policy: Policy = {
        rules: [
          {
            if: {
              would_spend: { window_hours: 24, gte: 100, by: "wallet" },
            },
            then: { reject: "per_wallet_cap" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("filters by url host when by: url", async () => {
      history.record({ amount: 99, url: "api.openai.com", secondsAgo: 3600 });
      const policy: Policy = {
        rules: [
          {
            if: {
              would_spend: { window_hours: 24, gte: 100, by: "url" },
            },
            then: { reject: "per_url_cap" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("counts all when by is omitted (default behaviour)", async () => {
      history.record({ amount: 80, wallet: "0xother", secondsAgo: 3600 });
      history.record({ amount: 40, wallet: "0xanother", secondsAgo: 7200 });
      const policy: Policy = {
        rules: [
          {
            if: { would_spend: { window_hours: 24, gte: 150 } },
            then: { reject: "daily_cap" },
          },
        ],
        default: { approve: true },
      };
      // 80 + 40 + 50 = 170 >= 150
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("respects the window_hours boundary (older events excluded)", async () => {
      // 99 spent 25h ago, outside the 24h window
      history.record({ amount: 99, wallet: "0xabc123", secondsAgo: 25 * 3600 });
      const policy: Policy = {
        rules: [
          {
            if: { would_spend: { window_hours: 24, gte: 100, by: "wallet" } },
            then: { reject: "per_wallet_cap" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });
  });

  describe("amount_today_gte (shorthand)", () => {
    it("desugars to would_spend with 24h window and no scope", async () => {
      history.record({ amount: 460, secondsAgo: 3600 });
      const policy: Policy = {
        rules: [{ if: { amount_today_gte: 500 }, then: { reject: "daily_cap" } }],
        default: { approve: true },
      };
      // 460 + 50 = 510 >= 500
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("does not match when sum is under", async () => {
      history.record({ amount: 100, secondsAgo: 3600 });
      const policy: Policy = {
        rules: [{ if: { amount_today_gte: 500 }, then: { reject: "daily_cap" } }],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });
  });

  describe("combinators", () => {
    it("all matches only when every sub-condition matches", async () => {
      const policy: Policy = {
        rules: [
          {
            if: {
              all: [{ amount_gte: 20 }, { url_starts_with: "https://api.openai.com" }],
            },
            then: { reject: "matched" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("all fails if one sub-condition fails", async () => {
      const policy: Policy = {
        rules: [
          {
            if: {
              all: [{ amount_gte: 20 }, { url_starts_with: "https://nowhere.example" }],
            },
            then: { reject: "matched" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("any matches when at least one sub-condition matches", async () => {
      const policy: Policy = {
        rules: [
          {
            if: {
              any: [{ amount_gte: 9999 }, { url_starts_with: "https://api.openai.com" }],
            },
            then: { reject: "matched" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("any fails when no sub-condition matches", async () => {
      const policy: Policy = {
        rules: [
          {
            if: {
              any: [{ amount_gte: 9999 }, { url_starts_with: "https://nowhere" }],
            },
            then: { reject: "matched" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("allow");
    });

    it("not inverts the inner condition", async () => {
      const policy: Policy = {
        rules: [
          {
            if: { not: { amount_lt: 10 } },
            then: { reject: "not_small" },
          },
        ],
        default: { approve: true },
      };
      // amount is 50, NOT (amount_lt 10) = true -> reject
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });

    it("nested combinators work", async () => {
      const policy: Policy = {
        rules: [
          {
            if: {
              all: [
                { amount_gte: 20 },
                {
                  any: [
                    { wallet_in: ["0xnomatch"] },
                    { url_starts_with: "https://api.openai.com" },
                  ],
                },
                { not: { intent_eq: "test" } },
              ],
            },
            then: { reject: "complex" },
          },
        ],
        default: { approve: true },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d.kind).toBe("reject");
    });
  });

  describe("rule ordering (first match wins)", () => {
    it("returns the first matching rule, not later ones", async () => {
      const policy: Policy = {
        rules: [
          { if: { amount_lt: 100 }, then: { approve: true } },
          { if: { amount_lt: 100 }, then: { reject: "never_reached" } },
        ],
        default: { reject: "default" },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d).toEqual({ kind: "allow", rule_fired: "rule[0]" });
    });

    it("rejects first when hard caps go on top", async () => {
      const policy: Policy = {
        rules: [
          { if: { amount_gte: 10000 }, then: { reject: "absolute_cap" } },
          { if: { wallet_in: ["0xabc123"] }, then: { approve: true } },
        ],
        default: { reject: "default" },
      };
      const big = { ...baseInput, amount: 50000 };
      const d = await evaluatePolicy(big, policy, history);
      expect(d).toEqual({ kind: "reject", reason: "absolute_cap", rule_fired: "rule[0]" });
    });

    it("allowlist short-circuit reaches before later rules", async () => {
      const policy: Policy = {
        rules: [
          { if: { wallet_in: ["0xabc123"] }, then: { approve: true } },
          { if: { amount_gte: 10 }, then: { approval: "callback" } },
        ],
        default: { reject: "default" },
      };
      const d = await evaluatePolicy(baseInput, policy, history);
      expect(d).toEqual({ kind: "allow", rule_fired: "rule[0]" });
    });
  });
});
