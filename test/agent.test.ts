/**
 * blacktea() factory tests.
 *
 * Uses an in-memory FakeHistoryStore and a configurable FakeRail (now with
 * preflight + settle) to keep everything in-process. No file system, no
 * network. The audit sink is collected into an array so tests can assert
 * on the audit log.
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
  PayInput,
  PayOptions,
  PaymentRequirement,
  RailAdapter,
  Receipt,
  SettleResult,
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

/**
 * A configurable rail used only in tests. Default behaviour:
 *   - supports() returns true
 *   - preflight() returns a fixed PaymentRequirement (amount 4, wallet 0xabc)
 *   - settle() returns a fake receipt and a "fake data" body
 *
 * Override any of those by passing a partial behavior object. Tracks
 * settle() calls for assertion.
 */
function fakeRail(
  name = "x402",
  behavior: {
    supports?: (input: PayInput) => boolean;
    preflight?: (input: PayInput) => Promise<PaymentRequirement>;
    settle?: (input: PayInput, req: PaymentRequirement, opts: PayOptions) => Promise<SettleResult>;
  } = {},
): RailAdapter & {
  settleCalls: Array<{ input: PayInput; req: PaymentRequirement }>;
  preflightCalls: PayInput[];
} {
  const settleCalls: Array<{ input: PayInput; req: PaymentRequirement }> = [];
  const preflightCalls: PayInput[] = [];

  const defaultPreflight = async (input: PayInput): Promise<PaymentRequirement> => {
    preflightCalls.push(input);
    return {
      amount: 4,
      currency: "USDC",
      recipient_wallet: "0xabc123",
      network: "base-sepolia",
    };
  };

  const defaultSettle = async (input: PayInput, req: PaymentRequirement): Promise<SettleResult> => {
    settleCalls.push({ input, req });
    const receipt: Receipt = {
      id: "rail_receipt_id",
      amount: req.amount,
      currency: req.currency,
      rail: name,
      rail_charge_id: "ch_test_123",
      recipient_url: input.url,
      recipient_wallet: req.recipient_wallet,
      paid_at: new Date().toISOString(),
    };
    return { receipt, data: { fake: "api response" } };
  };

  const rail: RailAdapter & {
    settleCalls: typeof settleCalls;
    preflightCalls: typeof preflightCalls;
  } = {
    name,
    supports: behavior.supports ?? (() => true),
    preflight: behavior.preflight
      ? async (input) => {
          preflightCalls.push(input);
          return behavior.preflight ? behavior.preflight(input) : defaultPreflight(input);
        }
      : defaultPreflight,
    settle: behavior.settle
      ? async (input, req, opts) => {
          settleCalls.push({ input, req });
          return behavior.settle ? behavior.settle(input, req, opts) : defaultSettle(input, req);
        }
      : defaultSettle,
    settleCalls,
    preflightCalls,
  };
  return rail;
}

const baseInput: PayInput = {
  url: "https://api.openai.com/v1/chat",
  intent: "buy GPT-4 tokens",
};

function collectingAudit(): { sink: (e: AuditEvent) => void; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { sink: (e) => events.push(e), events };
}

describe("blacktea()", () => {
  describe("happy path (allow rule)", () => {
    it("calls preflight then settle and returns a completed intent with receipt and data", async () => {
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
      expect(intent.receipt?.amount).toBe(4);
      expect(intent.data).toEqual({ fake: "api response" });
      expect(rail.preflightCalls).toHaveLength(1);
      expect(rail.settleCalls).toHaveLength(1);
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
        "preflight_received",
        "policy_evaluated",
        "rail_called",
        "payment_completed",
      ]);
    });
  });

  describe("max_amount safety cap", () => {
    it("throws PolicyDeniedError when the server asks for more than max_amount", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await expect(pay({ ...baseInput, max_amount: 1 })).rejects.toThrow(/max_amount_exceeded/);
      expect(rail.settleCalls).toHaveLength(0);
    });

    it("allows when server amount is within max_amount", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const intent = await pay({ ...baseInput, max_amount: 100 });
      expect(intent.status).toBe("completed");
      expect(rail.settleCalls).toHaveLength(1);
    });

    it("evaluates policy AFTER max_amount check (cap fires first)", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
        default: { approve: true },
      };
      const audit = collectingAudit();
      const pay = blacktea({ source: rail, policy, history, audit: audit.sink });

      await expect(pay({ ...baseInput, max_amount: 1 })).rejects.toThrow(PolicyDeniedError);
      const events = audit.events.map((e) => e.event);
      expect(events).not.toContain("policy_evaluated");
    });
  });

  describe("reject rule", () => {
    it("throws PolicyDeniedError and does not call settle", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { reject: "blocked" } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await expect(pay(baseInput)).rejects.toThrow(PolicyDeniedError);
      expect(rail.settleCalls).toHaveLength(0);
      expect(history.events).toHaveLength(0);
    });

    it("calls preflight before the policy can fire", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { reject: "blocked" } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await expect(pay(baseInput)).rejects.toThrow(PolicyDeniedError);
      expect(rail.preflightCalls).toHaveLength(1);
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
      expect(rail.settleCalls).toHaveLength(1);
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
      expect(rail.settleCalls).toHaveLength(0);
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
      const onApprovalNeeded = vi.fn(() => new Promise<never>(() => {}));
      const pay = blacktea({
        source: rail,
        policy: policyShort,
        history,
        onApprovalNeeded,
        audit: () => {},
      });

      await expect(pay(baseInput)).rejects.toThrow(/Approval timed out/);
      expect(rail.settleCalls).toHaveLength(0);
    });

    it("passes the amount and recipient from preflight to the approval request", async () => {
      const rail = fakeRail("x402", {
        preflight: async () => ({
          amount: 1200,
          currency: "USDC",
          recipient_wallet: "0xLUFTHANSA",
        }),
      });
      const history = new FakeHistory();
      let captured: { amount?: number; recipient_wallet?: string } = {};
      const onApprovalNeeded = vi.fn(async (req) => {
        captured = { amount: req.amount, recipient_wallet: req.recipient_wallet };
        return { decision: "approve" as const };
      });
      const pay = blacktea({
        source: rail,
        policy,
        history,
        onApprovalNeeded,
        audit: () => {},
      });

      await pay(baseInput);

      expect(captured.amount).toBe(1200);
      expect(captured.recipient_wallet).toBe("0xLUFTHANSA");
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
      expect(rail.settleCalls).toHaveLength(1);
      expect(rail.preflightCalls).toHaveLength(1); // preflight also skipped on cache hit
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
      expect(rail.settleCalls).toHaveLength(2);
    });
  });

  describe("dry-run mode", () => {
    const policy: Policy = {
      rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
      default: { approve: true },
    };

    it("never calls settle", async () => {
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
      expect(rail.settleCalls).toHaveLength(0);
    });

    it("still calls preflight so policy has a real amount to evaluate", async () => {
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
      expect(rail.preflightCalls).toHaveLength(1);
    });

    it("returns a receipt with simulated: true and data: undefined", async () => {
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
      expect(intent.data).toBeUndefined();
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
      expect(a.settleCalls).toHaveLength(0);
      expect(b.settleCalls).toHaveLength(1);
    });

    it("throws NoEligibleRailError when no rail supports the input", async () => {
      const rail = fakeRail("none", { supports: () => false });
      const history = new FakeHistory();
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });
      await expect(pay(baseInput)).rejects.toThrow(/No rail accepts/);
    });
  });

  describe("input validation", () => {
    const history = new FakeHistory();
    const policy: Policy = {
      rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
      default: { approve: true },
    };

    function makePay() {
      const rail = fakeRail();
      return blacktea({ source: rail, policy, history, audit: () => {} });
    }

    it("throws ValidationError on empty url", async () => {
      await expect(makePay()({ url: "", intent: "x" })).rejects.toThrow(/url/);
    });

    it("throws ValidationError on missing intent type", async () => {
      const bad = { url: "https://x.com" } as unknown as PayInput;
      await expect(makePay()(bad)).rejects.toThrow(/intent/);
    });

    it("throws ValidationError on negative max_amount", async () => {
      await expect(makePay()({ ...baseInput, max_amount: -5 })).rejects.toThrow(/max_amount/);
    });

    it("throws ValidationError on zero max_amount", async () => {
      await expect(makePay()({ ...baseInput, max_amount: 0 })).rejects.toThrow(/max_amount/);
    });
  });

  describe("constructor validation", () => {
    it("throws when source is an empty array", () => {
      const history = new FakeHistory();
      const policy: Policy = { rules: [], default: { approve: true } };
      expect(() => blacktea({ source: [], policy, history })).toThrow(/source rail/);
    });
  });

  describe("rail failures", () => {
    it("RailUnavailableError when preflight throws", async () => {
      const rail = fakeRail("flaky", {
        preflight: async () => {
          throw new Error("network timeout");
        },
      });
      const history = new FakeHistory();
      const policy: Policy = { rules: [], default: { approve: true } };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await expect(pay(baseInput)).rejects.toThrow(/network timeout/);
    });

    it("RailUnavailableError when settle throws", async () => {
      const rail = fakeRail("flaky", {
        settle: async () => {
          throw new Error("signature rejected");
        },
      });
      const history = new FakeHistory();
      const policy: Policy = { rules: [], default: { approve: true } };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      await expect(pay(baseInput)).rejects.toThrow(/signature rejected/);
    });
  });
});

describe("two-phase API (pay.stage / pay.complete)", () => {
  it("exposes stage and complete as functions on the returned pay", () => {
    const rail = fakeRail();
    const policy: Policy = { rules: [], default: { approve: true } };
    const pay = blacktea({ source: rail, policy, history: new FakeHistory(), audit: () => {} });
    expect(typeof pay).toBe("function");
    expect(typeof pay.stage).toBe("function");
    expect(typeof pay.complete).toBe("function");
  });

  describe("stage()", () => {
    it("settles immediately and returns completed when policy auto-approves", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_lt: 10 }, then: { approve: true } }],
        default: { approval: "callback" },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const result = await pay.stage(baseInput);

      expect(result.outcome).toBe("completed");
      if (result.outcome !== "completed") throw new Error("expected completed");
      expect(result.intent.status).toBe("completed");
      expect(result.intent.receipt?.amount).toBe(4);
      expect(rail.settleCalls).toHaveLength(1);
      expect(history.events).toHaveLength(1);
    });

    it("returns rejected and does NOT settle when policy rejects", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { reject: "too_expensive" } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const result = await pay.stage(baseInput);

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") throw new Error("expected rejected");
      expect(result.reason).toBe("too_expensive");
      expect(result.rule_fired).toBe("rule[0]");
      expect(rail.settleCalls).toHaveLength(0);
      expect(history.events).toHaveLength(0);
    });

    it("returns approval_required and does NOT settle when policy needs approval", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { approval: "callback" } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const result = await pay.stage(baseInput);

      expect(result.outcome).toBe("approval_required");
      if (result.outcome !== "approval_required") throw new Error("expected approval_required");
      expect(result.staged.amount).toBe(4);
      expect(result.staged.currency).toBe("USDC");
      expect(result.staged.recipient_url).toBe(baseInput.url);
      expect(result.staged.intent).toBe(baseInput.intent);
      expect(result.staged.rule_fired).toBe("rule[0]");
      expect(result.staged.intent_id).toMatch(/^intent_/);
      // Crucially: nothing settled, nothing recorded - the money is held.
      expect(rail.settleCalls).toHaveLength(0);
      expect(history.events).toHaveLength(0);
    });

    it("returns rejected when max_amount is exceeded (before policy)", async () => {
      const rail = fakeRail(); // preflight amount is 4
      const history = new FakeHistory();
      const policy: Policy = { rules: [], default: { approve: true } };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const result = await pay.stage({ ...baseInput, max_amount: 1 });

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") throw new Error("expected rejected");
      expect(result.reason).toBe("max_amount_exceeded");
      expect(rail.settleCalls).toHaveLength(0);
    });
  });

  describe("complete()", () => {
    it("settles a held payment when the human approves", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { approval: "callback" } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const staged = await pay.stage(baseInput);
      if (staged.outcome !== "approval_required") throw new Error("expected approval_required");
      // Held: nothing settled yet.
      expect(rail.settleCalls).toHaveLength(0);

      const intent = await pay.complete(staged.staged, "approve");

      expect(intent.status).toBe("completed");
      expect(intent.receipt?.amount).toBe(4);
      expect(intent.data).toEqual({ fake: "api response" });
      // Settled exactly once, recorded exactly once.
      expect(rail.settleCalls).toHaveLength(1);
      expect(history.events).toHaveLength(1);
      expect(history.events[0]?.rule_fired).toBe("rule[0]");
      expect(history.events[0]?.intent_id).toBe(staged.staged.intent_id);
    });

    it("denies without settling when the human rejects", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { approval: "callback" } }],
        default: { approve: true },
      };
      const pay = blacktea({ source: rail, policy, history, audit: () => {} });

      const staged = await pay.stage(baseInput);
      if (staged.outcome !== "approval_required") throw new Error("expected approval_required");

      const intent = await pay.complete(staged.staged, "reject");

      expect(intent.status).toBe("denied");
      expect(intent.receipt).toBeUndefined();
      expect(intent.error).toBeInstanceOf(PolicyDeniedError);
      // No money moved, nothing recorded.
      expect(rail.settleCalls).toHaveLength(0);
      expect(history.events).toHaveLength(0);
    });

    it("preserves the staged intent_id through approve so the audit trail is coherent", async () => {
      const rail = fakeRail();
      const history = new FakeHistory();
      const policy: Policy = {
        rules: [{ if: { amount_gte: 1 }, then: { approval: "callback" } }],
        default: { approve: true },
      };
      const audit = collectingAudit();
      const pay = blacktea({ source: rail, policy, history, audit: audit.sink });

      const staged = await pay.stage(baseInput);
      if (staged.outcome !== "approval_required") throw new Error("expected approval_required");
      const intentId = staged.staged.intent_id;

      const intent = await pay.complete(staged.staged, "approve");
      expect(intent.id).toBe(intentId);

      const names = audit.events.map((e) => e.event);
      expect(names).toContain("approval_staged");
      expect(names).toContain("approval_received");
      expect(names).toContain("payment_completed");
      // Every event carries the same intent id end to end.
      expect(audit.events.every((e) => e.intent_id === intentId)).toBe(true);
    });
  });
});
