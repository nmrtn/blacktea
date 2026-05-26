/**
 * blacktea() factory tests.
 *
 * Uses an in-memory FakeHistoryStore and a configurable FakeRail to keep
 * everything in-process. No file system, no network. The audit sink is
 * collected into an array so tests can assert on the audit log.
 */

import { describe, expect, it, vi } from "vitest";
import { blacktea } from "../src/agent.js";
import { PolicyDeniedError } from "../src/errors.js";
import type { Policy } from "../src/policy/schema.js";
import type {
  AuditEvent,
  HistoryFilter,
  HistoryRecord,
  HistoryStore,
  PaymentIntentInput,
  RailAdapter,
  Receipt,
} from "../src/types.js";

class FakeHistory implements HistoryStore {
  events: HistoryRecord[] = [];
  async record(event: HistoryRecord): Promise<void> {
    this.events.push(event);
  }
  async sumSince(opts: { seconds: number; filter?: HistoryFilter }): Promise<number> {
    return this.events.filter((e) => match(e, opts.filter)).reduce((acc, e) => acc + e.amount, 0);
  }
  async countSince(opts: { seconds: number; filter?: HistoryFilter }): Promise<number> {
    return this.events.filter((e) => match(e, opts.filter)).length;
  }
  async prune(): Promise<number> {
    const len = this.events.length;
    this.events = [];
    return len;
  }
}

function match(e: HistoryRecord, filter: HistoryFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.wallet && e.recipient_wallet !== filter.wallet) return false;
  if (filter.url && e.recipient_url !== filter.url) return false;
  return true;
}

function fakeRail(
  name = "x402",
  behavior: Partial<RailAdapter> = {},
): RailAdapter & {
  payCalls: PaymentIntentInput[];
} {
  const calls: PaymentIntentInput[] = [];
  const rail: RailAdapter & { payCalls: PaymentIntentInput[] } = {
    name,
    supports: behavior.supports ?? (() => true),
    estimate: behavior.estimate ?? (() => ({ fee: 0, eta_seconds: 2 })),
    pay:
      behavior.pay ??
      (async (input): Promise<Receipt> => {
        calls.push(input);
        return {
          id: "rail_receipt_id",
          amount: input.amount,
          currency: input.currency ?? "USDC",
          rail: name,
          rail_charge_id: "ch_test_123",
          recipient_url: input.url,
          recipient_wallet: input.recipient_wallet,
          paid_at: new Date().toISOString(),
        };
      }),
    payCalls: calls,
  };
  return rail;
}

const baseInput: PaymentIntentInput = {
  amount: 4,
  currency: "USDC",
  url: "https://api.openai.com/v1/chat",
  intent: "buy GPT-4 tokens",
  recipient_wallet: "0xabc123",
};

function silentAudit(): AuditEvent[] {
  return [];
}

function collectingAudit(): { sink: (e: AuditEvent) => void; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { sink: (e) => events.push(e), events };
}

describe("blacktea()", () => {
  describe("happy path (allow rule)", () => {
    it("calls the rail and returns a completed intent with a receipt", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
        default: { approval: "callback" },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const intent = await pay(baseInput);

      expect(intent.status).toBe("completed");
      expect(intent.receipt?.rail).toBe("x402");
      expect(rail.payCalls).toHaveLength(1);
    });

    it("records the payment to history on success", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
        default: { approval: "callback" },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await pay(baseInput);

      expect(history.events).toHaveLength(1);
      expect(history.events[0]?.amount).toBe(4);
      expect(history.events[0]?.recipient_url).toBe(baseInput.url);
      expect(history.events[0]?.rule_fired).toBe("rule[0]");
    });

    it("writes audit events through the full lifecycle", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
        default: { approval: "callback" },
      };
      const audit = collectingAudit();
      const pay = blacktea({ source: rail, policy, history, audit: audit.sink });

      await pay(baseInput);

      const eventNames = audit.events.map((e) => e.event);
      expect(eventNames).toEqual([
        "intent_created",
        "rail_chosen",
        "policy_evaluated",
        "rail_called",
        "payment_completed",
      ]);
    });
  });

  describe("reject rule", () => {
    it("throws PolicyDeniedError and does not call the rail", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { reject: "blocked" } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await expect(pay(baseInput)).rejects.toThrow(PolicyDeniedError);
      expect(rail.payCalls).toHaveLength(0);
      expect(history.events).toHaveLength(0);
    });

    it("PolicyDeniedError carries the reject reason and rule_fired", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { reject: "blocked_test" } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      try {
        await pay(baseInput);
        expect.fail("should have thrown");
      } catch (err) {
        if (!(err instanceof PolicyDeniedError)) throw err;
        expect(err.reason).toBe("blocked_test");
        expect(err.rule_fired).toBe("rule[0]");
      }
    });
  });

  describe("approval flow (callback channel)", () => {
    const policy: Policy = {
      rules: [{ if: { amount_gte: 1 }, then: { approval: "callback" } }],
      default: { approve: true },
    };

    it("calls onApprovalNeeded and proceeds on approve", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const onApprovalNeeded = vi.fn(async () => ({ decision: "approve" as const }));
      const pay = blacktea({
        source: rail,
        policy,
        history,
        onApprovalNeeded,
        audit: () => {},
      });

      const intent = await pay(baseInput);

      expect(onApprovalNeeded).toHaveBeenCalledOnce();
      expect(intent.status).toBe("completed");
      expect(rail.payCalls).toHaveLength(1);
    });

    it("throws PolicyDeniedError when onApprovalNeeded returns deny", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const onApprovalNeeded = vi.fn(async () => ({
        decision: "deny" as const,
        reason: "human_said_no",
      }));
      const pay = blacktea({
        source: rail,
        policy,
        history,
        onApprovalNeeded,
        audit: () => {},
      });

      await expect(pay(baseInput)).rejects.toThrow(PolicyDeniedError);
      expect(rail.payCalls).toHaveLength(0);
    });

    it("throws ValidationError if callback channel fires but no onApprovalNeeded is configured", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await expect(pay(baseInput)).rejects.toThrow(/onApprovalNeeded/);
    });

    it("times out when onApprovalNeeded never resolves", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policyShort: Policy = {
        rules: [
          {
            if: { amount_gte: 1 },
            then: { approval: { via: "callback", timeout_seconds: 0.05 } },
          },
        ],
        default: { approve: true },
      };
      const onApprovalNeeded = vi.fn(
        () => new Promise<never>(() => {}), // never resolves
      );
      const pay = blacktea({
        source: rail,
        policy: policyShort,
        history,
        onApprovalNeeded,
        audit: () => {},
      });

      await expect(pay(baseInput)).rejects.toThrow(/Approval timed out/);
      expect(rail.payCalls).toHaveLength(0);
    });
  });

  describe("idempotency", () => {
    it("returns the cached receipt on a second call with the same key", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const a = await pay(baseInput, { idempotency_key: "k1" });
      const b = await pay(baseInput, { idempotency_key: "k1" });

      expect(a.receipt?.id).toBe(b.receipt?.id);
      expect(rail.payCalls).toHaveLength(1); // rail only called once
    });

    it("each call gets a fresh receipt when no idempotency key is provided", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await pay(baseInput);
      await pay(baseInput);
      expect(rail.payCalls).toHaveLength(2);
    });
  });

  describe("dry-run mode", () => {
    const policy: Policy = {
      rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
      default: { approve: true },
    };

    it("never calls the rail", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const pay = blacktea({
        source: rail,
        policy,
        history,
        audit: () => {},
        dry_run: true,
      });
      await pay(baseInput);
      expect(rail.payCalls).toHaveLength(0);
    });

    it("returns a receipt with simulated: true", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const pay = blacktea({
        source: rail,
        policy,
        history,
        audit: () => {},
        dry_run: true,
      });
      const intent = await pay(baseInput);
      expect(intent.receipt?.simulated).toBe(true);
      expect(intent.receipt?.rail_charge_id).toMatch(/^dryrun_/);
    });

    it("emits a payment_simulated audit event instead of rail_called", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const audit = collectingAudit();
      const pay = blacktea({
        source: rail,
        policy,
        history,
        audit: audit.sink,
        dry_run: true,
      });
      await pay(baseInput);
      const events = audit.events.map((e) => e.event);
      expect(events).toContain("payment_simulated");
      expect(events).not.toContain("rail_called");
    });

    it("dry-run still throws PolicyDeniedError for reject rules", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const denyPolicy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { reject: "test_deny" } }],
        default: { approve: true },
      };
      const pay = blacktea({
        source: rail,
        policy: denyPolicy,
        history,
        audit: () => {},
        dry_run: true,
      });
      await expect(pay(baseInput)).rejects.toThrow(PolicyDeniedError);
    });
  });

  describe("rail selection", () => {
    const policy: Policy = {
      rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
      default: { approve: true },
    };

    it("picks the only rail when there is one source", async () => {
      const rail = fakeRail("only");
      const history = new FakeHistory();
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });
      const intent = await pay(baseInput);
      expect(intent.receipt?.rail).toBe("only");
    });

    it("picks the first supporting rail when multiple are given", async () => {
      const wrongRail = fakeRail("wrong", { supports: () => false });
      const rightRail = fakeRail("right");
      const history = new FakeHistory();
      const pay = blacktea({
        source: [wrongRail, rightRail],
        policy,
        history,
        audit: () => {},
      });
      const intent = await pay(baseInput);
      expect(intent.receipt?.rail).toBe("right");
    });

    it("honours opts.rail override", async () => {
      const a = fakeRail("a");
      const b = fakeRail("b");
      const history = new FakeHistory();
      const pay = blacktea({ source: [a, b], policy, history, audit: () => {} });
      const intent = await pay(baseInput, { rail: "b" });
      expect(intent.receipt?.rail).toBe("b");
      expect(a.payCalls).toHaveLength(0);
      expect(b.payCalls).toHaveLength(1);
    });

    it("throws NoEligibleRailError when no rail supports the input", async () => {
      const rail = fakeRail("none", { supports: () => false });
      const history = new FakeHistory();
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });
      await expect(pay(baseInput)).rejects.toThrow(/No rail accepts/);
    });
  });

  describe("input validation", () => {
    const rail = fakeRail();
    const history = new FakeHistory();
    const policy: Policy = {
      rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
      default: { approve: true },
    };

    function makePay() {
      return blacktea({ source: rail, policy, history, audit: () => {} });
    }

    it("throws ValidationError on negative amount", async () => {
      await expect(makePay()({ ...baseInput, amount: -1 })).rejects.toThrow(/amount/);
    });

    it("throws ValidationError on zero amount", async () => {
      await expect(makePay()({ ...baseInput, amount: 0 })).rejects.toThrow(/amount/);
    });

    it("throws ValidationError on NaN amount", async () => {
      await expect(makePay()({ ...baseInput, amount: Number.NaN })).rejects.toThrow(/amount/);
    });

    it("throws ValidationError on empty url", async () => {
      await expect(makePay()({ ...baseInput, url: "" })).rejects.toThrow(/url/);
    });
  });

  describe("constructor validation", () => {
    it("throws when source is an empty array", () => {
      const history = new FakeHistory();
      const policy: Policy = { rules: [], default: { approve: true } };
      expect(() => blacktea({ source: [], policy, history })).toThrow(/source rail/);
    });
  });

  it("silentAudit is unused-safe", () => {
    expect(silentAudit()).toEqual([]);
  });
});
