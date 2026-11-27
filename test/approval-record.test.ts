/**
 * Approval receipts minted by the blacktea() factory.
 *
 * Every payment held for a human gets a receipt: a series of full
 * snapshots, one per state change, appended to the ApprovalStore and
 * mirrored to the audit sink. These tests drive the three approval paths
 * (callback, console, stage/complete) with an in-memory store.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { blacktea } from "../src/agent.js";
import type { ApprovalRecord, ApprovalState } from "../src/approval-record.js";
import {
  ApprovalInvalidError,
  ApprovalTimeoutError,
  NoEligibleRailError,
  QuoteChangedError,
  RailUnavailableError,
  ValidationError,
} from "../src/errors.js";
import type { Policy } from "../src/policy/schema.js";
import type {
  ApprovalRequest,
  ApprovalStore,
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

// The console channel asks through readline. Stub it to answer "y".
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => "y",
    close: () => {},
  }),
}));

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

/** A history store whose writes fail, to break the pipeline after the rail settled. */
class BrokenHistory extends FakeHistory {
  override async record(): Promise<void> {
    throw new Error("history disk full");
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
  behavior: {
    settle?: (input: PayInput, req: PaymentRequirement, opts: PayOptions) => Promise<SettleResult>;
  } = {},
): RailAdapter & { settleCalls: Array<{ input: PayInput; req: PaymentRequirement }> } {
  const settleCalls: Array<{ input: PayInput; req: PaymentRequirement }> = [];
  const defaultSettle = async (input: PayInput, req: PaymentRequirement): Promise<SettleResult> => {
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
  return {
    name,
    supports: () => true,
    preflight: async () => ({
      amount: 4,
      currency: "USDC",
      recipient_wallet: "0xabc123",
      network: "base-sepolia",
    }),
    settle: async (input, req, opts) => {
      settleCalls.push({ input, req });
      return behavior.settle ? behavior.settle(input, req, opts) : defaultSettle(input, req);
    },
    settleCalls,
  };
}

class MemoryApprovals implements ApprovalStore {
  records: ApprovalRecord[] = [];
  failOn: ApprovalState[] = [];
  /** What append() throws for a state in failOn. */
  failWith: unknown = new Error("disk full");
  async append(r: ApprovalRecord) {
    if (this.failOn.includes(r.state)) throw this.failWith;
    this.records.push(structuredClone(r));
  }
}
const states = (a: MemoryApprovals) => a.records.map((r) => r.state);
const ASK: Policy = { rules: [], default: { approval: "callback" } };
const ALLOW: Policy = {
  rules: [{ if: { amount_lt: 100 }, then: { approve: true } }],
  default: { reject: "no" },
};
const REJECT: Policy = { rules: [], default: { reject: "no" } };

const input: PayInput = { url: "https://api.example.com/v1/thing", intent: "buy a thing" };

function setup(
  opts: {
    policy?: Policy;
    rail?: ReturnType<typeof fakeRail>;
    onApprovalNeeded?: (req: ApprovalRequest) => Promise<{
      decision: "approve" | "deny";
      reason?: string;
    }>;
    dry_run?: boolean;
    history?: HistoryStore;
    /** Called before each audit event is collected; may throw. */
    auditHook?: (e: AuditEvent) => void;
  } = {},
) {
  const approvals = new MemoryApprovals();
  const audit: AuditEvent[] = [];
  const rail = opts.rail ?? fakeRail();
  const onApprovalNeeded = vi.fn(
    opts.onApprovalNeeded ?? (async () => ({ decision: "approve" as const })),
  );
  const pay = blacktea({
    source: rail,
    policy: opts.policy ?? ASK,
    history: opts.history ?? new FakeHistory(),
    audit: (e) => {
      opts.auditHook?.(e);
      audit.push(e);
    },
    approvals,
    onApprovalNeeded,
    dry_run: opts.dry_run,
  });
  return { pay, approvals, audit, rail, onApprovalNeeded };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("approval receipts: pay() with the callback channel", () => {
  it("approve writes staged, approved, settled with stable identity fields", async () => {
    const { pay, approvals } = setup();
    const intent = await pay(input);

    expect(intent.status).toBe("completed");
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
    const [first] = approvals.records;
    for (const r of approvals.records) {
      expect(r.intent_id).toBe(first?.intent_id);
      expect(r.created_at).toBe(first?.created_at);
      expect(r.params_hash).toBe(first?.params_hash);
      expect(r.channel).toBe("callback");
    }
    expect(first?.intent_id).toBe(intent.id);
    expect(first?.params_hash).toMatch(/^sha256:jcs-v1:[0-9a-f]{64}$/);
    expect(first?.amount).toBe(4);
    expect(first?.currency).toBe("USDC");
    expect(first?.recipient_wallet).toBe("0xabc123");
    expect(first?.recipient_url).toBe(input.url);
    expect(first?.rule_fired).toBe("default");
    expect(first?.actor).toBeNull();
    expect(first?.decision_reason).toBeNull();
  });

  it("deny writes staged, denied with the callback's reason and never settles", async () => {
    const { pay, approvals, rail } = setup({
      onApprovalNeeded: async () => ({ decision: "deny", reason: "too pricey" }),
    });
    await expect(pay(input)).rejects.toThrow();
    expect(states(approvals)).toEqual(["staged", "denied"]);
    expect(approvals.records.at(-1)?.decision_reason).toBe("too pricey");
    expect(rail.settleCalls).toHaveLength(0);
  });

  it("timeout writes staged, expired and throws ApprovalTimeoutError", async () => {
    const { pay, approvals } = setup({
      policy: {
        rules: [],
        default: { approval: { via: "callback", timeout_seconds: 0.01 } },
      },
      onApprovalNeeded: () => new Promise<never>(() => {}),
    });
    await expect(pay(input)).rejects.toThrow(ApprovalTimeoutError);
    expect(states(approvals)).toEqual(["staged", "expired"]);
  });

  it("a failing settle writes staged, approved, failed and throws RailUnavailableError", async () => {
    const rail = fakeRail("x402", {
      settle: async () => {
        throw new Error("signature rejected");
      },
    });
    const { pay, approvals } = setup({ rail });
    await expect(pay(input)).rejects.toThrow(RailUnavailableError);
    expect(states(approvals)).toEqual(["staged", "approved", "failed"]);
  });

  it("a QuoteChangedError from settle is rethrown unchanged and audited as quote_changed", async () => {
    const quoteErr = new QuoteChangedError("x402", "amount 4 -> 5");
    const rail = fakeRail("x402", {
      settle: async () => {
        throw quoteErr;
      },
    });
    const { pay, approvals, audit } = setup({ rail });
    const err = await pay(input).catch((e) => e);
    expect(err).toBe(quoteErr);
    expect(states(approvals)).toEqual(["staged", "approved", "failed"]);
    const failed = audit.find((e) => e.event === "payment_failed");
    expect(failed?.data.error).toBe("quote_changed");
  });

  it("a failure after the rail settled still ends in settled and the error propagates", async () => {
    const { pay, approvals, rail } = setup({ history: new BrokenHistory() });
    await expect(pay(input)).rejects.toThrow("history disk full");
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
    expect(rail.settleCalls).toHaveLength(1);
  });

  it("under dry_run a failure after the simulated settle also ends in settled", async () => {
    const { pay, approvals } = setup({ history: new BrokenHistory(), dry_run: true });
    await expect(pay(input)).rejects.toThrow("history disk full");
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
  });

  it("dry_run still writes staged, approved, settled", async () => {
    const { pay, approvals, rail } = setup({ dry_run: true });
    await pay(input);
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
    expect(rail.settleCalls).toHaveLength(0);
  });
});

describe("approval receipts: stage() / complete()", () => {
  it("complete(approve) writes staged, approved, settled on the staged channel", async () => {
    const { pay, approvals } = setup();
    const res = await pay.stage(input);
    if (res.outcome !== "approval_required") throw new Error("expected approval_required");
    expect(states(approvals)).toEqual(["staged"]);
    await pay.complete(res.staged, "approve");
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
    expect(approvals.records.every((r) => r.channel === "staged")).toBe(true);
    expect(approvals.records.every((r) => r.intent_id === res.staged.intent_id)).toBe(true);
  });

  it("complete(approve) ends in settled when a step after the rail settle throws", async () => {
    const { pay, approvals, rail } = setup({ history: new BrokenHistory() });
    const res = await pay.stage(input);
    if (res.outcome !== "approval_required") throw new Error("expected approval_required");
    await expect(pay.complete(res.staged, "approve")).rejects.toThrow("history disk full");
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
    expect(rail.settleCalls).toHaveLength(1);
  });

  it("complete(reject) writes staged, denied with a null reason", async () => {
    const { pay, approvals } = setup();
    const res = await pay.stage(input);
    if (res.outcome !== "approval_required") throw new Error("expected approval_required");
    await pay.complete(res.staged, "reject");
    expect(states(approvals)).toEqual(["staged", "denied"]);
    expect(approvals.records.at(-1)?.decision_reason).toBeNull();
  });

  it("a late complete(approve) writes expired and throws ApprovalTimeoutError", async () => {
    vi.useFakeTimers();
    const { pay, approvals, rail } = setup();
    const res = await pay.stage(input);
    if (res.outcome !== "approval_required") throw new Error("expected approval_required");
    vi.setSystemTime(Date.parse(res.staged.expires_at) + 1000);
    await expect(pay.complete(res.staged, "approve")).rejects.toThrow(ApprovalTimeoutError);
    expect(states(approvals)).toEqual(["staged", "expired"]);
    expect(rail.settleCalls).toHaveLength(0);
  });

  it("origin fills mcp_server and tool; without it both are null", async () => {
    const a = setup();
    const withOrigin = await a.pay.stage(input, { origin: { mcp_server: "m", tool: "pay" } });
    expect(withOrigin.outcome).toBe("approval_required");
    expect(a.approvals.records[0]?.mcp_server).toBe("m");
    expect(a.approvals.records[0]?.tool).toBe("pay");

    const b = setup();
    await b.pay.stage(input);
    expect(b.approvals.records[0]?.mcp_server).toBeNull();
    expect(b.approvals.records[0]?.tool).toBeNull();
  });
});

describe("approval receipts: scope", () => {
  it("auto-approved and policy-rejected payments write no receipt", async () => {
    const allowed = setup({ policy: ALLOW });
    await allowed.pay(input);
    await allowed.pay.stage(input);
    expect(allowed.approvals.records).toEqual([]);

    const rejected = setup({ policy: REJECT });
    await expect(rejected.pay(input)).rejects.toThrow();
    await rejected.pay.stage(input);
    expect(rejected.approvals.records).toEqual([]);
  });
});

describe("approval receipts: trigger and intent", () => {
  it("every record carries intent and trigger; trigger is null when not given", async () => {
    const a = setup();
    await a.pay({ ...input, intent: "why", trigger: "msg from Sam 15:02" });
    expect(a.approvals.records.length).toBeGreaterThan(0);
    for (const r of a.approvals.records) {
      expect(r.intent).toBe("why");
      expect(r.trigger).toBe("msg from Sam 15:02");
    }

    const b = setup();
    await b.pay(input);
    for (const r of b.approvals.records) expect(r.trigger).toBeNull();
  });

  it("the ApprovalRequest and the StagedIntent carry the trigger", async () => {
    const { pay, onApprovalNeeded } = setup();
    await pay({ ...input, trigger: "invoice email" });
    const req = onApprovalNeeded.mock.calls[0]?.[0];
    expect(req?.trigger).toBe("invoice email");

    const res = await pay.stage({ ...input, trigger: "invoice email" });
    if (res.outcome !== "approval_required") throw new Error("expected approval_required");
    expect(res.staged.trigger).toBe("invoice email");
  });

  it("intent_created audit data carries the trigger when present", async () => {
    const { pay, audit } = setup({ policy: ALLOW });
    await pay({ ...input, trigger: "cron job" });
    const created = audit.find((e) => e.event === "intent_created");
    expect(created?.data.trigger).toBe("cron job");
  });
});

describe("approval receipts: audit mirror and write failures", () => {
  it("every snapshot is mirrored to the audit sink as approval_record", async () => {
    const { pay, approvals, audit } = setup();
    await pay(input);
    const mirrored = audit.filter((e) => e.event === "approval_record").map((e) => e.data);
    expect(mirrored).toEqual(approvals.records);
  });

  it("fails closed when the staged snapshot cannot be written", async () => {
    const { pay, approvals, onApprovalNeeded, rail } = setup();
    approvals.failOn = ["staged"];
    await expect(pay(input)).rejects.toThrow("disk full");
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(rail.settleCalls).toHaveLength(0);
  });

  it("fails closed when the approved snapshot cannot be written", async () => {
    const { pay, approvals, rail } = setup();
    approvals.failOn = ["approved"];
    await expect(pay(input)).rejects.toThrow("disk full");
    expect(rail.settleCalls).toHaveLength(0);
  });

  it("fails closed on stage() when the staged snapshot cannot be written", async () => {
    const { pay, approvals } = setup();
    approvals.failOn = ["staged"];
    await expect(pay.stage(input)).rejects.toThrow("disk full");
  });

  it("fails open once the rail has settled", async () => {
    const { pay, approvals, audit } = setup();
    approvals.failOn = ["settled"];
    const intent = await pay(input);
    expect(intent.status).toBe("completed");
    const failed = audit.find((e) => e.event === "approval_record_write_failed");
    expect(failed?.data).toEqual({ state: "settled", error: "disk full" });
  });

  it("reports a non-Error thrown by the store as a string", async () => {
    const { pay, approvals, audit } = setup();
    approvals.failOn = ["settled"];
    approvals.failWith = "quota exceeded";
    const intent = await pay(input);
    expect(intent.status).toBe("completed");
    const failed = audit.find((e) => e.event === "approval_record_write_failed");
    expect(failed?.data).toEqual({ state: "settled", error: "quota exceeded" });
  });

  it("a throwing audit sink neither aborts the payment nor reads as a store failure", async () => {
    const { pay, approvals, audit, rail } = setup({
      auditHook: (e) => {
        if (e.event === "approval_record") throw new Error("sink down");
      },
    });
    const intent = await pay(input);
    expect(intent.status).toBe("completed");
    expect(rail.settleCalls).toHaveLength(1);
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
    expect(audit.some((e) => e.event === "approval_record_write_failed")).toBe(false);
  });

  it("never stores the request body or headers", async () => {
    const { pay, approvals, audit } = setup();
    await pay({ ...input, body: { secret: "s3cr3t" }, headers: { authorization: "tok" } });
    const dump = JSON.stringify([approvals.records, audit]);
    expect(dump).not.toContain("s3cr3t");
    expect(dump).not.toContain("tok");
  });

  it("rejects an unserializable body before asking the human", async () => {
    const { pay, onApprovalNeeded, approvals } = setup();
    const body: Record<string, unknown> = {};
    body.self = body;
    await expect(pay({ ...input, body })).rejects.toThrow(ValidationError);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(approvals.records).toEqual([]);
  });
});

describe("approval receipts: complete() is bound to the request and single-use", () => {
  function held(opts: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(opts);
    const stageHeld = async () => {
      // A copy: tests alter staged._input, which is the object passed in.
      const res = await ctx.pay.stage({ ...input });
      if (res.outcome !== "approval_required") throw new Error("expected approval_required");
      return { staged: res.staged };
    };
    return { ...ctx, stageHeld };
  }

  it("refuses when the staged amount was changed", async () => {
    const { pay, approvals, audit, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    const minted = approvals.records[0]?.params_hash;
    staged._requirement.amount = 9999;
    const err = await pay.complete(staged, "approve").catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalInvalidError);
    expect(err).toMatchObject({
      code: "approval_invalid",
      reason: "params_changed",
      intent_id: staged.intent_id,
    });
    expect(rail.settleCalls).toHaveLength(0);
    expect(states(approvals)).toEqual(["staged", "failed"]);
    const mismatch = audit.find((e) => e.event === "approval_mismatch");
    expect(mismatch?.intent_id).toBe(staged.intent_id);
    expect(mismatch?.data.expected).toBe(minted);
    expect(mismatch?.data.actual).toMatch(/^sha256:jcs-v1:[0-9a-f]{64}$/);
    expect(mismatch?.data.actual).not.toBe(minted);
  });

  it("refuses when the staged url was changed", async () => {
    const { pay, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    staged._input.url = "https://evil.test/";
    await expect(pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "params_changed",
    });
    expect(rail.settleCalls).toHaveLength(0);
  });

  it("a mismatch consumes the approval", async () => {
    const { pay, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    const original = staged._requirement.amount;
    staged._requirement.amount = 9999;
    await expect(pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "params_changed",
    });
    staged._requirement.amount = original;
    await expect(pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    expect(rail.settleCalls).toHaveLength(0);
  });

  it("refuses a second sequential approve", async () => {
    const { pay, approvals, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    await pay.complete(staged, "approve");
    await expect(pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    expect(rail.settleCalls).toHaveLength(1);
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
  });

  it("refuses approve after reject", async () => {
    const { pay, approvals, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    await pay.complete(staged, "reject");
    await expect(pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    expect(rail.settleCalls).toHaveLength(0);
    expect(states(approvals)).toEqual(["staged", "denied"]);
  });

  it("refuses approve after an expired approve", async () => {
    vi.useFakeTimers();
    const { pay, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    vi.setSystemTime(Date.parse(staged.expires_at) + 1000);
    await expect(pay.complete(staged, "approve")).rejects.toThrow(ApprovalTimeoutError);
    await expect(pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    expect(rail.settleCalls).toHaveLength(0);
  });

  it("checks expiry against the minted window, not the caller-held expires_at", async () => {
    vi.useFakeTimers();
    const { pay, approvals, audit, rail, stageHeld } = held({
      policy: { rules: [], default: { approval: { via: "callback", timeout_seconds: 1 } } },
    });
    const { staged } = await stageHeld();
    const minted = staged.expires_at;
    staged.expires_at = "2999-01-01T00:00:00.000Z";
    vi.setSystemTime(Date.parse(minted) + 1000);
    await expect(pay.complete(staged, "approve")).rejects.toThrow(ApprovalTimeoutError);
    expect(states(approvals)).toEqual(["staged", "expired"]);
    expect(rail.settleCalls).toHaveLength(0);
    const timedOut = audit.find((e) => e.event === "approval_timed_out");
    expect(timedOut?.data.expires_at).toBe(minted);
  });

  it("refuses an altered request that can no longer be hashed", async () => {
    const { pay, approvals, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    const body: Record<string, unknown> = {};
    body.self = body;
    staged._input.body = body;
    const err = await pay.complete(staged, "approve").catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalInvalidError);
    expect(err).toMatchObject({ reason: "params_changed" });
    expect(rail.settleCalls).toHaveLength(0);
    expect(states(approvals).at(-1)).toBe("failed");
    expect(states(approvals)).toEqual(["staged", "failed"]);
  });

  it("settles what was staged even if the staged intent is altered after complete() is called", async () => {
    const { pay, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    const pending = pay.complete(staged, "approve");
    staged._input.url = "https://evil.test/";
    staged._requirement.amount = 9999;
    staged._requirement.recipient_wallet = "0xattacker";
    const intent = await pending;
    expect(intent.status).toBe("completed");
    expect(rail.settleCalls).toHaveLength(1);
    expect(rail.settleCalls[0]?.input.url).toBe(input.url);
    expect(rail.settleCalls[0]?.req.amount).toBe(4);
    expect(rail.settleCalls[0]?.req.recipient_wallet).toBe("0xabc123");
  });

  it("settles the staged raw quote, which the hash does not cover", async () => {
    const rail = fakeRail();
    rail.preflight = async () => ({
      amount: 4,
      currency: "USDC",
      recipient_wallet: "0xabc123",
      network: "base-sepolia",
      raw: { maxAmountRequired: "4000000", network: "base-sepolia", asset: "0xA" },
    });
    const { pay, stageHeld } = held({ rail });
    const { staged } = await stageHeld();
    (staged._requirement.raw as { maxAmountRequired: string }).maxAmountRequired = "999999999";
    await pay.complete(staged, "approve");
    expect(rail.settleCalls).toHaveLength(1);
    const raw = rail.settleCalls[0]?.req.raw as { maxAmountRequired: string };
    expect(raw.maxAmountRequired).toBe("4000000");
  });

  it("settles on the staged rail even if staged._railName is changed", async () => {
    const first = fakeRail("x402");
    const second = fakeRail("other");
    const approvals = new MemoryApprovals();
    const pay = blacktea({
      source: [first, second],
      policy: ASK,
      history: new FakeHistory(),
      audit: () => {},
      approvals,
    });
    const res = await pay.stage({ ...input });
    if (res.outcome !== "approval_required") throw new Error("expected approval_required");
    res.staged._railName = "other";
    await pay.complete(res.staged, "approve");
    expect(first.settleCalls).toHaveLength(1);
    expect(second.settleCalls).toHaveLength(0);
  });

  it("stage() prunes held payments more than an hour past expiry", async () => {
    vi.useFakeTimers();
    const { pay, approvals, rail, stageHeld } = held({
      policy: { rules: [], default: { approval: { via: "callback", timeout_seconds: 1 } } },
    });

    // Within the hour after expiry: still known, so a late approve expires.
    const a = await stageHeld();
    vi.setSystemTime(Date.parse(a.staged.expires_at) + 30 * 60 * 1000);
    await stageHeld();
    await expect(pay.complete(a.staged, "approve")).rejects.toThrow(ApprovalTimeoutError);
    expect(
      approvals.records.filter((r) => r.intent_id === a.staged.intent_id).map((r) => r.state),
    ).toEqual(["staged", "expired"]);

    // More than an hour after expiry: pruned on the next stage(), no snapshot.
    const c = await stageHeld();
    vi.setSystemTime(Date.parse(c.staged.expires_at) + 60 * 60 * 1000 + 1000);
    await stageHeld();
    await expect(pay.complete(c.staged, "approve")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    expect(
      approvals.records.filter((r) => r.intent_id === c.staged.intent_id).map((r) => r.state),
    ).toEqual(["staged"]);
    expect(rail.settleCalls).toHaveLength(0);
  });

  it("refuses a staged intent issued by another factory", async () => {
    const { stageHeld } = held();
    const other = setup();
    const { staged } = await stageHeld();
    await expect(other.pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    await expect(other.pay.complete(staged, "reject")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    expect(other.rail.settleCalls).toHaveLength(0);
    expect(other.approvals.records).toEqual([]);
  });

  it("concurrent duplicate approves still share one settlement", async () => {
    const { pay, approvals, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    const [a, b] = await Promise.all([
      pay.complete(staged, "approve"),
      pay.complete(staged, "approve"),
    ]);
    expect(a.receipt).toEqual(b.receipt);
    expect(rail.settleCalls).toHaveLength(1);
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
  });

  it("a reject racing an in-flight approve is refused", async () => {
    const { pay, approvals, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    const approving = pay.complete(staged, "approve");
    await expect(pay.complete(staged, "reject")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    const intent = await approving;
    expect(intent.status).toBe("completed");
    expect(rail.settleCalls).toHaveLength(1);
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
  });

  it("a failed settle consumes the approval", async () => {
    let calls = 0;
    const rail = fakeRail("x402", {
      settle: async () => {
        calls += 1;
        throw new Error("signature rejected");
      },
    });
    const { pay, approvals, stageHeld } = held({ rail });
    const { staged } = await stageHeld();
    await expect(pay.complete(staged, "approve")).rejects.toBeInstanceOf(RailUnavailableError);
    await expect(pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    expect(calls).toBe(1);
    expect(states(approvals)).toEqual(["staged", "approved", "failed"]);
  });

  it("a missing rail writes failed and consumes the approval", async () => {
    const { pay, approvals, rail, stageHeld } = held();
    const { staged } = await stageHeld();
    // The staged rail name is held privately, so only renaming the rail
    // itself can make it disappear.
    rail.name = "gone";
    await expect(pay.complete(staged, "approve")).rejects.toBeInstanceOf(NoEligibleRailError);
    expect(states(approvals)).toEqual(["staged", "failed"]);
    await expect(pay.complete(staged, "approve")).rejects.toMatchObject({
      reason: "unknown_or_consumed",
    });
    expect(rail.settleCalls).toHaveLength(0);
  });
});

describe("approval receipts: console channel", () => {
  it("shows a trigger line and strips control characters from intent and trigger", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    const { pay, approvals } = setup({ policy: { rules: [], default: { approval: "console" } } });

    await pay({ ...input, intent: "a\nApprove? [y/N] y", trigger: "t\x1b[2K" });

    const prompt = logged.find((l) => l.includes("Approval required"));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("trigger:");
    expect(prompt).not.toContain("\x1b");
    const reasonLine = prompt?.split("\n").find((l) => l.includes("reason:"));
    const triggerLine = prompt?.split("\n").find((l) => l.includes("trigger:"));
    expect(reasonLine).toContain("a Approve? [y/N] y");
    expect(triggerLine).toContain("t [2K");
    expect(prompt?.split("\n").filter((l) => l.includes("Approve?"))).toHaveLength(1);
    expect(states(approvals)).toEqual(["staged", "approved", "settled"]);
    expect(approvals.records[0]?.channel).toBe("console");
  });
});
