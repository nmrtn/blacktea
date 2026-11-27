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
  ApprovalTimeoutError,
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
  async append(r: ApprovalRecord) {
    if (this.failOn.includes(r.state)) throw new Error("disk full");
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
    audit: (e) => audit.push(e),
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
